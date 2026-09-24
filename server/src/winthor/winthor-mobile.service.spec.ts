import { WinthorMobileService } from './winthor-mobile.service';
import { WinthorApiService } from './winthor-api.service';
import { WtConfigService } from '../config/wt-config.service';
import { ENDPOINTS } from './winthor-mobile.types';
import { MOBILE_TOOL_NAMES } from '../mcp/tools/mobile-tools';

/** Config fixa: não toca no disco nem no config.json real. */
const configStub = {
  getConfig: () => ({
    winthorBaseUrl: 'http://winthor.local:8181',
    login: 'DEMO',
    senhaMd5: 'X',
    configuredAt: '2026-01-01T00:00:00.000Z',
  }),
} as unknown as WtConfigService;

function makeService(postJson: jest.Mock) {
  const api = { postJson } as unknown as WinthorApiService;
  return new WinthorMobileService(configStub, api);
}

/** Envelope que o serviço envia — tipado para o teste não navegar sobre `any`. */
interface EnvelopeEnviado {
  data?: { list?: unknown[] };
  parameters?: { parameters?: Record<string, unknown> };
  paginator?: { nextPage: string; countDataPage: string; paginator: boolean };
}

const caminho = (postJson: jest.Mock, i = 0): string =>
  (postJson.mock.calls[i] as unknown[])[0] as string;

const corpo = (postJson: jest.Mock, i = 0): EnvelopeEnviado =>
  (postJson.mock.calls[i] as unknown[])[1] as EnvelopeEnviado;

const filtros = (postJson: jest.Mock, i = 0): Record<string, unknown> =>
  corpo(postJson, i).parameters?.parameters ?? {};

/** Resposta GRID_MODEL como o WinThor devolve, com o embrulho duplicado. */
function gridResponse(
  registros: Record<string, unknown>[],
  count?: number,
  totalizer?: Record<string, number>,
) {
  return {
    ok: true,
    status: 200,
    data: {
      data: {
        list: registros.map((r) => ({
          data: r,
          dataModel: r,
          keySet: Object.keys(r),
          empty: false,
          type: 'DATA_MODEL',
        })),
      },
      paginator: { nextPage: '1', countDataPage: '10', paginator: true, count },
      totalizer,
    },
  };
}

describe('WinthorMobileService', () => {
  it('monta o envelope GRID_MODEL com dupla aninhação e paginação em string', async () => {
    const postJson = jest.fn().mockResolvedValue(gridResponse([]));
    const service = makeService(postJson);

    await service.listarInadimplencia(
      ENDPOINTS.inadimplenciaPorFilial,
      [{ columnName: 'CODIGO', totalized: false, order: null }],
      { listaFilial: ['1'], periodo: '4', page: 2, pageSize: 25 },
    );

    expect(caminho(postJson)).toBe(
      '/winthor/mobile/v2/resumoInadimplencia/listarResumoInadimplenciaPorFilial',
    );
    // O filtro precisa estar em parameters.parameters — um nível acima dá HTTP 500.
    expect(filtros(postJson)).toMatchObject({
      listaFilial: ['1'],
      periodo: '4',
      descricaoPeriodo: 'Mês anterior',
      listaCliente: null,
    });
    expect(corpo(postJson).paginator).toEqual({
      nextPage: '2',
      countDataPage: '25',
      paginator: true,
    });
    expect(corpo(postJson).data?.list).toHaveLength(1);
  });

  it('usa Mês atual quando o período não é informado', async () => {
    const postJson = jest.fn().mockResolvedValue(gridResponse([]));
    const service = makeService(postJson);

    await service.listarInadimplencia(ENDPOINTS.inadimplenciaPorCliente, [], {
      listaFilial: ['1'],
    });

    expect(filtros(postJson)).toMatchObject({
      periodo: '3',
      descricaoPeriodo: 'Mês atual',
    });
  });

  it('achata data.list[].data e usa paginator.count como total', async () => {
    const postJson = jest
      .fn()
      .mockResolvedValue(
        gridResponse([{ CODIGO: '1', VALOR: 10 }], 324, { VALOR: 600793.14 }),
      );
    const service = makeService(postJson);

    const result = await service.listarInadimplencia(
      ENDPOINTS.inadimplenciaPorFilial,
      [],
      { listaFilial: ['1'], pageSize: 10 },
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      items: [{ CODIGO: '1', VALOR: 10 }],
      count: 1,
      page: 1,
      pageSize: 10,
      total: 324,
      totalPages: 33,
      totalizer: { VALOR: 600793.14 },
    });
    // Sem os embrulhos do contrato original.
    expect(result.data?.items[0]).not.toHaveProperty('dataModel');
    expect(result.data?.items[0]).not.toHaveProperty('keySet');
  });

  it('converte datas epoch-ms para ISO sem tocar em números de negócio', async () => {
    const postJson = jest.fn().mockResolvedValue(
      gridResponse([
        {
          DATA_PEDIDO: 1784257200000,
          NUMERO_PEDIDO: 57003983,
          VALOR_PEDIDO: 595,
        },
      ]),
    );
    const service = makeService(postJson);

    const result = await service.listarLucratividade(
      ENDPOINTS.pedidosDeVenda,
      [],
      {
        listaFilial: ['1'],
        perspectiva: '1',
      },
    );

    const item = result.data?.items[0];
    expect(item?.DATA_PEDIDO).toBe(new Date(1784257200000).toISOString());
    expect(item?.NUMERO_PEDIDO).toBe(57003983);
    expect(item?.VALOR_PEDIDO).toBe(595);
  });

  it('envia matricula como string em pesquisarFilial', async () => {
    const postJson = jest.fn().mockResolvedValue(gridResponse([]));
    const service = makeService(postJson);

    await service.pesquisarFilial('150');

    // Envelope reduzido: só `data`, sem parameters/paginator.
    expect(corpo(postJson)).toEqual({ data: { matricula: '150' } });
  });

  it('pesquisarFilial sem paginação devolve a lista inteira', async () => {
    // Guarda crítica: filiaisPadrao() deriva listaFilial daqui. Paginar por
    // padrão estreitaria em silêncio toda consulta W120/W106.
    const filiais = Array.from({ length: 25 }, (_, i) => ({
      CODIGO: String(i + 1),
    }));
    const postJson = jest.fn().mockResolvedValue(gridResponse(filiais));
    const service = makeService(postJson);

    const result = await service.pesquisarFilial('150');

    expect(result.data?.items).toHaveLength(25);
    expect(result.data?.pageSize).toBe(25);
  });

  it('pesquisarFilial pagina em processo quando pedido, sem tocar no envelope', async () => {
    const filiais = Array.from({ length: 25 }, (_, i) => ({
      CODIGO: String(i + 1),
    }));
    const postJson = jest.fn().mockResolvedValue(gridResponse(filiais));
    const service = makeService(postJson);

    const result = await service.pesquisarFilial('150', {
      page: 2,
      pageSize: 10,
    });

    // O corpo continua reduzido — adicionar paginator aqui é HTTP 500 (§6.3).
    expect(corpo(postJson)).toEqual({ data: { matricula: '150' } });
    expect(result.data?.items).toHaveLength(10);
    expect(result.data?.items[0].CODIGO).toBe('11');
    expect(result.data?.total).toBe(25);
    expect(result.data?.totalPages).toBe(3);
  });

  it('busca as filiais do usuário quando listaFilial é omitido, e reaproveita o cache', async () => {
    const postJson = jest.fn().mockImplementation((path: string) => {
      if (path.endsWith(ENDPOINTS.usuarioLogado)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { data: { MATRICULA: 150, NOME: 'DEMO' } },
        });
      }
      if (path.endsWith(ENDPOINTS.pesquisarFilial)) {
        return Promise.resolve(
          gridResponse([{ CODIGO: '1' }, { CODIGO: '10' }, { CODIGO: '11' }]),
        );
      }
      return Promise.resolve(gridResponse([]));
    });
    const service = makeService(postJson);

    await service.listarInadimplencia(ENDPOINTS.inadimplenciaPorFilial, [], {});
    await service.listarInadimplencia(
      ENDPOINTS.inadimplenciaPorCliente,
      [],
      {},
    );

    const listagens = postJson.mock.calls
      .map((_c, i) => filtros(postJson, i))
      .filter((f) => 'listaFilial' in f);
    expect(
      listagens.every((f) => (f.listaFilial as string[]).length === 3),
    ).toBe(true);
    // Usuário logado + filiais resolvidos uma única vez (cache).
    const resolucoes = postJson.mock.calls.filter((_c, i) =>
      caminho(postJson, i).endsWith(ENDPOINTS.usuarioLogado),
    );
    expect(resolucoes).toHaveLength(1);
  });

  it('ecoa as filiais aplicadas e avisa quando a consulta foi expandida', async () => {
    const codigos = Array.from({ length: 7 }, (_, i) => ({
      CODIGO: String(i + 1),
    }));
    const postJson = jest.fn().mockImplementation((path: string) => {
      if (path.endsWith(ENDPOINTS.usuarioLogado)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { data: { MATRICULA: 150 } },
        });
      }
      if (path.endsWith(ENDPOINTS.pesquisarFilial)) {
        return Promise.resolve(gridResponse(codigos));
      }
      return Promise.resolve(gridResponse([]));
    });
    const service = makeService(postJson);

    const expandida = await service.listarInadimplencia(
      ENDPOINTS.inadimplenciaPorFilial,
      [],
      {},
    );
    expect(expandida.data?.filiaisAplicadas).toHaveLength(7);
    expect(expandida.data?.hint).toContain('7 filiais');

    const restrita = await service.listarInadimplencia(
      ENDPOINTS.inadimplenciaPorFilial,
      [],
      { listaFilial: ['1'] },
    );
    expect(restrita.data?.filiaisAplicadas).toEqual(['1']);
    expect(restrita.data?.hint).toBeUndefined();
  });

  it('propaga erro do gateway sem inventar sucesso', async () => {
    const postJson = jest.fn().mockResolvedValue({
      ok: false,
      status: 200,
      error: 'WinThor devolveu uma página de erro HTML em vez de JSON.',
      raw: '<html><body>HTTP ERROR 500</body></html>',
    });
    const service = makeService(postJson);

    const result = await service.listarInadimplencia(
      ENDPOINTS.inadimplenciaPorValor,
      [],
      { listaFilial: ['1'] },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTML');
    expect(result.data).toBeUndefined();
  });

  it('preserva os typos de grafia que fazem parte do contrato', () => {
    expect(ENDPOINTS.inadimplenciaPorCliente).toContain(
      'listarResumoIndimplencia',
    );
    expect(ENDPOINTS.inadimplenciaPorSupervisor).toContain(
      'listarResumoInadimplecia',
    );
    expect(ENDPOINTS.inadimplenciaPorDiaAtraso).toContain(
      'listarResumoIndimplenciaPorDiaAtrazo',
    );
  });

  describe('agregarFaturamento', () => {
    const pedido = (
      numero: number,
      cliente: number,
      valor: number,
      custo: number,
    ) => ({
      NUMERO_PEDIDO: numero,
      CODIGO_CLIENTE: cliente,
      NOME_CLIENTE: `CLIENTE ${cliente}`,
      VALOR_PEDIDO: valor,
      CUSTO_FINANCEIRO: custo,
    });

    /** Upstream falso que pagina de verdade sobre uma base fixa. */
    const upstream = (base: Record<string, unknown>[]) =>
      jest.fn().mockImplementation((_path: string, corpo: EnvelopeEnviado) => {
        const page = Number(corpo.paginator?.nextPage ?? 1);
        const size = Number(corpo.paginator?.countDataPage ?? 10);
        const ini = (page - 1) * size;
        return Promise.resolve(
          gridResponse(base.slice(ini, ini + size), base.length),
        );
      });

    it('soma por cliente e ordena por valor faturado', async () => {
      const postJson = upstream([
        pedido(1, 10, 100, 60),
        pedido(2, 20, 500, 300),
        pedido(3, 10, 400, 240),
      ]);
      const service = makeService(postJson);

      const r = await service.agregarFaturamento({
        listaFilial: ['1'],
      });
      const items = r.data?.items ?? [];

      expect(items).toHaveLength(2);
      // Cliente 10 soma 500 e passa o cliente 20, que tem um pedido maior.
      expect(items[0]).toMatchObject({
        CODIGO_CLIENTE: 10,
        QT_PEDIDOS: 2,
        VALOR_FATURADO: 500,
        VALOR_LUCRO: 200,
      });
      expect(items[1]).toMatchObject({ CODIGO_CLIENTE: 20, QT_PEDIDOS: 1 });
    });

    it('margem sai das somas, não da média dos percentuais', async () => {
      // Média de PERCENTUAL_LUCRO daria 45%; o certo é 400/1100 = 36,36%.
      const postJson = upstream([
        pedido(1, 10, 100, 10), // 90% de margem
        pedido(2, 10, 1000, 690), // 31% de margem
      ]);
      const service = makeService(postJson);

      const linha = (await service.agregarFaturamento({ listaFilial: ['1'] }))
        .data?.items[0];

      expect(linha?.VALOR_FATURADO).toBe(1100);
      expect(linha?.VALOR_LUCRO).toBe(400);
      expect(linha?.PERC_LUCRO).toBeCloseTo(36.36, 1);
    });

    it('participação soma 100% entre os clientes', async () => {
      const postJson = upstream([pedido(1, 10, 750, 0), pedido(2, 20, 250, 0)]);
      const items =
        (
          await makeService(postJson).agregarFaturamento({
            listaFilial: ['1'],
          })
        ).data?.items ?? [];

      expect(items[0].PARTICIPACAO).toBe(75);
      expect(items[1].PARTICIPACAO).toBe(25);
    });

    it('varre todas as páginas e marca a varredura como completa', async () => {
      const base = Array.from({ length: 450 }, (_, i) =>
        pedido(i, i % 30, 100, 50),
      );
      const postJson = upstream(base);

      const r = await makeService(postJson).agregarFaturamento({
        listaFilial: ['1'],
      });

      // 450 pedidos com SCAN_PAGE_SIZE=200 → 3 páginas.
      expect(postJson).toHaveBeenCalledTimes(3);
      expect(r.data?.varredura).toMatchObject({
        pedidos: 450,
        paginas: 3,
        completa: true,
      });
      expect(r.data?.total).toBe(30);
    });

    it('para quando o upstream repete a página, em vez de girar para sempre', async () => {
      // A semântica de página do upstream nunca foi verificada: se ele ignorar
      // nextPage, sem esta guarda o laço nunca termina.
      const postJson = jest
        .fn()
        .mockResolvedValue(gridResponse([pedido(1, 10, 100, 50)], 2500));

      const r = await makeService(postJson).agregarFaturamento({
        listaFilial: ['1'],
      });

      expect(postJson.mock.calls.length).toBeLessThan(5);
      expect(r.data?.varredura).toMatchObject({ completa: false });
      expect(r.data?.hint).toContain('parcial');
    });

    /**
     * Upstream falso que distingue a varredura (countDataPage 200) das
     * chamadas de totais (countDataPage 1), por filial e da união.
     */
    const upstreamDimensao = () =>
      jest.fn().mockImplementation((_p: string, corpo: EnvelopeEnviado) => {
        const size = corpo.paginator?.countDataPage;
        const fil =
          (corpo.parameters?.parameters?.listaFilial as string[]) ?? [];

        // Varredura por cliente: 13.499 pedidos, acima do teto.
        if (size === '200') {
          return Promise.resolve(gridResponse([pedido(1, 10, 100, 50)], 13499));
        }
        const porFilial: Record<string, [number, number]> = {
          '1': [300, 30000],
          '2': [200, 20000],
        };
        if (fil.length === 1) {
          const [count, valor] = porFilial[fil[0]];
          return Promise.resolve(
            gridResponse([{ NOME_FILIAL: `FILIAL ${fil[0]}` }], count, {
              VALOR_PEDIDO: valor,
              CUSTO_FINANCEIRO: valor * 0.6,
            }),
          );
        }
        // União: bate com a soma das filiais.
        return Promise.resolve(
          gridResponse([{}], 500, {
            VALOR_PEDIDO: 50000,
            CUSTO_FINANCEIRO: 30000,
          }),
        );
      });

    it('rebaixa para filial quando por cliente não cabe', async () => {
      // Medido no WinThor real: "mês atual, 20 filiais, faturado" = 13.499
      // pedidos ≈ 3,3 min de varredura. Em vez de recusar, agrega numa
      // dimensão mais grossa — exata e sem varrer linha nenhuma.
      const postJson = upstreamDimensao();

      const r = await makeService(postJson).agregarFaturamento({
        listaFilial: ['1', '2'],
      });

      expect(r.ok).toBe(true);
      expect(r.data).toMatchObject({
        agrupadoPor: 'filial',
        agrupamentoSolicitado: 'cliente',
        rebaixado: true,
      });
      expect(r.data?.items).toHaveLength(2);
      // Chaves de linha diferentes são a defesa que não depende de o modelo
      // ler o envelope: filial nunca se passa por cliente.
      expect(r.data?.items[0]).toMatchObject({
        NIVEL: 'filial',
        CODIGO_FILIAL: '1',
        NOME_FILIAL: 'FILIAL 1',
        QT_PEDIDOS: 300,
        VALOR_FATURADO: 30000,
        VALOR_LUCRO: 12000,
      });
      expect(r.data?.items[0]).not.toHaveProperty('CODIGO_CLIENTE');
      expect(r.data?.hint).toContain('13499');
    });

    it('a conferência prova que a soma por dimensão bate com o total', async () => {
      const r = await makeService(upstreamDimensao()).agregarFaturamento({
        agruparPor: 'filial',
        listaFilial: ['1', '2'],
      });

      expect(r.data?.conferencia).toMatchObject({
        somaDimensao: 50000,
        totalGeral: 50000,
        divergenciaPct: 0,
        confere: true,
      });
      expect(r.data?.metricas).toContain('VALOR_LUCRO');
    });

    it('conferência falhando derruba o dinheiro e mantém a contagem', async () => {
      // Se o totalizer for por página e não do conjunto, as somas não fecham.
      // Devolver contagem verdadeira é melhor que valores suspeitos.
      const postJson = jest
        .fn()
        .mockImplementation((_p: string, corpo: EnvelopeEnviado) => {
          const fil =
            (corpo.parameters?.parameters?.listaFilial as string[]) ?? [];
          return Promise.resolve(
            gridResponse([{ NOME_FILIAL: 'X' }], fil.length === 1 ? 300 : 600, {
              VALOR_PEDIDO: fil.length === 1 ? 30000 : 999999,
            }),
          );
        });

      const r = await makeService(postJson).agregarFaturamento({
        agruparPor: 'filial',
        listaFilial: ['1', '2'],
      });

      expect(r.data?.conferencia?.confere).toBe(false);
      expect(r.data?.metricas).toEqual(['QT_PEDIDOS']);
      expect(r.data?.items[0]).toMatchObject({ QT_PEDIDOS: 300 });
      expect(r.data?.items[0]).not.toHaveProperty('VALOR_FATURADO');
      expect(r.data?.hint).toContain('Conferência falhou');
    });

    it('sem CUSTO_FINANCEIRO totalizado, omite lucro em vez de inventar 100%', async () => {
      // lucro = faturado - 0 = faturado e margem 100% é número errado de
      // aparência plausível, que o modelo reporta sem hesitar.
      const postJson = jest
        .fn()
        .mockImplementation((_p: string, corpo: EnvelopeEnviado) => {
          const fil =
            (corpo.parameters?.parameters?.listaFilial as string[]) ?? [];
          return Promise.resolve(
            gridResponse([{ NOME_FILIAL: 'X' }], fil.length === 1 ? 300 : 300, {
              VALOR_PEDIDO: 30000,
            }),
          );
        });

      const r = await makeService(postJson).agregarFaturamento({
        agruparPor: 'filial',
        listaFilial: ['1'],
      });

      expect(r.data?.items[0]).toMatchObject({ VALOR_FATURADO: 30000 });
      expect(r.data?.items[0]).not.toHaveProperty('VALOR_LUCRO');
      expect(r.data?.metricas).not.toContain('VALOR_LUCRO');
      expect(r.data?.hint).toContain('CUSTO_FINANCEIRO');
    });

    it('totalizer em string pt-BR não vira zero silencioso', async () => {
      const postJson = jest.fn().mockResolvedValue(
        gridResponse([{ NOME_FILIAL: 'X' }], 300, {
          VALOR_PEDIDO: '600.793,14' as unknown as number,
        }),
      );

      const r = await makeService(postJson).agregarFaturamento({
        agruparPor: 'filial',
        listaFilial: ['1'],
      });

      expect(r.data?.items[0]).not.toHaveProperty('VALOR_FATURADO');
      expect(r.data?.metricas).toEqual(['QT_PEDIDOS']);
    });

    it('permitirRebaixar false volta a recusar', async () => {
      const postJson = upstreamDimensao();

      const r = await makeService(postJson).agregarFaturamento({
        listaFilial: ['1'],
        permitirRebaixar: false,
      });

      expect(r.data?.items).toEqual([]);
      expect(r.data?.varredura).toMatchObject({ acimaDoTeto: true });
      expect(r.data?.rebaixado).toBeUndefined();
    });

    it('posicaoPedido 4 (Faturado) vale em TODAS as chamadas por dimensão', async () => {
      // Sem isso os totais por filial incluem bloqueado e pendente enquanto os
      // por cliente não — divergência grande, silenciosa e sempre no mesmo
      // sentido. Medido: 13.738 Todos vs 13.499 Faturado.
      const postJson = upstreamDimensao();
      await makeService(postJson).agregarFaturamento({
        agruparPor: 'filial',
        listaFilial: ['1', '2'],
      });

      const posicoes = postJson.mock.calls.map(
        (_c, i) => filtros(postJson, i).posicaoPedido,
      );
      expect(posicoes.length).toBeGreaterThan(1);
      expect(posicoes.every((p) => p === '4')).toBe(true);
    });

    it('uma chamada falhando reprova a agregação inteira', async () => {
      // Uma filial perdida encolheria o total em silêncio.
      let n = 0;
      const postJson = jest.fn().mockImplementation(() => {
        n++;
        return Promise.resolve(
          n === 2
            ? { ok: false, status: 500, error: 'WinThor retornou 500' }
            : gridResponse([{ NOME_FILIAL: 'X' }], 300, {
                VALOR_PEDIDO: 30000,
              }),
        );
      });

      const r = await makeService(postJson).agregarFaturamento({
        agruparPor: 'filial',
        listaFilial: ['1', '2'],
      });

      expect(r.ok).toBe(false);
      expect(r.status).toBe(500);
    });

    it('agruparPor rca usa o agregado nativo, numa chamada só', async () => {
      const postJson = jest
        .fn()
        .mockResolvedValue(gridResponse([{ CODIGO: '7', VALOR_TOTAL: 100 }]));

      const r = await makeService(postJson).agregarFaturamento({
        agruparPor: 'rca',
        listaFilial: ['1'],
      });

      expect(postJson).toHaveBeenCalledTimes(1);
      expect(caminho(postJson)).toContain('listarLucratividadeSinteticaPorRCA');
      expect(filtros(postJson).perspectiva).toBe('2');
      expect(r.data?.agrupadoPor).toBe('rca');
      expect(r.data?.items[0].NIVEL).toBe('rca');
    });

    it('filtra por posicaoPedido=4 (Faturado) por padrão', async () => {
      const postJson = upstream([]);
      await makeService(postJson).agregarFaturamento({
        listaFilial: ['1'],
      });

      expect(filtros(postJson).posicaoPedido).toBe('4');
      expect(filtros(postJson).perspectiva).toBe('1');
    });

    it('respeita posicaoPedido explícito', async () => {
      const postJson = upstream([]);
      await makeService(postJson).agregarFaturamento({
        listaFilial: ['1'],
        posicaoPedido: '0',
      });

      expect(filtros(postJson).posicaoPedido).toBe('0');
    });

    it('reaproveita o cache entre páginas do agregado', async () => {
      const base = Array.from({ length: 10 }, (_, i) => pedido(i, i, 100, 50));
      const postJson = upstream(base);
      const service = makeService(postJson);

      await service.agregarFaturamento({
        listaFilial: ['1'],
        page: 1,
        pageSize: 5,
      });
      const chamadasApos1 = postJson.mock.calls.length;
      const p2 = await service.agregarFaturamento({
        listaFilial: ['1'],
        page: 2,
        pageSize: 5,
      });

      // A varredura acontece uma vez; a página 2 é fatia do que já foi somado.
      expect(postJson.mock.calls.length).toBe(chamadasApos1);
      expect(p2.data?.items).toHaveLength(5);
      expect(p2.data?.page).toBe(2);
    });

    it('propaga falha do upstream sem inventar agregado', async () => {
      const postJson = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        error: 'WinThor retornou 500',
      });

      const r = await makeService(postJson).agregarFaturamento({});

      expect(r.ok).toBe(false);
      expect(r.status).toBe(500);
      expect(r.data).toBeUndefined();
    });
  });

  it('cobre os 21 endpoints do documento, mais as tools derivadas', () => {
    // 21 endpoints documentados → 21 tools diretas. `wt_faturamento_por_cliente`
    // é derivada: agrega listarPedidosDeVenda em processo porque o WinThor não
    // expõe faturamento por cliente. Toda tool nova sem endpoint próprio entra
    // nesta lista, para o número não virar um contador sem significado.
    const DERIVADAS = ['wt_faturamento_agregado'];

    expect(Object.keys(ENDPOINTS)).toHaveLength(21);
    expect(new Set(MOBILE_TOOL_NAMES).size).toBe(21 + DERIVADAS.length);
    for (const nome of DERIVADAS) {
      expect(MOBILE_TOOL_NAMES).toContain(nome);
    }
  });
});

describe('WinthorMobileService + base local', () => {
  /** Query stub: atende ou recusa, sem banco nenhum. */
  const vendasStub = (resposta: unknown) =>
    ({ agregar: () => resposta }) as never;

  it('construído com dois argumentos, como antes, ignora a base local', async () => {
    // Os specs acima instanciam assim. `@Optional()` existe para este contrato
    // não mudar — base ausente = comportamento idêntico ao de antes dela existir.
    const postJson = jest.fn().mockResolvedValue(gridResponse([], 0, {}));
    const service = makeService(postJson);
    await service.agregarFaturamento({ agruparPor: 'filial', periodo: '4' });
    expect(postJson).toHaveBeenCalled();
  });

  it('janela coberta é servida do SQL, sem uma única chamada ao WinThor', async () => {
    const postJson = jest.fn().mockResolvedValue(gridResponse([]));
    const service = new WinthorMobileService(
      configStub,
      { postJson } as unknown as WinthorApiService,
      vendasStub({
        atendivel: true,
        resultado: {
          items: [],
          count: 0,
          page: 1,
          pageSize: 10,
          fonte: 'base-local',
        },
      }),
    );

    const r = await service.agregarFaturamento({
      agruparPor: 'cliente',
      periodo: '4',
      listaFilial: ['1'],
    });

    expect(r.ok).toBe(true);
    expect(r.data?.fonte).toBe('base-local');
    // É este `not.toHaveBeenCalled` que prova o ganho: hoje esta mesma consulta
    // varre páginas de 2,9 s até recusar por teto.
    expect(postJson).not.toHaveBeenCalled();
  });

  it('base sem cobertura cai para o caminho ao vivo de sempre', async () => {
    const postJson = jest.fn().mockResolvedValue(gridResponse([], 0, {}));
    const service = new WinthorMobileService(
      configStub,
      { postJson } as unknown as WinthorApiService,
      vendasStub({ atendivel: false, motivo: 'dias sem cobertura' }),
    );

    await service.agregarFaturamento({
      agruparPor: 'filial',
      periodo: '4',
      listaFilial: ['1'],
    });
    expect(postJson).toHaveBeenCalled();
  });

  it('supervisor nunca vai para a base local: a linha do pedido não tem supervisor', async () => {
    const agregar = jest.fn();
    const postJson = jest.fn().mockResolvedValue(gridResponse([], 0, {}));
    const service = new WinthorMobileService(
      configStub,
      { postJson } as unknown as WinthorApiService,
      { agregar } as never,
    );

    await service.agregarFaturamento({
      agruparPor: 'supervisor',
      periodo: '4',
      listaFilial: ['1'],
    });
    expect(agregar).not.toHaveBeenCalled();
    expect(postJson).toHaveBeenCalled();
  });

  it('rca continua no agregado nativo do WinThor, não na base local', async () => {
    // Ter uma segunda rota somando RCA em processo recriaria o problema que a
    // delegação a wt_lucratividade_por_rca existe para evitar.
    const agregar = jest.fn();
    const postJson = jest.fn().mockResolvedValue(gridResponse([], 0, {}));
    const service = new WinthorMobileService(
      configStub,
      { postJson } as unknown as WinthorApiService,
      { agregar } as never,
    );

    await service.agregarFaturamento({
      agruparPor: 'rca',
      periodo: '4',
      listaFilial: ['1'],
    });
    expect(agregar).not.toHaveBeenCalled();
    expect(caminho(postJson)).toContain('listarLucratividadeSinteticaPorRCA');
  });

  it('data livre sem cobertura NÃO vira o enum de período', async () => {
    // Trocar "01/03 a 15/03" por "mês atual" devolveria números certos para uma
    // pergunta que ninguém fez.
    const postJson = jest.fn().mockResolvedValue(gridResponse([], 0, {}));
    const service = new WinthorMobileService(
      configStub,
      { postJson } as unknown as WinthorApiService,
      vendasStub({ atendivel: false, motivo: 'sem cobertura' }),
    );

    const r = await service.agregarFaturamento({
      agruparPor: 'cliente',
      dataInicio: '2026-03-01',
      dataFim: '2026-03-15',
      listaFilial: ['1'],
    });

    expect(r.ok).toBe(true);
    expect(r.data?.items).toEqual([]);
    expect(r.data?.hint).toContain('2026-03-01');
    expect(postJson).not.toHaveBeenCalled();
  });
});
