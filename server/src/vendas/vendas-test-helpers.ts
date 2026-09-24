import { WtConfig } from '../config/config.schema';
import { WtConfigService } from '../config/wt-config.service';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { VendasQueryService } from './vendas-query.service';
import { VendasStoreService } from './vendas-store.service';

export const configTeste = (over: Partial<WtConfig> = {}): WtConfig => ({
  winthorBaseUrl: 'http://winthor.local:8181',
  login: 'DEMO',
  senhaMd5: 'X',
  configuredAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

export interface BasesVendasTeste {
  meta: VendasMetaDbService;
  fato: VendasFatoDbService;
  store: VendasStoreService;
  query: VendasQueryService;
  instanciaId: number;
  fechar: () => Promise<void>;
}

export async function criarBasesTeste(
  cfg: WtConfig | null = configTeste(),
): Promise<BasesVendasTeste> {
  const servico = { getConfig: () => cfg } as unknown as WtConfigService;
  const meta = new VendasMetaDbService(servico);
  const fato = new VendasFatoDbService(meta);
  await fato.pronto();
  const store = new VendasStoreService(meta, fato);
  const query = new VendasQueryService(meta, fato);
  const instanciaId = meta.instanciaId();
  if (instanciaId === null) throw new Error('instância não criada nos testes');

  return {
    meta,
    fato,
    store,
    query,
    instanciaId,
    fechar: async () => {
      meta.fechar();
      await fato.fechar();
    },
  };
}

export async function contarPedidosFato(
  fato: VendasFatoDbService,
  instanciaId: number,
): Promise<number> {
  return fato.contarPedidos(instanciaId);
}
