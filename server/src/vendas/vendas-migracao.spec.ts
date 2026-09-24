import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DDL_V1, SCHEMA_V1_VERSION } from './schema-v1';
import { abrirBanco } from './sqlite';
import { VendasFatoDbService } from './vendas-fato-db.service';
import { VendasMetaDbService } from './vendas-meta-db.service';
import { configTeste } from './vendas-test-helpers';

describe('migração v1→v2', () => {
  let dir: string;
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-migracao-'));
    process.env.WTA_DATA_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  function criarLegadoV1(): void {
    const agora = '2026-07-27T12:00:00.000Z';
    const legadoPath = join(dir, 'vendas.db');
    const legado = abrirBanco(legadoPath);
    legado.exec(DDL_V1);
    legado.exec(`PRAGMA user_version = ${SCHEMA_V1_VERSION}`);
    legado
      .prepare(
        `INSERT INTO instancia (chave, base_url, login, criada_em, vista_em)
       VALUES ('k','u','l',?,?)`,
      )
      .run(agora, agora);
    legado
      .prepare(
        `INSERT INTO lote (instancia_id, codigo_filial, periodo, posicao_pedido,
                         margem_min_lucro, dia_inicio, dia_fim, iniciado_em, estado)
       VALUES (1,'1','3','0','100','2026-07-01','2026-07-31',?,'em_andamento')`,
      )
      .run(agora);
    legado
      .prepare(
        `INSERT INTO pedido (instancia_id, codigo_filial, numero_pedido, dia,
                           data_pedido, valor_pedido, lote_id, ingerido_em,
                           codigo_cliente, nome_cliente, nome_filial)
       VALUES (1,'1','100','2026-07-10','2026-07-10T03:00:00Z',500,1,?,
               '331','GIL','MATRIZ')`,
      )
      .run(agora);
    legado.close();
  }

  it('migra vendas.db legado para meta + fato', async () => {
    criarLegadoV1();

    const servico = { getConfig: () => configTeste() } as never;
    const meta = new VendasMetaDbService(servico);
    const fato = new VendasFatoDbService(meta);
    await fato.pronto();

    expect(existsSync(join(dir, 'vendas-meta.db'))).toBe(true);
    expect(existsSync(join(dir, 'vendas-fato.duckdb'))).toBe(true);
    expect(await fato.contarPedidos(1)).toBe(1);
    expect(
      readdirSync(dir).some((f) => f.startsWith('vendas.db.migrado-')),
    ).toBe(true);

    meta.fechar();
    await fato.fechar();
  });
});
