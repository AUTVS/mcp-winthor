import { PeriodoCodigo } from '../winthor/winthor-mobile.types';

/**
 * Conversão entre o enum de período do WinThor e janelas de dias.
 *
 * A rotina W106 só aceita `periodo` de um enum fechado — não existe filtro de data
 * (§1.5 do contrato). Mas **cada linha carrega `DATA_PEDIDO`**, e é exatamente por
 * isso que gravar localmente destrava recorte por data arbitrária: a granularidade
 * existe no dado, só não existe no filtro.
 *
 * Módulo puro, sem I/O e sem estado — todas as hipóteses de risco do projeto moram
 * aqui, então precisam ser testáveis sem rede e sem banco.
 */

/** Dia no formato `YYYY-MM-DD`. É a unidade de cobertura da base local. */
export type Dia = string;

export interface Janela {
  dataInicio: Dia;
  dataFim: Dia;
}

/**
 * Fuso em que o ERP decide o que é "hoje".
 *
 * O servidor pode rodar em UTC (contêiner) enquanto o ERP está em UTC-3: às
 * 02:00Z de 1º de agosto ainda é 31 de julho no WinThor, e resolver "mês atual"
 * pelo relógio do processo devolveria a janela errada por um dia inteiro.
 *
 * Nome de zona IANA em vez de deslocamento fixo de propósito: o Brasil teve
 * horário de verão até 2019, e pedido de 2018 no histórico tem deslocamento -2.
 * O ICU resolve isso; `-3` cravado não resolveria.
 */
const FUSO_ERP = process.env.WTA_FUSO_ERP ?? 'America/Sao_Paulo';

/** `en-CA` porque o formato curto dessa locale é exatamente `YYYY-MM-DD`. */
const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_ERP,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Dia civil de um instante, no fuso do ERP. */
export function diaNoErp(instante: Date = new Date()): Dia {
  return formatador.format(instante);
}

/**
 * Aritmética de dias sobre a string, ancorada em UTC.
 *
 * Trabalhar em UTC aqui é seguro **porque a entrada já é um dia civil resolvido no
 * fuso do ERP**: somar 1 dia a `'2026-07-17'` é aritmética de calendário, não de
 * instante, e o UTC não tem horário de verão para atrapalhar.
 */
function paraUtc(dia: Dia): Date {
  const [ano, mes, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, d));
}

function paraDia(data: Date): Dia {
  return data.toISOString().slice(0, 10);
}

export function somarDias(dia: Dia, quantidade: number): Dia {
  const data = paraUtc(dia);
  data.setUTCDate(data.getUTCDate() + quantidade);
  return paraDia(data);
}

/** Primeiro dia do mês de `dia`. */
export function primeiroDoMes(dia: Dia): Dia {
  return `${dia.slice(0, 7)}-01`;
}

/** Último dia do mês de `dia`. Dia 0 do mês seguinte é o último do atual. */
export function ultimoDoMes(dia: Dia): Dia {
  const data = paraUtc(dia);
  return paraDia(
    new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth() + 1, 0)),
  );
}

/** Mês de um dia, como `YYYY-MM`. */
export function mesDe(dia: Dia): string {
  return dia.slice(0, 7);
}

/**
 * Janela de dias coberta por um código de período.
 *
 * As janelas terminam em **hoje**, nunca no fim do mês ou do ano: a base local só
 * pode alegar cobertura de dia que já existe. Para o WinThor dá no mesmo (não há
 * pedido no futuro), mas para a tabela de cobertura a diferença é entre afirmar o
 * que se sabe e afirmar o que se espera.
 */
export function janelaDoPeriodo(
  periodo: PeriodoCodigo,
  agora: Date = new Date(),
): Janela {
  const hoje = diaNoErp(agora);

  switch (periodo) {
    case '1': // Hoje
      return { dataInicio: hoje, dataFim: hoje };
    case '2': {
      // Ontem — janela de UM dia só, o que a torna a sonda natural da hipótese
      // de derivação do dia (ver `diaDoPedido`).
      const ontem = somarDias(hoje, -1);
      return { dataInicio: ontem, dataFim: ontem };
    }
    case '3': // Mês atual
      return { dataInicio: primeiroDoMes(hoje), dataFim: hoje };
    case '4': {
      // Mês anterior
      const ultimoDoMesAnterior = somarDias(primeiroDoMes(hoje), -1);
      return {
        dataInicio: primeiroDoMes(ultimoDoMesAnterior),
        dataFim: ultimoDoMesAnterior,
      };
    }
    case '7': // Ano atual
      return { dataInicio: `${hoje.slice(0, 4)}-01-01`, dataFim: hoje };
    case '8': {
      // Ano anterior
      const ano = Number(hoje.slice(0, 4)) - 1;
      return { dataInicio: `${ano}-01-01`, dataFim: `${ano}-12-31` };
    }
  }
}

/**
 * Janela que o enum ainda reconstrói de forma exata: `[1º do mês anterior .. hoje]`.
 *
 * É a fronteira entre quente e frio, e sai da capacidade real da API em vez de uma
 * constante inventada. Um mês M é reconstruível por `periodo: '4'` durante todo o
 * mês M+1; como a atualização roda diariamente, M é regravado na última noite de
 * M+1. Logo um dia congela com dado no máximo 24 h mais velho que o último instante
 * em que o ERP ainda o entregava.
 */
export function janelaQuente(agora: Date = new Date()): Janela {
  const hoje = diaNoErp(agora);
  return {
    dataInicio: primeiroDoMes(somarDias(primeiroDoMes(hoje), -1)),
    dataFim: hoje,
  };
}

/**
 * Horizonte inteiro que o enum alcança: ano anterior + ano atual (`'8'` ∪ `'7'`).
 *
 * Coincide com o corte do expurgo (`RETENCAO_ANOS = 2`) por construção, e não por
 * coincidência: o que a base guarda é exatamente o que o enum sabe reconstruir.
 */
export function janelaHistorico(agora: Date = new Date()): Janela {
  const hoje = diaNoErp(agora);
  return {
    dataInicio: `${Number(hoje.slice(0, 4)) - 1}-01-01`,
    dataFim: hoje,
  };
}

/**
 * Complemento da janela quente dentro do horizonte: o que só o sync histórico preenche.
 *
 * Existe para as zonas do painel não se sobreporem. `'3'` ⊂ `'7'` e `'4'` ⊂ `'7'`:
 * apresentar os quatro períodos lado a lado conta os mesmos dias duas vezes e faz
 * "Ano atual" parecer doente justamente enquanto a atualização diária o mantém
 * saudável. Recortar pela MESMA fronteira que `publicarCobertura` usa para decidir
 * `'quente'`/`'frio'` faz o card e a linha do banco falarem a mesma língua.
 *
 * Nunca fica vazia: em janeiro a quente começa em 1º de dezembro do ano anterior, então
 * a fria ainda termina em 30 de novembro.
 */
export function janelaFria(agora: Date = new Date()): Janela {
  return {
    dataInicio: janelaHistorico(agora).dataInicio,
    dataFim: somarDias(janelaQuente(agora).dataInicio, -1),
  };
}

export function dentroDaJanela(dia: Dia, janela: Janela): boolean {
  return dia >= janela.dataInicio && dia <= janela.dataFim;
}

/**
 * Série de dias de uma janela, inclusive nas duas pontas.
 *
 * Em TS e não em SQL porque o SQLite embutido do node **não tem `generate_series`**
 * (verificado). Um ano são 365 strings — irrelevante perto de qualquer chamada HTTP.
 */
export function diasEntre(inicio: Dia, fim: Dia): Dia[] {
  const dias: Dia[] = [];
  for (let dia = inicio; dia <= fim; dia = somarDias(dia, 1)) {
    dias.push(dia);
  }
  return dias;
}

export interface DiaDerivado {
  dia: Dia;
  /**
   * `false` quando a hipótese de meia-noite local não se sustenta para este valor.
   * Uma única linha não confiável não condena a base; a sonda de `periodo: '2'` é
   * que decide (ver `verificarDerivacaoDeDia` na ingestão).
   */
  confiavel: boolean;
}

/**
 * Dia civil de um `DATA_PEDIDO`.
 *
 * `DATA_PEDIDO` é **data, não instante**: o exemplo do contrato (§4.4) traz
 * `1784257200000` = `2026-07-17T03:00:00Z`, que é meia-noite de 17/07 em UTC-3 — e a
 * MESMA linha traz `HORA: 17, MINUTO: 10` em campos separados. A hora do pedido viaja
 * fora do carimbo.
 *
 * A hipótese é falsificável e por isso é conferida: meia-noite em qualquer fuso do
 * hemisfério ocidental (UTC-2 a UTC-5) cai entre 02:00Z e 05:00Z. Hora UTC ≥ 12:00
 * significa que `DATA_PEDIDO` não é meia-noite local neste ERP, e aí converter pelo
 * fuso é o que salva o resultado de ficar deslocado em um dia.
 */
export function diaDoPedido(valor: unknown): DiaDerivado | null {
  const instante =
    typeof valor === 'number'
      ? new Date(valor)
      : typeof valor === 'string'
        ? new Date(valor)
        : null;

  if (instante === null || Number.isNaN(instante.getTime())) return null;

  return {
    dia: diaNoErp(instante),
    confiavel: instante.getUTCHours() < 12,
  };
}
