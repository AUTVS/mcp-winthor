import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WinthorMobileService } from '../winthor/winthor-mobile.service';
import { VendasAncoraService } from './vendas-ancora.service';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { VendasStoreService } from './vendas-store.service';
import { configTeste } from './vendas-test-helpers';

const JANELA = { dataInicio: '2026-07-01', dataFim: '2026-07-31' };
const AGORA = new Date('2026-09-15T15:00:00.000Z');

const pedido = () => ({
  NUMERO_PEDIDO: 100,
  CODIGO_FILIAL: '1',
  NOME_FILIAL: 'MATRIZ',
  DATA_PEDIDO: '2026-07-10T03:00:00.000Z',
  POSICAO_PEDIDO: 'FATURADO',
  CODIGO_CLIENTE: 331,
  NOME_CLIENTE: 'GIL',
  VALOR_PEDIDO: 500,
  CUSTO_FINANCEIRO: 250,
});

describe('VendasAncoraService', () => {
  let dir: string;
  let meta: VendasMetaDbService;
  let fato: VendasFatoDbService;
  let store: VendasStoreService;
  let ancora: VendasAncoraService;
  let listar: jest.Mock;
  let instanciaId: number;
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-ancora-'));
    process.env.WTA_DATA_DIR = dir;
    const servico = { getConfig: () => configTeste() } as never;
    meta = new VendasMetaDbService(servico);
    fato = new VendasFatoDbService(meta);
    await fato.pronto();
    store = new VendasStoreService(meta, fato);
    instanciaId = meta.instanciaId()!;
    listar = jest.fn();
    ancora = new VendasAncoraService(
      { listarLucratividade: listar } as unknown as WinthorMobileService,
      meta,
      fato,
      store,
    );
  });

  afterEach(async () => {
    meta.fechar();
    await fato.fechar();
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  async function gravarPedidoLocal(): Promise<void> {
    const lote = store.abrirLote({
      instanciaId,
      codigoFilial: '1',
      periodo: '7',
      posicaoPedido: '0',
      margemMinLucro: '100',
      janela: JANELA,
    });
    await store.gravarPagina(lote, [pedido()], 2);
    await store.fecharLote(lote, {
      estado: 'completo',
      paginas: 1,
      valorUpstream: 500,
      agora: AGORA,
    });
  }

  function mockUpstream(total: number, valor?: number) {
    listar.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        items: [],
        total,
        totalizer: valor !== undefined ? { VALOR_PEDIDO: valor } : undefined,
      },
    });
  }

  it('grava âncora conferida quando local e upstream batem', async () => {
    await gravarPedidoLocal();
    mockUpstream(1, 500);

    const r = await ancora.verificar(instanciaId, '1', '7', '0', AGORA);

    expect(r.confere).toBe(true);
    expect(
      meta
        .banco()
        .prepare('SELECT confere FROM ancora WHERE instancia_id = ?')
        .get(instanciaId),
    ).toMatchObject({ confere: 1 });
  });

  it('marca cobertura fria como suspeita quando a âncora falha', async () => {
    await gravarPedidoLocal();
    mockUpstream(1, 9999);

    const r = await ancora.verificar(instanciaId, '1', '7', '0', AGORA);

    expect(r.confere).toBe(false);
    expect(ancora.listarProblemas(instanciaId).length).toBeGreaterThan(0);
    expect(
      meta
        .banco()
        .prepare(
          `SELECT estado FROM cobertura
            WHERE instancia_id = ? AND dia = '2026-07-10'`,
        )
        .get(instanciaId),
    ).toMatchObject({ estado: 'suspeito' });
  });

  it('não marca suspeito quando o upstream falha (âncora inconclusiva)', async () => {
    await gravarPedidoLocal();
    listar.mockResolvedValue({
      ok: false,
      status: 0,
      error: 'WinThor não respondeu em 20000ms (timeout).',
    });

    const r = await ancora.verificar(instanciaId, '1', '7', '0', AGORA);

    expect(r.confere).toBe(true);
    expect(ancora.listarProblemas(instanciaId)).toHaveLength(0);
    expect(
      meta
        .banco()
        .prepare(
          `SELECT estado FROM cobertura
            WHERE instancia_id = ? AND dia = '2026-07-10'`,
        )
        .get(instanciaId),
    ).toMatchObject({ estado: 'frio' });
  });

  it('não marca suspeito quando totalizer e total estão ausentes', async () => {
    await gravarPedidoLocal();
    listar.mockResolvedValue({
      ok: true,
      status: 200,
      data: { items: [], totalizer: undefined },
    });

    const r = await ancora.verificar(instanciaId, '1', '7', '0', AGORA);

    expect(r.confere).toBe(true);
    expect(ancora.listarProblemas(instanciaId)).toHaveLength(0);
  });
});
