import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diasEntre, janelaFria, janelaQuente } from './periodo-janela';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasIngestaoService } from './vendas-ingestao.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { VendasStoreService } from './vendas-store.service';
import {
  MesCache,
  VendasUiController,
  ZonaCache,
} from './vendas-ui.controller';
import { configTeste } from './vendas-test-helpers';

/** Meio-dia de 15/07/2026 em São Paulo — longe de qualquer borda de fuso. */
const FIXO = new Date('2026-07-15T15:00:00.000Z');

/** Congela o relógio do endpoint sem tocar em timers globais (DuckDB usa timers). */
class ControllerTeste extends VendasUiController {
  protected agora(): Date {
    return FIXO;
  }
}

interface ResMock {
  statusCode: number;
  body: unknown;
  status: (code: number) => ResMock;
  json: (body: unknown) => ResMock;
}

/** Arrow em vez de método abreviado: `this` implícito não tem tipo aqui. */
function resMock(): ResMock {
  const res: ResMock = {
    statusCode: 200,
    body: undefined,
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
    json: (body: unknown) => {
      res.body = body;
      return res;
    },
  };
  return res;
}

interface CorpoStatus {
  ok: boolean;
  hoje: string;
  pedidos: number;
  filiais: { esperadas: string[]; cobertas: string[]; fonte: string };
  zonas: ZonaCache[];
  meses: MesCache[];
}

describe('VendasUiController', () => {
  let dir: string;
  let meta: VendasMetaDbService;
  let fato: VendasFatoDbService;
  let store: VendasStoreService;
  let controller: VendasUiController;
  let ingestao: {
    status: jest.Mock;
    sincronizar: jest.Mock;
    cancelar: jest.Mock;
  };
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-ui-'));
    process.env.WTA_DATA_DIR = dir;
    const servico = {
      getConfig: () => configTeste(),
      isConfigured: () => true,
    } as never;
    meta = new VendasMetaDbService(servico);
    fato = new VendasFatoDbService(meta);
    await fato.pronto();
    store = new VendasStoreService(meta, fato);
    ingestao = {
      status: jest.fn().mockReturnValue({
        rodando: false,
        itensTotal: 0,
        itensConcluidos: 0,
        paginas: 0,
        linhas: 0,
        erros: [],
        cancelado: false,
      }),
      sincronizar: jest.fn().mockReturnValue({ aceito: true }),
      cancelar: jest.fn(),
    };
    controller = new ControllerTeste(
      servico,
      meta,
      fato,
      store,
      ingestao as unknown as VendasIngestaoService,
    );
  });

  afterEach(async () => {
    meta.fechar();
    await fato.fechar();
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  const instanciaId = () => {
    const id = meta.instanciaId();
    if (id === null) throw new Error('instância não criada');
    return id;
  };

  /** Varre uma filial cobrindo a janela inteira. */
  const cobrir = async (
    filial: string,
    janela: { dataInicio: string; dataFim: string },
  ) => {
    const lote = store.abrirLote({
      instanciaId: instanciaId(),
      codigoFilial: filial,
      periodo: '3',
      posicaoPedido: '0',
      margemMinLucro: '100',
      janela,
    });
    await store.fecharLote(lote, {
      estado: 'completo',
      paginas: 1,
      agora: FIXO,
    });
  };

  const status = async (): Promise<CorpoStatus> => {
    const res = resMock();
    await controller.status(res as never);
    return res.body as CorpoStatus;
  };

  const zona = (body: CorpoStatus, escopo: string) => {
    const z = body.zonas.find((x) => x.escopo === escopo);
    if (!z) throw new Error(`zona ${escopo} ausente`);
    return z;
  };

  it('expõe duas zonas disjuntas, na ordem dos botões', async () => {
    const body = await status();

    expect(body.ok).toBe(true);
    expect(body.hoje).toBe('2026-07-15');
    expect(body.zonas.map((z) => z.escopo)).toEqual([
      'atualizacao',
      'historico',
    ]);

    const quente = zona(body, 'atualizacao');
    const fria = zona(body, 'historico');
    expect(quente.dataInicio).toBe('2026-06-01');
    expect(quente.dataFim).toBe('2026-07-15');
    expect(fria.dataInicio).toBe('2025-01-01');
    expect(fria.dataFim).toBe('2026-05-31');
    // Sem sobreposição: o fim da fria é a véspera do início da quente.
    expect(fria.dataFim < quente.dataInicio).toBe(true);
  });

  it('base vazia: tudo vazio e a expectativa é inferida, não afirmada', async () => {
    const body = await status();

    expect(body.zonas.every((z) => z.estado === 'vazio')).toBe(true);
    expect(body.filiais.esperadas).toEqual([]);
    expect(body.filiais.fonte).toBe('cobertura');
    expect(body.pedidos).toBe(0);
  });

  it('uma filial de duas cobertas deixa a zona PARCIAL, não completa', async () => {
    // Este é o bug que motivou o refactor: o endpoint antigo contava
    // `COUNT(DISTINCT dia)` sem filial e devolvia "Cacheado" aqui, enquanto
    // VendasQueryService recusava a mesma janela por exigir dias × filiais.
    store.registrarFiliaisAlvo(instanciaId(), ['1', '2'], FIXO);
    await cobrir('1', janelaQuente(FIXO));

    const quente = zona(await status(), 'atualizacao');

    expect(quente.estado).toBe('parcial');
    expect(quente.diasCobertos).toBe(0);
    expect(quente.paresCobertos).toBe(quente.paresEsperados / 2);
    expect(quente.faltantesTotal).toBe(quente.diasEsperados);
  });

  it('as duas filiais cobertas fecham a zona', async () => {
    store.registrarFiliaisAlvo(instanciaId(), ['1', '2'], FIXO);
    await cobrir('1', janelaQuente(FIXO));
    await cobrir('2', janelaQuente(FIXO));

    const body = await status();
    const quente = zona(body, 'atualizacao');

    expect(quente.estado).toBe('completo');
    expect(quente.diasCobertos).toBe(quente.diasEsperados);
    expect(quente.paresCobertos).toBe(quente.paresEsperados);
    expect(quente.faltantesTotal).toBe(0);
    expect(quente.diasFaltantes).toEqual([]);
    expect(body.filiais.esperadas).toEqual(['1', '2']);
    expect(body.filiais.fonte).toBe('sync');
    expect(body.filiais.cobertas).toEqual(['1', '2']);
  });

  it('trunca a lista de dias faltantes mas preserva o total', async () => {
    // A zona fria vazia tem ~500 dias faltando; despejar isso num poll de 1,5 s
    // seria pagar banda por informação que o painel não usa.
    store.registrarFiliaisAlvo(instanciaId(), ['1'], FIXO);

    const fria = zona(await status(), 'historico');
    const esperados = diasEntre(
      janelaFria(FIXO).dataInicio,
      janelaFria(FIXO).dataFim,
    ).length;

    expect(fria.faltantesTotal).toBe(esperados);
    expect(fria.diasFaltantes.length).toBe(10);
    expect(fria.diasFaltantes[0]).toBe('2025-01-01');
  });

  it('a régua mensal soma exatamente as duas zonas', async () => {
    store.registrarFiliaisAlvo(instanciaId(), ['1'], FIXO);
    await cobrir('1', janelaQuente(FIXO));

    const body = await status();
    const somaMeses = body.meses.reduce((t, m) => t + m.diasEsperados, 0);
    const somaZonas = body.zonas.reduce((t, z) => t + z.diasEsperados, 0);

    // Se as zonas se sobrepusessem — como os quatro cards antigos —, estes dois
    // números divergiriam. É a asserção que trava a partição.
    expect(somaMeses).toBe(somaZonas);
  });

  it('classifica cada mês na zona a que pertence', async () => {
    store.registrarFiliaisAlvo(instanciaId(), ['1'], FIXO);
    await cobrir('1', janelaQuente(FIXO));

    const body = await status();
    const porMes = new Map(body.meses.map((m) => [m.mes, m]));

    expect(porMes.get('2026-07')?.zona).toBe('atualizacao');
    expect(porMes.get('2026-06')?.zona).toBe('atualizacao');
    expect(porMes.get('2026-05')?.zona).toBe('historico');
    expect(porMes.get('2025-01')?.zona).toBe('historico');

    // Julho está coberto até o dia 15, que é "hoje": mês corrente fecha em 15/15.
    expect(porMes.get('2026-07')).toMatchObject({
      diasEsperados: 15,
      diasCobertos: 15,
    });
  });

  describe('POST /vendas/sincronizar', () => {
    it('dispara atualização sem filiais', () => {
      const res = resMock();
      controller.sincronizar({ escopo: 'atualizacao' }, res as never);

      expect(ingestao.sincronizar).toHaveBeenCalledWith({
        escopo: 'atualizacao',
      });
      expect(res.statusCode).toBe(200);
      expect((res.body as { ok: boolean }).ok).toBe(true);
    });

    it('aceita filiais e coage número para string (paridade com o MCP)', () => {
      const res = resMock();
      controller.sincronizar(
        { escopo: 'historico', filiais: [1, '2'] as never },
        res as never,
      );

      expect(ingestao.sincronizar).toHaveBeenCalledWith({
        escopo: 'historico',
        filiais: ['1', '2'],
      });
      expect((res.body as { filiais: string[] }).filiais).toEqual(['1', '2']);
    });

    it('aceita filial escalar', () => {
      const res = resMock();
      controller.sincronizar({ filiais: '3' }, res as never);
      expect(ingestao.sincronizar).toHaveBeenCalledWith({
        escopo: 'atualizacao',
        filiais: ['3'],
      });
    });

    it('responde 409 quando já há sincronização em curso', () => {
      ingestao.sincronizar.mockReturnValue({
        aceito: false,
        motivo: 'já existe uma sincronização em curso',
      });

      const res = resMock();
      controller.sincronizar({ escopo: 'atualizacao' }, res as never);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({
        ok: false,
        message: 'já existe uma sincronização em curso',
      });
    });

    it('cancelar não dispara varredura', () => {
      const res = resMock();
      controller.sincronizar({ cancelar: true }, res as never);

      expect(ingestao.cancelar).toHaveBeenCalled();
      expect(ingestao.sincronizar).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });
  });
});
