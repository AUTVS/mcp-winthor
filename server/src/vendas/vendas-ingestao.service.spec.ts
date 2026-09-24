import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WtConfig } from '../config/config.schema';
import { WtConfigService } from '../config/wt-config.service';
import { WinthorMobileService } from '../winthor/winthor-mobile.service';
import { GridResult } from '../winthor/winthor-mobile.types';
import { WinthorApiResult } from '../winthor/winthor-api.service';
import { VendasAncoraService } from './vendas-ancora.service';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasIngestaoService } from './vendas-ingestao.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { VendasStoreService } from './vendas-store.service';

const config: WtConfig = {
  winthorBaseUrl: 'http://winthor.local:8181',
  login: 'DEMO',
  senhaMd5: 'X',
  configuredAt: '2026-01-01T00:00:00.000Z',
};

/** Ontem em relação ao relógio real, que é o que a sonda de derivação compara. */
const ontem = () => {
  const d = new Date(Date.now() - 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
};

const pedidoEm = (dia: string, numero: number, valor = 100) => ({
  NUMERO_PEDIDO: numero,
  CODIGO_FILIAL: '1',
  DATA_PEDIDO: `${dia}T03:00:00.000Z`,
  POSICAO_PEDIDO: 'FATURADO',
  CODIGO_CLIENTE: 331,
  NOME_CLIENTE: 'GILMARIO',
  VALOR_PEDIDO: valor,
  CUSTO_FINANCEIRO: valor / 2,
});

const ok = (
  items: Record<string, unknown>[],
  total?: number,
  totalizer?: Record<string, number>,
): WinthorApiResult<GridResult> => ({
  ok: true,
  status: 200,
  data: {
    items,
    count: items.length,
    page: 1,
    pageSize: 200,
    total,
    totalizer,
  },
});

describe('VendasIngestaoService', () => {
  let dir: string;
  let meta: VendasMetaDbService;
  let fato: VendasFatoDbService;
  let store: VendasStoreService;
  let ancora: VendasAncoraService;
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-ingestao-'));
    process.env.WTA_DATA_DIR = dir;
    const servicoCfg = {
      getConfig: () => config,
    } as unknown as WtConfigService;
    meta = new VendasMetaDbService(servicoCfg);
    fato = new VendasFatoDbService(meta);
    await fato.pronto();
    store = new VendasStoreService(meta, fato);
    ancora = {
      verificarPeriodosCongelados: jest.fn().mockResolvedValue(undefined),
    } as unknown as VendasAncoraService;
  });

  afterEach(async () => {
    meta.fechar();
    await fato.fechar();
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  /**
   * `listarLucratividade` mockado. `paginas` responde às varreduras de dados; as
   * sondas (pageSize 1 e periodo '2') são respondidas à parte.
   */
  function servico(opts: {
    paginas: Record<string, unknown>[][];
    total?: number;
    totalizer?: Record<string, number>;
    ontemItens?: Record<string, unknown>[];
  }) {
    let iPagina = 0;
    const listar = jest.fn(
      (
        _endpoint: string,
        _colunas: unknown[],
        args: Record<string, unknown>,
      ): Promise<WinthorApiResult<GridResult>> => {
        // Sonda de posição: uma linha, para aprender o rótulo do código.
        if (args.pageSize === 1) {
          return Promise.resolve(
            ok([{ POSICAO_PEDIDO: rotuloDe(args.posicaoPedido as string) }]),
          );
        }
        // Sonda de derivação do dia.
        if (args.periodo === '2') {
          return Promise.resolve(ok(opts.ontemItens ?? [pedidoEm(ontem(), 1)]));
        }
        const pagina = opts.paginas[iPagina] ?? [];
        iPagina++;
        return Promise.resolve(
          ok(
            pagina,
            pagina.length ? opts.total : 0,
            pagina.length ? opts.totalizer : undefined,
          ),
        );
      },
    );

    const mobile = {
      listarLucratividade: listar,
      filiaisPadrao: () => Promise.resolve(['1']),
    } as unknown as WinthorMobileService;

    const ingestao = new VendasIngestaoService(mobile, store, meta, ancora);
    VendasIngestaoService.semPausa(ingestao);
    return { ingestao, listar };
  }

  const rotuloDe = (codigo: string) =>
    ({ '1': 'BLOQUEADO', '2': 'PENDENTE', '3': 'LIBERADO', '4': 'FATURADO' })[
      codigo
    ];

  /** Espera a fila interna drenar (início assíncrono + término). */
  const esperar = async (ingestao: VendasIngestaoService) => {
    const limite = Date.now() + 30_000;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 20));
      const s = ingestao.status();
      if (!s.rodando && s.iniciadoEm) return;
    }
    throw new Error('timeout aguardando ingestão');
  };

  const contarMeta = (sql: string) =>
    (meta.banco().prepare(sql).get() as { c: number }).c;

  const contarPedidos = async () => fato.contarPedidos(meta.instanciaId()!);

  it('aprende o mapa de posição do ERP antes de varrer', async () => {
    const { ingestao } = servico({ paginas: [[]] });
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    // Chutar 'FATURADO' seria inventar contrato: só esse rótulo aparece no
    // documento, e os outros três nunca foram observados numa resposta.
    expect(
      meta
        .banco()
        .prepare("SELECT rotulo FROM dim_posicao WHERE codigo = '2'")
        .get(),
    ).toMatchObject({ rotulo: 'PENDENTE' });
  });

  it('grava os pedidos e publica cobertura quando a varredura fecha', async () => {
    const { ingestao } = servico({
      paginas: [
        [pedidoEm('2026-07-10', 1, 100), pedidoEm('2026-07-11', 2, 200)],
      ],
      total: 2,
      totalizer: { VALOR_PEDIDO: 300 },
    });
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    expect(await contarPedidos()).toBeGreaterThan(0);
    expect(contarMeta('SELECT COUNT(*) c FROM cobertura')).toBeGreaterThan(0);
    expect(
      contarMeta("SELECT COUNT(*) c FROM lote WHERE estado = 'completo'"),
    ).toBeGreaterThan(0);
  });

  it('para e marca parcial quando o upstream repete a página', async () => {
    // A semântica de página do upstream nunca foi verificada além de page=1.
    // Sem esta guarda, o backfill gravaria a mesma página em laço infinito.
    const pagina = Array.from({ length: 200 }, (_, i) =>
      pedidoEm('2026-07-10', i + 1),
    );
    const { ingestao } = servico({
      paginas: [pagina, pagina, pagina],
      total: 5000,
      totalizer: { VALOR_PEDIDO: 20000 },
    });
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    expect(
      contarMeta("SELECT COUNT(*) c FROM lote WHERE estado = 'parcial'"),
    ).toBeGreaterThan(0);
    expect(contarMeta('SELECT COUNT(*) c FROM cobertura')).toBe(0);
    expect(ingestao.status().erros.join(' ')).toContain('repetiu');
  });

  it('reduz pageSize e retenta quando a resposta passa do teto de bytes', async () => {
    let iPagina = 0;
    const listar = jest.fn(
      (
        _endpoint: string,
        _colunas: unknown[],
        args: Record<string, unknown>,
      ): Promise<WinthorApiResult<GridResult>> => {
        if (args.pageSize === 1) {
          return Promise.resolve(
            ok([{ POSICAO_PEDIDO: rotuloDe(args.posicaoPedido as string) }]),
          );
        }
        if (args.periodo === '2') {
          return Promise.resolve(ok([pedidoEm(ontem(), 1)]));
        }
        if ((args.pageSize as number) > 50) {
          return Promise.resolve({
            ok: false,
            status: 200,
            error:
              'Resposta do WinThor passou de 8000000 bytes e foi interrompida. Reduza pageSize ou aplique filtros.',
          });
        }
        const pagina = [
          pedidoEm('2026-07-10', ++iPagina, 100),
          pedidoEm('2026-07-11', ++iPagina, 200),
        ];
        return Promise.resolve(ok(pagina, 2, { VALOR_PEDIDO: 300 }));
      },
    );

    const mobile = {
      listarLucratividade: listar,
      filiaisPadrao: () => Promise.resolve(['1']),
    } as unknown as WinthorMobileService;
    const ingestao = new VendasIngestaoService(mobile, store, meta, ancora);
    VendasIngestaoService.semPausa(ingestao);
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    expect(
      listar.mock.calls.some(
        (c) => c[2].pageSize === 50 && c[2].periodo === '3',
      ),
    ).toBe(true);
    expect(await contarPedidos()).toBeGreaterThan(0);
    expect(
      contarMeta("SELECT COUNT(*) c FROM lote WHERE estado = 'falhou'"),
    ).toBe(0);
  });

  it('não publica cobertura quando countDataPage não é honrado', async () => {
    // Página curta com total maior significa que o upstream ignorou o paginador:
    // encerrar como completa publicaria cobertura sobre varredura incompleta.
    const { ingestao } = servico({
      paginas: [[pedidoEm('2026-07-10', 1)]],
      total: 900,
      totalizer: { VALOR_PEDIDO: 90000 },
    });
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    expect(
      contarMeta(
        "SELECT COUNT(*) c FROM cobertura WHERE dia BETWEEN '2026-07-01' AND '2026-07-31'",
      ),
    ).toBe(0);
    expect(ingestao.status().erros.join(' ')).toContain('countDataPage');
  });

  it('aborta tudo se a derivação do dia não se confirmar', async () => {
    // 'Ontem' é uma janela de um dia só. Dois dias distintos significa que
    // DATA_PEDIDO não é meia-noite local neste ERP — e aí a base inteira estaria
    // deslocada. Não publicar nada é melhor que publicar tudo errado.
    const { ingestao } = servico({
      paginas: [[pedidoEm('2026-07-10', 1)]],
      ontemItens: [pedidoEm('2026-07-10', 1), pedidoEm('2026-07-11', 2)],
    });
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    expect(contarMeta('SELECT COUNT(*) c FROM cobertura')).toBe(0);
    expect(ingestao.status().erros.join(' ')).toContain('derivação do dia');
  });

  it('conferência reprovada não vira cobertura', async () => {
    const { ingestao } = servico({
      paginas: [[pedidoEm('2026-07-10', 1, 100)]],
      total: 1,
      totalizer: { VALOR_PEDIDO: 9999 }, // local 100 → divergência enorme
    });
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    expect(
      contarMeta(
        "SELECT COUNT(*) c FROM cobertura WHERE dia BETWEEN '2026-07-01' AND '2026-07-31'",
      ),
    ).toBe(0);
    expect(ingestao.status().erros.join(' ')).toContain('conferência');
  });

  it('serializa: a segunda sincronização não corre junto com a primeira', async () => {
    // Serializado de propósito, seguindo o precedente de `agregarPorDimensao`:
    // o WinthorApiService reusa sessão, e chamadas concorrentes podem
    // contaminar o totalizer — bug de número errado, não de lentidão.
    const { ingestao, listar } = servico({ paginas: [[], [], [], []] });
    expect(ingestao.sincronizar({ escopo: 'atualizacao' }).aceito).toBe(true);
    ingestao.sincronizar({ escopo: 'atualizacao' });
    await esperar(ingestao);

    // Nenhuma chamada ficou pendente depois da fila drenar.
    const antes = listar.mock.calls.length;
    await new Promise((r) => setImmediate(r));
    expect(listar.mock.calls.length).toBe(antes);
    expect(ingestao.status().rodando).toBe(false);
  });

  it('varre todas as posições, não só faturado', async () => {
    // Uma varredura serve a qualquer recorte de posição depois, em vez de cinco.
    const { listar, ingestao } = servico({
      paginas: [[pedidoEm('2026-07-10', 1)]],
      total: 1,
    });
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    const varreduras = listar.mock.calls.filter((c) => c[2].pageSize !== 1);
    for (const chamada of varreduras) {
      expect(chamada[2].posicaoPedido).toBe('0');
    }
  });

  it('o plano de atualização cobre mês atual e mês anterior', async () => {
    const { listar, ingestao } = servico({ paginas: [[], [], [], []] });
    ingestao.sincronizar({ escopo: 'atualizacao', filiais: ['1'] });
    await esperar(ingestao);

    const periodos = new Set(
      listar.mock.calls
        .map((c) => c[2].periodo)
        .filter((p) => p !== '2' && p !== '7'),
    );
    // '4' é o que congela o mês passado: pedido do dia 28 pode virar FATURADO
    // no dia 2 do mês seguinte.
    expect(periodos).toEqual(new Set(['3', '4']));
  });

  it('o plano de histórico cobre ano atual e ano anterior', async () => {
    const { listar, ingestao } = servico({ paginas: [[], [], [], []] });
    ingestao.sincronizar({ escopo: 'historico', filiais: ['1'] });
    await esperar(ingestao);

    const periodos = new Set(
      listar.mock.calls
        .map((c) => c[2].periodo)
        .filter((p) => p !== '2')
        .filter((_p, i) => listar.mock.calls[i][2].pageSize !== 1),
    );
    expect(periodos.has('7')).toBe(true);
    expect(periodos.has('8')).toBe(true);
  });

  describe('lotes órfãos', () => {
    it('fecha no boot o lote que ficou em_andamento de um processo morto', () => {
      const instanciaId = meta.instanciaId();
      if (instanciaId === null) throw new Error('instância não criada');

      // Simula o processo morto no meio da varredura: o lote abre e ninguém fecha.
      store.abrirLote({
        instanciaId,
        codigoFilial: '1',
        periodo: '4',
        posicaoPedido: '0',
        margemMinLucro: '100',
        janela: { dataInicio: '2026-06-01', dataFim: '2026-06-30' },
      });
      expect(
        contarMeta("SELECT COUNT(*) c FROM lote WHERE estado='em_andamento'"),
      ).toBe(1);

      expect(store.expirarLotesOrfaos()).toBe(1);

      expect(
        contarMeta("SELECT COUNT(*) c FROM lote WHERE estado='em_andamento'"),
      ).toBe(0);
      const lote = meta
        .banco()
        .prepare('SELECT estado, motivo, concluido_em FROM lote WHERE id = 1')
        .get() as { estado: string; motivo: string; concluido_em: string };
      expect(lote.estado).toBe('falhou');
      expect(lote.motivo).toContain('processo encerrado durante a varredura');
      expect(lote.concluido_em).toBeTruthy();
    });

    it('não mexe em lote já concluído', async () => {
      const instanciaId = meta.instanciaId();
      if (instanciaId === null) throw new Error('instância não criada');

      const lote = store.abrirLote({
        instanciaId,
        codigoFilial: '1',
        periodo: '4',
        posicaoPedido: '0',
        margemMinLucro: '100',
        janela: { dataInicio: '2026-06-01', dataFim: '2026-06-30' },
      });
      await store.fecharLote(lote, { estado: 'completo', paginas: 1 });

      expect(store.expirarLotesOrfaos()).toBe(0);
      expect(
        contarMeta("SELECT COUNT(*) c FROM lote WHERE estado='completo'"),
      ).toBe(1);
    });

    it('base sem lote órfão não faz nada', () => {
      expect(store.expirarLotesOrfaos()).toBe(0);
    });
  });

  describe('alvo de filiais', () => {
    const alvoGravado = () =>
      (
        meta
          .banco()
          .prepare(
            'SELECT codigo_filial FROM filial_alvo ORDER BY codigo_filial',
          )
          .all() as { codigo_filial: string }[]
      ).map((l) => l.codigo_filial);

    it('a varredura padrão registra o conjunto que planejou cobrir', async () => {
      const { ingestao } = servico({ paginas: [[], []] });
      ingestao.sincronizar({ escopo: 'atualizacao' });
      await esperar(ingestao);

      // `filiaisPadrao()` do stub devolve ['1']. É esse conjunto que o status passa
      // a usar como denominador, sem precisar chamar o ERP no poll.
      expect(alvoGravado()).toEqual(['1']);
    });

    it('sync dirigido a filiais não encolhe a expectativa da base', async () => {
      const { ingestao } = servico({ paginas: [[], []] });
      ingestao.sincronizar({ escopo: 'atualizacao' });
      await esperar(ingestao);
      expect(alvoGravado()).toEqual(['1']);

      // Pedir "só a filial 9" não pode fazer a base inteira parecer completa.
      const dirigido = servico({ paginas: [[], []] });
      dirigido.ingestao.sincronizar({
        escopo: 'atualizacao',
        filiais: ['9'],
      });
      await esperar(dirigido.ingestao);

      expect(alvoGravado()).toEqual(['1']);
    });

    it('filiaisEsperadas prefere o alvo à cobertura já gravada', () => {
      const instanciaId = meta.instanciaId();
      if (instanciaId === null) throw new Error('instância não criada');

      expect(store.filiaisEsperadas(instanciaId)).toEqual({
        filiais: [],
        fonte: 'cobertura',
      });

      store.registrarFiliaisAlvo(instanciaId, ['1', '2']);
      expect(store.filiaisEsperadas(instanciaId)).toEqual({
        filiais: ['1', '2'],
        fonte: 'sync',
      });

      // Substitui, não une: filial que sumiu da visibilidade sai da expectativa.
      store.registrarFiliaisAlvo(instanciaId, ['2']);
      expect(store.filiaisEsperadas(instanciaId)).toEqual({
        filiais: ['2'],
        fonte: 'sync',
      });
    });
  });
});
