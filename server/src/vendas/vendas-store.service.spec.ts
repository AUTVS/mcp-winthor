import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consultar } from './duckdb';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { VendasStoreService } from './vendas-store.service';
import { configTeste } from './vendas-test-helpers';

const pedido = (over: Record<string, unknown> = {}) => ({
  NUMERO_PEDIDO: 57003983,
  CODIGO_FILIAL: '1',
  NOME_FILIAL: 'RB DANTAS LTDA - MATRIZ',
  TIPO_VENDA: '1-VENDA',
  DATA_PEDIDO: '2026-07-17T03:00:00.000Z',
  HORA: 17,
  MINUTO: 10,
  POSICAO_PEDIDO: 'FATURADO',
  CODIGO_CLIENTE: 331,
  NOME_CLIENTE: 'GILMARIO FREITAS SOUZA',
  CODIGO_RCA: 57,
  NOME_RCA: 'JOSE ORLANO DA SILVA',
  CODIGO_EMITENTE: 83,
  NOME_EMITENTE: 'JOSE ORLANO DA SILVA',
  VALOR_PEDIDO: 595,
  VALOR_ATENDIDO: 595,
  CUSTO_FINANCEIRO: 339.79,
  PERCENTUAL_LUCRO: 42.89,
  ...over,
});

const JANELA = { dataInicio: '2026-07-01', dataFim: '2026-07-31' };
const AGORA_FRIO = new Date('2026-09-15T15:00:00.000Z');
const AGORA_QUENTE = new Date('2026-07-20T15:00:00.000Z');

describe('VendasStoreService', () => {
  let dir: string;
  let meta: VendasMetaDbService;
  let fato: VendasFatoDbService;
  let store: VendasStoreService;
  let instanciaId: number;
  const dataDirOriginal = process.env.WTA_DATA_DIR;
  let cfg = configTeste();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-store-'));
    process.env.WTA_DATA_DIR = dir;
    cfg = configTeste();
    const servico = { getConfig: () => cfg } as never;
    meta = new VendasMetaDbService(servico);
    fato = new VendasFatoDbService(meta);
    await fato.pronto();
    store = new VendasStoreService(meta, fato);
    instanciaId = meta.instanciaId()!;
  });

  afterEach(async () => {
    meta.fechar();
    await fato.fechar();
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  const abrir = (filial = '1', periodo = '3') =>
    store.abrirLote({
      instanciaId,
      codigoFilial: filial,
      periodo,
      posicaoPedido: '0',
      margemMinLucro: '100',
      janela: JANELA,
    });

  const contarMeta = (sql: string, ...p: unknown[]) =>
    (
      meta
        .banco()
        .prepare(sql)
        .get(...(p as never[])) as { c: number }
    ).c;

  const contarPedidos = async () => fato.contarPedidos(instanciaId);

  const lerPedido = async () => {
    const conn = await fato.conexao();
    const linhas = await consultar<Record<string, unknown>>(
      conn,
      `SELECT CAST(dia AS VARCHAR) AS dia, numero_pedido, valor_pedido,
              custo_financeiro, posicao_pedido
         FROM pedido LIMIT 1`,
    );
    return linhas[0];
  };

  describe('gravação de página', () => {
    it('deriva o dia do pedido e grava no DuckDB com dims no SQLite', async () => {
      const lote = abrir();
      await expect(
        store.gravarPagina(lote, [pedido()], 2),
      ).resolves.toMatchObject({ gravados: 1, semDia: 0 });

      const linha = await lerPedido();
      expect(linha).toMatchObject({
        dia: '2026-07-17',
        numero_pedido: '57003983',
        valor_pedido: 595,
        custo_financeiro: 339.79,
      });
      expect(
        meta
          .banco()
          .prepare('SELECT codigo FROM dim_cliente WHERE instancia_id = ?')
          .get(instanciaId),
      ).toMatchObject({ codigo: '331' });
    });

    it('o mesmo número em filiais diferentes são dois pedidos', async () => {
      await store.gravarPagina(abrir('1'), [pedido()], 2);
      await store.gravarPagina(abrir('2'), [pedido({ CODIGO_FILIAL: '2' })], 2);
      expect(await contarPedidos()).toBe(2);
    });

    it('revarrer o mesmo pedido atualiza em vez de duplicar', async () => {
      await store.gravarPagina(
        abrir(),
        [pedido({ POSICAO_PEDIDO: 'PENDENTE' })],
        2,
      );
      await store.gravarPagina(
        abrir(),
        [pedido({ POSICAO_PEDIDO: 'FATURADO', VALOR_PEDIDO: 610 })],
        2,
      );
      expect(await contarPedidos()).toBe(1);
      const linha = await lerPedido();
      expect(linha).toMatchObject({
        posicao_pedido: 'FATURADO',
        valor_pedido: 610,
      });
    });

    it('linha sem número ou sem data não é gravada', async () => {
      const r = await store.gravarPagina(
        abrir(),
        [pedido({ DATA_PEDIDO: null }), pedido({ NUMERO_PEDIDO: null })],
        2,
      );
      expect(r).toMatchObject({ gravados: 0, semDia: 2 });
      expect(await contarPedidos()).toBe(0);
    });

    it('custo em formato pt-BR vira NULL', async () => {
      await store.gravarPagina(
        abrir(),
        [pedido({ CUSTO_FINANCEIRO: '600.793,14' })],
        2,
      );
      const linha = await lerPedido();
      expect(linha.custo_financeiro).toBeNull();
    });
  });

  describe('fechamento do lote', () => {
    it('lote completo publica cobertura de todos os dias', async () => {
      const lote = abrir();
      await store.gravarPagina(lote, [pedido()], 2);
      const r = await store.fecharLote(lote, {
        estado: 'completo',
        paginas: 1,
        totalUpstream: 1,
        valorUpstream: 595,
        agora: AGORA_FRIO,
      });

      expect(r.confere).toBe(true);
      expect(r.diasCobertos).toBe(31);
      expect(contarMeta('SELECT COUNT(*) c FROM cobertura')).toBe(31);
    });

    it('varre a sobra na varredura completa', async () => {
      const primeiro = abrir();
      await store.gravarPagina(
        primeiro,
        [pedido(), pedido({ NUMERO_PEDIDO: 999, VALOR_PEDIDO: 100 })],
        2,
      );
      await store.fecharLote(primeiro, {
        estado: 'completo',
        paginas: 1,
        valorUpstream: 695,
        agora: AGORA_FRIO,
      });

      const segundo = abrir();
      await store.gravarPagina(segundo, [pedido()], 2);
      await store.fecharLote(segundo, {
        estado: 'completo',
        paginas: 1,
        valorUpstream: 595,
        agora: AGORA_FRIO,
      });

      expect(await contarPedidos()).toBe(1);
    });

    it('lote parcial não publica cobertura', async () => {
      const lote = abrir();
      await store.gravarPagina(lote, [pedido()], 2);
      const r = await store.fecharLote(lote, {
        estado: 'parcial',
        paginas: 1,
        motivo: 'incompleto',
        agora: AGORA_FRIO,
      });
      expect(r.diasCobertos).toBe(0);
      expect(contarMeta('SELECT COUNT(*) c FROM cobertura')).toBe(0);
    });

    it('conferência reprovada não publica cobertura', async () => {
      const lote = abrir();
      await store.gravarPagina(lote, [pedido()], 2);
      const r = await store.fecharLote(lote, {
        estado: 'completo',
        paginas: 1,
        valorUpstream: 1000,
        agora: AGORA_FRIO,
      });
      expect(r.confere).toBe(false);
      expect(contarMeta('SELECT COUNT(*) c FROM cobertura')).toBe(0);
    });
  });

  it('aprende o mapa de posição do ERP', () => {
    store.aprenderPosicoes(instanciaId, { '4': 'FATURADO', '2': 'PENDENTE' });
    expect(
      meta
        .banco()
        .prepare(
          'SELECT rotulo FROM dim_posicao WHERE instancia_id = ? AND codigo = ?',
        )
        .get(instanciaId, '4'),
    ).toMatchObject({ rotulo: 'FATURADO' });
  });
});
