import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../config/data-dir';
import { WtConfigService } from '../config/wt-config.service';
import { DDL_META, MIGRACOES, SCHEMA_VERSION } from './schema-meta';
import { abrirBanco, Db } from './sqlite';

import { ARQUIVO_META } from './vendas-arquivos';

export { ARQUIVO_META, ARQUIVO_LEGADO } from './vendas-arquivos';

@Injectable()
export class VendasMetaDbService implements OnModuleDestroy {
  private readonly logger = new Logger(VendasMetaDbService.name);
  private readonly caminho = join(dataDir(), ARQUIVO_META);
  private db?: Db;
  private instanciaCache?: { chave: string; id: number };

  constructor(private readonly configService: WtConfigService) {}

  static chaveInstancia(baseUrl: string, login: string): string {
    return createHash('sha256')
      .update(`${baseUrl}|${login}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
  }

  banco(): Db {
    if (this.db) return this.db;
    mkdirSync(dataDir(), { recursive: true });
    this.db = this.abrirEMigrar(this.caminho);
    return this.db;
  }

  instanciaId(): number | null {
    const cfg = this.configService.getConfig();
    if (!cfg) return null;

    const chave = VendasMetaDbService.chaveInstancia(
      cfg.winthorBaseUrl,
      cfg.login,
    );
    if (this.instanciaCache?.chave === chave) return this.instanciaCache.id;

    const db = this.banco();
    const agora = new Date().toISOString();

    db.prepare(
      `INSERT INTO instancia (chave, base_url, login, criada_em, vista_em)
            VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chave) DO UPDATE SET vista_em = excluded.vista_em`,
    ).run(chave, cfg.winthorBaseUrl, cfg.login, agora, agora);

    const linha = db
      .prepare(`SELECT id FROM instancia WHERE chave = ?`)
      .get(chave) as { id: number } | undefined;

    if (!linha) return null;
    this.instanciaCache = { chave, id: linha.id };
    return linha.id;
  }

  caminhoArquivo(): string {
    return this.caminho;
  }

  versaoEsquema(): number {
    const linha = this.banco().prepare('PRAGMA user_version').get() as {
      user_version?: number;
    };
    return linha.user_version ?? 0;
  }

  integridade(): 'ok' | 'corrompido' {
    try {
      const r = this.banco().prepare('PRAGMA integrity_check').get() as {
        integrity_check?: string;
      };
      return r.integrity_check === 'ok' ? 'ok' : 'corrompido';
    } catch {
      return 'corrompido';
    }
  }

  onModuleDestroy(): void {
    this.fechar();
  }

  fechar(): void {
    this.db?.close();
    this.db = undefined;
    this.instanciaCache = undefined;
  }

  private abrirEMigrar(caminho: string): Db {
    let db = abrirBanco(caminho);
    const versao = this.lerVersao(db);

    if (versao > SCHEMA_VERSION) {
      db.close();
      const arquivado = `${caminho}.incompativel-${Date.now()}`;
      renameSync(caminho, arquivado);
      this.logger.warn(
        `meta na versão ${versao} (esta build entende ${SCHEMA_VERSION}); ` +
          `arquivada em ${arquivado} e recriada vazia.`,
      );
      db = abrirBanco(caminho);
      return this.criarDoZero(db);
    }

    if (versao === 0) return this.criarDoZero(db);
    if (versao === SCHEMA_VERSION) return db;

    return this.aplicarMigracoes(db, versao, caminho);
  }

  criarDoZero(db: Db): Db {
    db.exec(DDL_META);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return db;
  }

  private aplicarMigracoes(db: Db, de: number, caminho: string): Db {
    try {
      db.exec('BEGIN');
      // Ordena em vez de confiar na ordem de declaração: migração aplicada fora de
      // ordem falha de um jeito silencioso e difícil de reproduzir.
      const pendentes = MIGRACOES.filter((m) => m.versao > de).sort(
        (a, b) => a.versao - b.versao,
      );
      for (const migracao of pendentes) {
        db.exec(migracao.sql);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
      this.logger.log(`meta migrada de ${de} para ${SCHEMA_VERSION}.`);
      return db;
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      const arquivado = `${caminho}.falhou-${Date.now()}`;
      renameSync(caminho, arquivado);
      this.logger.error(
        `migração meta de ${de} para ${SCHEMA_VERSION} falhou (${String(err)}); ` +
          `arquivada em ${arquivado} e recriada vazia.`,
      );
      return this.criarDoZero(abrirBanco(caminho));
    }
  }

  private lerVersao(db: Db): number {
    const linha = db.prepare('PRAGMA user_version').get() as
      { user_version?: number } | undefined;
    return linha?.user_version ?? 0;
  }

  existeArquivo(): boolean {
    return existsSync(this.caminho);
  }
}
