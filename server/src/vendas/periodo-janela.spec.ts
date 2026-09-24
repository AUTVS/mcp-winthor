import {
  diaDoPedido,
  diaNoErp,
  diasEntre,
  janelaDoPeriodo,
  janelaFria,
  janelaHistorico,
  janelaQuente,
  mesDe,
  primeiroDoMes,
  somarDias,
  ultimoDoMes,
} from './periodo-janela';

/** Meio-dia em São Paulo — longe de qualquer borda de fuso. */
const meioDia = (dia: string) => new Date(`${dia}T15:00:00.000Z`);

describe('diaNoErp', () => {
  it('resolve o dia no fuso do ERP, não no do processo', () => {
    // 02:00Z de 1º de agosto ainda é 31 de julho em UTC-3. Este é o caso que
    // separa "resolver no fuso do ERP" de "usar o relógio do processo": num
    // contêiner em UTC, a segunda opção erraria a janela por um dia inteiro.
    expect(diaNoErp(new Date('2026-08-01T02:00:00.000Z'))).toBe('2026-07-31');
    expect(diaNoErp(new Date('2026-08-01T04:00:00.000Z'))).toBe('2026-08-01');
  });

  it('não depende de process.env.TZ', () => {
    // `Intl` com timeZone explícito ignora o TZ do processo — a garantia que
    // permite o mesmo binário rodar no desktop do usuário e num contêiner UTC.
    const instante = new Date('2026-08-01T02:00:00.000Z');
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const emUtc = diaNoErp(instante);
      process.env.TZ = 'Asia/Tokyo';
      expect(diaNoErp(instante)).toBe(emUtc);
      expect(emUtc).toBe('2026-07-31');
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('diaDoPedido', () => {
  it('deriva o dia do exemplo literal do contrato (§4.4)', () => {
    // 1784257200000 = 2026-07-17T03:00:00Z = meia-noite de 17/07 em UTC-3.
    // A mesma linha do contrato traz HORA: 17, MINUTO: 10 — prova de que
    // DATA_PEDIDO é data, e não o instante do pedido.
    expect(diaDoPedido(1784257200000)).toEqual({
      dia: '2026-07-17',
      confiavel: true,
    });
  });

  it('aceita o ISO que normalizeValores já produziu', () => {
    // O serviço converte epoch → ISO antes de a linha chegar aqui; as duas
    // formas têm de dar o mesmo dia, senão a base diverge conforme o caminho.
    expect(diaDoPedido('2026-07-17T03:00:00.000Z')?.dia).toBe('2026-07-17');
  });

  it('marca como não confiável quando a hipótese de meia-noite local quebra', () => {
    // Meia-noite em UTC-2..UTC-5 cai entre 02:00Z e 05:00Z. 15:00Z não é
    // meia-noite em fuso ocidental nenhum: ou DATA_PEDIDO virou instante, ou o
    // ERP não está no hemisfério ocidental. Nos dois casos, a derivação do dia
    // precisa ser reprovada antes de virar cobertura.
    expect(diaDoPedido('2026-07-17T15:00:00.000Z')?.confiavel).toBe(false);
  });

  it('devolve null para valor que não é data', () => {
    expect(diaDoPedido(null)).toBeNull();
    expect(diaDoPedido(undefined)).toBeNull();
    expect(diaDoPedido('sem data')).toBeNull();
  });
});

describe('janelaDoPeriodo', () => {
  const agora = meioDia('2026-07-05');

  it.each([
    ['1', '2026-07-05', '2026-07-05'], // Hoje
    ['2', '2026-07-04', '2026-07-04'], // Ontem
    ['3', '2026-07-01', '2026-07-05'], // Mês atual
    ['4', '2026-06-01', '2026-06-30'], // Mês anterior
    ['7', '2026-01-01', '2026-07-05'], // Ano atual
    ['8', '2025-01-01', '2025-12-31'], // Ano anterior
  ] as const)('periodo %s cobre %s..%s', (periodo, inicio, fim) => {
    expect(janelaDoPeriodo(periodo, agora)).toEqual({
      dataInicio: inicio,
      dataFim: fim,
    });
  });

  it('termina as janelas em curso em hoje, não no fim do mês ou do ano', () => {
    // Cobertura é afirmação sobre dia que já existe. Terminar "mês atual" em
    // 31/07 faria a base alegar cobrir dias que ainda não aconteceram.
    expect(janelaDoPeriodo('3', agora).dataFim).toBe('2026-07-05');
    expect(janelaDoPeriodo('7', agora).dataFim).toBe('2026-07-05');
  });

  it('atravessa a virada do ano', () => {
    const janeiro = meioDia('2026-01-15');
    expect(janelaDoPeriodo('4', janeiro)).toEqual({
      dataInicio: '2025-12-01',
      dataFim: '2025-12-31',
    });
    expect(janelaDoPeriodo('8', janeiro)).toEqual({
      dataInicio: '2025-01-01',
      dataFim: '2025-12-31',
    });
  });

  it('resolve a janela pelo dia do ERP quando o processo já virou o dia', () => {
    // 01/08 02:00Z = 31/07 no ERP: "mês atual" ainda é julho.
    expect(janelaDoPeriodo('3', new Date('2026-08-01T02:00:00.000Z'))).toEqual({
      dataInicio: '2026-07-01',
      dataFim: '2026-07-31',
    });
  });
});

describe('janelaQuente', () => {
  it('vai do primeiro dia do mês anterior até hoje', () => {
    // A fronteira sai da capacidade real da API — [mês anterior .. hoje] é
    // exatamente o que os períodos '4' e '3' ainda reconstroem — e não de uma
    // constante escolhida a dedo.
    expect(janelaQuente(meioDia('2026-07-05'))).toEqual({
      dataInicio: '2026-06-01',
      dataFim: '2026-07-05',
    });
  });

  it('no primeiro dia do mês ainda alcança o mês inteiro anterior', () => {
    expect(janelaQuente(meioDia('2026-07-01')).dataInicio).toBe('2026-06-01');
  });

  it('no último dia do mês já não alcança o retrasado', () => {
    // 30/06 alcança maio; 01/07 passa a alcançar junho. É neste instante que
    // maio congela — e é por isso que a atualização precisa rodar diariamente.
    expect(janelaQuente(meioDia('2026-06-30')).dataInicio).toBe('2026-05-01');
  });

  it('atravessa a virada do ano', () => {
    expect(janelaQuente(meioDia('2026-01-10')).dataInicio).toBe('2025-12-01');
  });
});

describe('janelaHistorico e janelaFria', () => {
  const agora = meioDia('2026-07-05');

  it('o horizonte vai do 1º de janeiro do ano anterior até hoje', () => {
    expect(janelaHistorico(agora)).toEqual({
      dataInicio: '2025-01-01',
      dataFim: '2026-07-05',
    });
  });

  it('a fria é o complemento exato da quente dentro do horizonte', () => {
    expect(janelaFria(agora)).toEqual({
      dataInicio: '2025-01-01',
      dataFim: '2026-05-31',
    });
  });

  it('as duas zonas são contíguas e não se sobrepõem', () => {
    // Esta é a propriedade que justifica trocar os quatro cards de período por
    // duas zonas: '3' ⊂ '7' e '4' ⊂ '7' faziam os mesmos dias serem contados
    // duas vezes. Sem furo nem sobreposição, os dois `diasCobertos` somam.
    expect(somarDias(janelaFria(agora).dataFim, 1)).toBe(
      janelaQuente(agora).dataInicio,
    );
  });

  it('a soma das duas zonas é o horizonte inteiro', () => {
    const dias = (j: { dataInicio: string; dataFim: string }) =>
      diasEntre(j.dataInicio, j.dataFim).length;

    expect(dias(janelaFria(agora)) + dias(janelaQuente(agora))).toBe(
      dias(janelaHistorico(agora)),
    );
  });

  it('nunca fica vazia, nem em janeiro', () => {
    // Em janeiro a quente começa em 1º de dezembro do ano anterior, então a fria
    // ainda tem onze meses. É o mês em que um recorte ingênuo produziria janela
    // invertida e uma zona "completa" por vacuidade.
    const janeiro = meioDia('2026-01-03');
    expect(janelaQuente(janeiro).dataInicio).toBe('2025-12-01');
    expect(janelaFria(janeiro)).toEqual({
      dataInicio: '2025-01-01',
      dataFim: '2025-11-30',
    });

    const fevereiro = meioDia('2026-02-03');
    expect(janelaFria(fevereiro).dataFim).toBe('2025-12-31');
  });

  it('cobre exatamente o horizonte de retenção (RETENCAO_ANOS = 2)', () => {
    // O corte do expurgo é `${ano-1}-01-01`. Se as duas coisas divergissem, a
    // zona fria alegaria cobertura de dia que o expurgo já apagou.
    expect(janelaHistorico(agora).dataInicio).toBe('2025-01-01');
    expect(janelaFria(agora).dataInicio).toBe('2025-01-01');
  });

  it('resolve pelo dia do ERP quando o processo já virou o ano', () => {
    // 01/01/2027 02:00Z ainda é 31/12/2026 em UTC-3: o horizonte tem de começar
    // em 2025, não em 2026.
    expect(janelaHistorico(new Date('2027-01-01T02:00:00.000Z'))).toEqual({
      dataInicio: '2025-01-01',
      dataFim: '2026-12-31',
    });
  });
});

describe('aritmética de dias', () => {
  it('soma e subtrai atravessando mês e ano', () => {
    expect(somarDias('2026-07-31', 1)).toBe('2026-08-01');
    expect(somarDias('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('conhece ano bissexto', () => {
    expect(ultimoDoMes('2024-02-10')).toBe('2024-02-29');
    expect(ultimoDoMes('2026-02-10')).toBe('2026-02-28');
    expect(somarDias('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('primeiroDoMes e mesDe', () => {
    expect(primeiroDoMes('2026-07-17')).toBe('2026-07-01');
    expect(mesDe('2026-07-17')).toBe('2026-07');
  });

  it('diasEntre é inclusivo nas duas pontas', () => {
    expect(diasEntre('2026-07-01', '2026-07-03')).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
    expect(diasEntre('2026-07-01', '2026-07-01')).toEqual(['2026-07-01']);
    expect(diasEntre('2026-07-02', '2026-07-01')).toEqual([]);
  });

  it('diasEntre cobre um ano inteiro sem furo', () => {
    // A série alimenta o teste de cobertura, que compara contagem esperada vs.
    // gravada: um furo aqui viraria "janela coberta" com dia faltando.
    const dias = diasEntre('2026-01-01', '2026-12-31');
    expect(dias).toHaveLength(365);
    expect(new Set(dias).size).toBe(365);
    expect(dias[dias.length - 1]).toBe('2026-12-31');
  });
});
