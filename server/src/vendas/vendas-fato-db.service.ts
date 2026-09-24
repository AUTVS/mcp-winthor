import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { DuckDBInstance } from '@duckdb/node-api';
import { dataDir } from '../config/data-dir';
import { abrirDuckDB, consultarUm, executar, FatoConn } from './duckdb';
import { DDL_FATO, FATO_SCHEMA_VERSION } from './schema-fato';
import { ARQUIVO_FATO } from './vendas-arquivos';
import { migrarSeNecessario } from './vendas-migracao';
import { VendasMetaDbService } from './vendas-meta-db.service';

export { ARQUIVO_FATO } from './vendas-arquivos';

@Injectable()
export class VendasFatoDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VendasFatoDbService.name);
  private readonly caminho = join(dataDir(), ARQUIVO_FATO);
  private instance?: DuckDBInstance;
  private conn?: FatoConn;
  private ready?: Promise<void>;

  constructor(private readonly metaService: VendasMetaDbService) {}

  onModuleInit(): void {
    this.ready = this.inicializar();
  }

  async pronto(): Promise<void> {
    await this.inicializar();
  }

  private async inicializar(): Promise<void> {
    if (this.conn) return;
    if (!this.ready) this.ready = this.abrir();
    await this.ready;
  }

  private async abrir(): Promise<void> {
    mkdirSync(dataDir(), { recursive: true });

    const migracao = await migrarSeNecessario(this.metaService, this);
    if (migracao && !migracao.ok) {
      this.logger.warn(
        `migração automática falhou (${migracao.motivo}); bases serão recriadas vazias.`,
      );
    }

    const { instance, conn } = await abrirDuckDB(this.caminho);
    this.instance = instance;
    this.conn = conn;

    const versao = (await this.lerVersao()) ?? 0;
    if (versao > FATO_SCHEMA_VERSION) {
      await this.fechar();
      const arquivado = `${this.caminho}.incompativel-${Date.now()}`;
      renameSync(this.caminho, arquivado);
      this.logger.warn(
        `fato na versão ${versao} (esta build entende ${FATO_SCHEMA_VERSION}); ` +
          `arquivado em ${arquivado} e recriado vazio.`,
      );
      const reaberto = await abrirDuckDB(this.caminho);
      this.instance = reaberto.instance;
      this.conn = reaberto.conn;
      await this.criarDoZero();
      return;
    }

    if (versao === 0) {
      await this.criarDoZero();
    }
  }

  async conexao(): Promise<FatoConn> {
    await this.inicializar();
    return this.conn!;
  }

  caminhoArquivo(): string {
    return this.caminho;
  }

  async versaoEsquema(): Promise<number> {
    await this.inicializar();
    return (await this.lerVersao()) ?? 0;
  }

  async integridade(): Promise<'ok' | 'corrompido' | 'ausente'> {
    if (!existsSync(this.caminho)) return 'ausente';
    try {
      await this.inicializar();
      await consultarUm(this.conn!, 'SELECT COUNT(*) AS c FROM pedido');
      return 'ok';
    } catch {
      return 'corrompido';
    }
  }

  async contarPedidos(instanciaId?: number): Promise<number> {
    await this.inicializar();
    const sql = instanciaId
      ? 'SELECT COUNT(*) AS c FROM pedido WHERE instancia_id = ?'
      : 'SELECT COUNT(*) AS c FROM pedido';
    const r = await consultarUm<{ c: number }>(
      this.conn!,
      sql,
      instanciaId ? [instanciaId] : [],
    );
    return Number(r?.c ?? 0);
  }

  onModuleDestroy(): void {
    void this.fechar();
  }

  async fechar(): Promise<void> {
    this.conn = undefined;
    this.instance = undefined;
    this.ready = undefined;
  }

  private async criarDoZero(): Promise<void> {
    await executar(this.conn!, DDL_FATO);
    await executar(
      this.conn!,
      `DELETE FROM _schema_version; INSERT INTO _schema_version VALUES (${FATO_SCHEMA_VERSION})`,
    );
  }

  private async lerVersao(): Promise<number | null> {
    try {
      const r = await consultarUm<{ version: number }>(
        this.conn!,
        'SELECT version FROM _schema_version LIMIT 1',
      );
      return r ? Number(r.version) : null;
    } catch {
      return null;
    }
  }

  existeArquivo(): boolean {
    return existsSync(this.caminho);
  }
}
