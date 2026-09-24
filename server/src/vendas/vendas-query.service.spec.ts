import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarBasesTeste } from './vendas-test-helpers';

const JANELA = { dataInicio: '2026-06-01', dataFim: '2026-06-30' };
const AGORA = new Date('2026-09-15T15:00:00.000Z');

const pedido = (over: Record<string, unknown> = {}) => ({
  NUMERO_PEDIDO: 1,
  CODIGO_FILIAL: '1',
  NOME_FILIAL: 'MATRIZ',
  DATA_PEDIDO: '2026-06-10T03:00:00.000Z',
  POSICAO_PEDIDO: 'FATURADO',
  CODIGO_CLIENTE: 331,
  NOME_CLIENTE: 'GILMARIO',
  CODIGO_RCA: 57,
  NOME_RCA: 'ORLANO',
  CODIGO_EMITENTE: 83,
  NOME_EMITENTE: 'ORLANO',
  VALOR_PEDIDO: 1000,
  CUSTO_FINANCEIRO: 600,
  PERCENTUAL_LUCRO: 40,
  ...over,
});

describe('VendasQueryService', () => {
  let dir: string;
  let bases: Awaited<ReturnType<typeof criarBasesTeste>>;
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-query-'));
    process.env.WTA_DATA_DIR = dir;
    bases = await criarBasesTeste();
    bases.store.aprenderPosicoes(bases.instanciaId, {
      '4': 'FATURADO',
      '2': 'PENDENTE',
    });
  });

  afterEach(async () => {
    await bases.fechar();
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  const ingerir = async (
    filial: string,
    pedidos: Record<string, unknown>[],
    janela = JANELA,
  ) => {
    const lote = bases.store.abrirLote({
      instanciaId: bases.instanciaId,
      codigoFilial: filial,
      periodo: '4',
      posicaoPedido: '0',
      margemMinLucro: '100',
      janela,
    });
    if (pedidos.length) await bases.store.gravarPagina(lote, pedidos, 2);
    await bases.store.fecharLote(lote, {
      estado: 'completo',
      paginas: 1,
      agora: AGORA,
    });
  };

  const args = (
    over: Partial<Parameters<typeof bases.query.agregar>[0]> = {},
  ) => ({
    dimensao: 'cliente' as const,
    filiais: ['1'],
    janela: JANELA,
    posicaoPedido: '0',
    ...over,
  });

  it('agrega por cliente via DuckDB + dims SQLite', async () => {
    await ingerir('1', [
      pedido({ NUMERO_PEDIDO: 1, VALOR_PEDIDO: 1000, CUSTO_FINANCEIRO: 600 }),
      pedido({ NUMERO_PEDIDO: 2, VALOR_PEDIDO: 500, CUSTO_FINANCEIRO: 300 }),
      pedido({
        NUMERO_PEDIDO: 3,
        CODIGO_CLIENTE: 999,
        NOME_CLIENTE: 'OUTRO',
        VALOR_PEDIDO: 200,
        CUSTO_FINANCEIRO: 100,
      }),
    ]);

    const r = await bases.query.agregar(args());
    expect(r.atendivel).toBe(true);
    if (!r.atendivel) return;

    expect(r.resultado.fonte).toBe('base-local');
    expect(r.resultado.total).toBe(2);
    expect(r.resultado.items[0]).toMatchObject({
      CODIGO_CLIENTE: '331',
      QT_PEDIDOS: 2,
      VALOR_FATURADO: 1500,
    });
  });

  it('recusa quando a cobertura está incompleta', async () => {
    await ingerir('1', [pedido()], {
      dataInicio: '2026-06-01',
      dataFim: '2026-06-15',
    });
    const r = await bases.query.agregar(args());
    expect(r.atendivel).toBe(false);
    if (!r.atendivel) {
      expect(r.diasFaltantes?.length).toBeGreaterThan(0);
    }
  });

  it('dia sem venda conta como coberto', async () => {
    await ingerir('1', []);
    const r = await bases.query.agregar(args());
    expect(r.atendivel).toBe(true);
    if (r.atendivel) expect(r.resultado.total).toBe(0);
  });

  it('recusa quando só uma das filiais pedidas tem cobertura', async () => {
    // A filial 2 nunca foi varrida. Todo dia da janela falta — porque falta em UMA
    // filial — e é este número que o card do painel precisa repetir em vez de
    // contar `DISTINCT dia` e concluir "Cacheado".
    await ingerir('1', [pedido()]);

    const r = await bases.query.agregar(args({ filiais: ['1', '2'] }));
    expect(r.atendivel).toBe(false);
    if (!r.atendivel) {
      expect(r.diasFaltantes?.length).toBe(30);
      expect(r.motivo).toContain('de 60 pares');
    }
  });
});
