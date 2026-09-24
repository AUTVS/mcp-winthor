import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WtConfig } from '../config/config.schema';
import { WtConfigService } from '../config/wt-config.service';
import { WinthorApiService } from '../winthor/winthor-api.service';
import { WinthorMobileService } from '../winthor/winthor-mobile.service';
import { EstoqueFatoDbService } from './estoque-fato-db.service';
import { EstoqueIngestaoService } from './estoque-ingestao.service';
import { EstoqueMetaDbService } from './estoque-meta-db.service';
import { EstoqueStoreService } from './estoque-store.service';

const config: WtConfig = {
  winthorBaseUrl: 'http://winthor.local:8181',
  login: 'DEMO',
  senhaMd5: 'X',
  configuredAt: '2026-01-01T00:00:00.000Z',
};

describe('EstoqueIngestaoService', () => {
  let dir: string;
  let meta: EstoqueMetaDbService;
  let fato: EstoqueFatoDbService;
  let store: EstoqueStoreService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-estoque-ing-'));
    process.env.WTA_DATA_DIR = dir;
    const servicoCfg = {
      getConfig: () => config,
    } as unknown as WtConfigService;
    meta = new EstoqueMetaDbService(servicoCfg);
    fato = new EstoqueFatoDbService();
    await fato.pronto();
    store = new EstoqueStoreService(meta, fato);
  });

  afterEach(async () => {
    meta.fechar();
    await fato.fechar();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sincroniza uma filial página a página', async () => {
    const api = {
      buscarEstoquePorFilial: jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: {
            items: [
              { produtoId: '10', descricao: 'Prod A', saldo: 5 },
              { produtoId: '20', descricao: 'Prod B', saldo: 3 },
              { produtoId: '30', descricao: 'Prod C', saldo: 1 },
            ],
            total: 3,
          },
        })
        .mockResolvedValue({ ok: true, status: 200, data: { items: [] } }),
    } as unknown as WinthorApiService;

    const mobile = {
      filiaisPadrao: jest.fn().mockResolvedValue(['1']),
    } as unknown as WinthorMobileService;

    const ingestao = new EstoqueIngestaoService(api, mobile, store, meta);
    EstoqueIngestaoService.semPausa(ingestao);

    const r = ingestao.sincronizar({ escopo: 'completo' });
    expect(r.aceito).toBe(true);
    await ingestao['fila'];

    expect(await fato.contarProdutos(meta.instanciaId()!)).toBe(3);
    expect(store.temCobertura(meta.instanciaId()!)).toBe(true);
  });
});
