import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WtConfig } from '../config/config.schema';
import { WtConfigService } from '../config/wt-config.service';
import { DDL_META, SCHEMA_VERSION } from './schema-meta';
import { abrirBanco } from './sqlite';
import { ARQUIVO_META, VendasMetaDbService } from './vendas-meta-db.service';
import { VendasFatoDbService } from './vendas-fato-db.service';

const config = (over: Partial<WtConfig> = {}): WtConfig => ({
  winthorBaseUrl: 'http://winthor.local:8181',
  login: 'DEMO',
  senhaMd5: 'X',
  configuredAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('VendasMetaDbService', () => {
  let dir: string;
  let servicos: VendasMetaDbService[];
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-vendas-'));
    process.env.WTA_DATA_DIR = dir;
    servicos = [];
  });

  afterEach(() => {
    for (const s of servicos) s.fechar();
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  const novo = (cfg: WtConfigService) => {
    const s = new VendasMetaDbService(cfg);
    servicos.push(s);
    return s;
  };

  it('cria vendas-meta.db no WTA_DATA_DIR', () => {
    const db = novo(configStub().servico);
    db.banco();
    expect(readdirSync(dir)).toContain(ARQUIVO_META);
  });

  it('nasce na versão corrente', () => {
    const primeiro = novo(configStub().servico);
    const versao = primeiro.banco().prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    expect(versao.user_version).toBe(SCHEMA_VERSION);
  });

  it('a mesma instalação reusa a mesma instância', () => {
    const primeiro = novo(configStub().servico);
    const id = primeiro.instanciaId();
    primeiro.fechar();
    expect(novo(configStub().servico).instanciaId()).toBe(id);
  });

  it('sem configuração não há instância', () => {
    expect(novo(configStub(null).servico).instanciaId()).toBeNull();
  });
});

function configStub(inicial: WtConfig | null = config()) {
  let atual = inicial;
  return {
    servico: { getConfig: () => atual } as unknown as WtConfigService,
    trocar: (novo: WtConfig | null) => {
      atual = novo;
    },
  };
}

describe('migração de esquema meta', () => {
  let dir: string;
  let caminho: string;
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-migracao-'));
    process.env.WTA_DATA_DIR = dir;
    caminho = join(dir, ARQUIVO_META);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  /**
   * Fabrica um banco na v2 a partir do DDL corrente, removendo o que a v3 trouxe.
   *
   * Derivar da v3 em vez de manter uma cópia literal do DDL antigo: a cópia
   * envelheceria em silêncio e o teste passaria a migrar um esquema que nunca
   * existiu — que é exatamente o modo de falha que este teste existe para pegar.
   */
  const criarV2 = () => {
    const db = abrirBanco(caminho);
    db.exec(DDL_META);
    db.exec('DROP TABLE IF EXISTS filial_alvo');
    db.exec('DROP INDEX IF EXISTS ix_cobertura_dia');
    db.prepare(
      `INSERT INTO instancia (chave, base_url, login, criada_em, vista_em)
       VALUES ('k','http://winthor.local:8181','DEMO','t','t')`,
    ).run();
    db.exec('PRAGMA user_version = 2');
    db.close();
  };

  const abrirServico = () => {
    const s = new VendasMetaDbService({
      getConfig: () => config(),
    } as unknown as WtConfigService);
    return s;
  };

  it('migra v2 para a versão corrente sem perder dado', () => {
    // Esta é a primeira migração que o projeto executa — MIGRACOES estava vazio.
    // O que não pode acontecer é o banco do usuário ser arquivado como `.falhou-*`
    // e recriado vazio na primeira subida da build nova.
    criarV2();
    const servico = abrirServico();
    const db = servico.banco();

    const versao = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    expect(versao.user_version).toBe(SCHEMA_VERSION);

    const instancias = db
      .prepare('SELECT COUNT(*) AS n FROM instancia')
      .get() as { n: number };
    expect(instancias.n).toBe(1);

    expect(readdirSync(dir).filter((f) => f.includes('.falhou-'))).toEqual([]);
    servico.fechar();
  });

  it('cria filial_alvo e o índice de cobertura por dia', () => {
    criarV2();
    const servico = abrirServico();
    const db = servico.banco();

    const tabela = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'filial_alvo'`)
      .get() as { name: string } | undefined;
    expect(tabela?.name).toBe('filial_alvo');

    const indice = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'ix_cobertura_dia'`)
      .get() as { name: string } | undefined;
    expect(indice?.name).toBe('ix_cobertura_dia');

    servico.fechar();
  });

  it('é idempotente: reabrir na versão corrente não remigra', () => {
    criarV2();
    const primeiro = abrirServico();
    primeiro.banco();
    primeiro.fechar();

    const segundo = abrirServico();
    const versao = segundo.banco().prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    expect(versao.user_version).toBe(SCHEMA_VERSION);
    expect(readdirSync(dir).filter((f) => f.includes('.falhou-'))).toEqual([]);
    segundo.fechar();
  });

  it('banco novo já nasce com filial_alvo', () => {
    // O DDL inicial e o corpo da migração saem da mesma constante; se alguém
    // adicionar tabela só na migração, este teste cai.
    const servico = abrirServico();
    const tabela = servico
      .banco()
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'filial_alvo'`)
      .get() as { name: string } | undefined;
    expect(tabela?.name).toBe('filial_alvo');
    servico.fechar();
  });
});

describe('esquema meta', () => {
  it('cria tabelas de dimensão', () => {
    const db = abrirBanco(':memory:');
    db.exec(DDL_META);
    db.prepare(
      `INSERT INTO instancia (chave, base_url, login, criada_em, vista_em)
       VALUES ('k','u','l','t','t')`,
    ).run();
    db.prepare(
      `INSERT INTO dim_cliente (instancia_id, codigo, nome, atualizado_em)
       VALUES (1,'331','GIL','t')`,
    ).run();
    expect(
      (
        db
          .prepare('SELECT nome FROM dim_cliente WHERE codigo = ?')
          .get('331') as { nome: string }
      ).nome,
    ).toBe('GIL');
    db.close();
  });
});

describe('VendasFatoDbService', () => {
  let dir: string;
  const dataDirOriginal = process.env.WTA_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wtai-fato-'));
    process.env.WTA_DATA_DIR = dir;
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    if (dataDirOriginal === undefined) delete process.env.WTA_DATA_DIR;
    else process.env.WTA_DATA_DIR = dataDirOriginal;
  });

  it('cria vendas-fato.duckdb', async () => {
    const meta = new VendasMetaDbService({
      getConfig: () => config(),
    } as unknown as WtConfigService);
    const fato = new VendasFatoDbService(meta);
    await fato.pronto();
    expect(readdirSync(dir)).toContain('vendas-fato.duckdb');
    meta.fechar();
    await fato.fechar();
  });
});
