import { Logger } from '@nestjs/common';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../config/data-dir';
import { DDL_FATO, FATO_SCHEMA_VERSION } from './schema-fato';
import { DDL_META, SCHEMA_VERSION } from './schema-meta';
import { SCHEMA_V1_VERSION } from './schema-v1';
import {
  abrirDuckDB,
  consultarUm,
  executar,
  executarParams,
  FatoConn,
} from './duckdb';
import { abrirBanco, Db } from './sqlite';
import { ARQUIVO_FATO, ARQUIVO_LEGADO, ARQUIVO_META } from './vendas-arquivos';
import type { VendasFatoDbService } from './vendas-fato-db.service';
import type { VendasMetaDbService } from './vendas-meta-db.service';

const logger = new Logger('VendasMigracao');

export interface ResultadoMigracao {
  ok: boolean;
  motivo?: string;
  pedidos?: number;
}

/**
 * Detecta `vendas.db` v1 sem `vendas-meta.db` e migra para a arquitetura dual.
 * Falha na validação → retorna `{ ok: false }` para o caller disparar rebuild.
 */
export async function migrarSeNecessario(
  metaService: VendasMetaDbService,
  fatoService: VendasFatoDbService,
): Promise<ResultadoMigracao | null> {
  const dir = dataDir();
  const legado = join(dir, ARQUIVO_LEGADO);
  const meta = join(dir, ARQUIVO_META);

  if (!existsSync(legado) || existsSync(meta)) return null;

  logger.log('detectado vendas.db legado; iniciando migração v1→v2.');
  return migrarV1ParaV2(legado, metaService, fatoService);
}

async function migrarV1ParaV2(
  caminhoLegado: string,
  metaService: VendasMetaDbService,
  fatoService: VendasFatoDbService,
): Promise<ResultadoMigracao> {
  const legado = abrirBanco(caminhoLegado);
  try {
    const versao = (
      legado.prepare('PRAGMA user_version').get() as { user_version?: number }
    ).user_version;
    if (versao !== SCHEMA_V1_VERSION) {
      return { ok: false, motivo: `versão legada inesperada: ${versao}` };
    }

    metaService.banco();
    await fatoService.pronto();

    const meta = metaService.banco();
    const fato = await fatoService.conexao();

    copiarMetadados(legado, meta);
    const mapas = extrairDimensoes(legado, meta);
    const pedidos = await copiarFatos(legado, fato, mapas);

    const valido = await validarMigracaoAsync(legado, fato);
    if (!valido.ok) {
      logger.error(`validação da migração falhou: ${valido.motivo}`);
      metaService.fechar();
      await fatoService.fechar();
      return { ok: false, motivo: valido.motivo };
    }

    legado.close();
    const arquivado = `${caminhoLegado}.migrado-${Date.now()}`;
    renameSync(caminhoLegado, arquivado);
    logger.log(
      `migração v1→v2 concluída: ${pedidos} pedido(s); legado em ${arquivado}`,
    );
    return { ok: true, pedidos };
  } catch (err) {
    logger.error(`migração v1→v2 falhou: ${String(err)}`);
    return { ok: false, motivo: String(err) };
  } finally {
    try {
      legado.close();
    } catch {
      /* já fechado */
    }
  }
}

function copiarMetadados(legado: Db, meta: Db): void {
  meta.exec(DDL_META);
  meta.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  for (const tabela of [
    'instancia',
    'lote',
    'cobertura',
    'ancora',
    'dim_posicao',
  ] as const) {
    const linhas = legado.prepare(`SELECT * FROM ${tabela}`).all() as Record<
      string,
      unknown
    >[];
    if (!linhas.length) continue;
    const cols = Object.keys(linhas[0]);
    const placeholders = cols.map(() => '?').join(',');
    const inserir = meta.prepare(
      `INSERT INTO ${tabela} (${cols.join(',')}) VALUES (${placeholders})`,
    );
    meta.exec('BEGIN');
    try {
      for (const linha of linhas) {
        inserir.run(...cols.map((c) => linha[c] as string | number | null));
      }
      meta.exec('COMMIT');
    } catch (err) {
      meta.exec('ROLLBACK');
      throw err;
    }
  }
}

interface MapasDim {
  filial: Map<string, number>;
  cliente: Map<string, number>;
  rca: Map<string, number>;
  emitente: Map<string, number>;
}

function extrairDimensoes(legado: Db, meta: Db): MapasDim {
  const agora = new Date().toISOString();
  const mapas: MapasDim = {
    filial: new Map(),
    cliente: new Map(),
    rca: new Map(),
    emitente: new Map(),
  };

  const dims: {
    tabela: keyof MapasDim;
    codigo: string;
    nome: string;
    instancia: string;
  }[] = [
    {
      tabela: 'filial',
      codigo: 'codigo_filial',
      nome: 'nome_filial',
      instancia: 'instancia_id',
    },
    {
      tabela: 'cliente',
      codigo: 'codigo_cliente',
      nome: 'nome_cliente',
      instancia: 'instancia_id',
    },
    {
      tabela: 'rca',
      codigo: 'codigo_rca',
      nome: 'nome_rca',
      instancia: 'instancia_id',
    },
    {
      tabela: 'emitente',
      codigo: 'codigo_emitente',
      nome: 'nome_emitente',
      instancia: 'instancia_id',
    },
  ];

  for (const dim of dims) {
    const tabela = `dim_${dim.tabela}`;
    const linhas = legado
      .prepare(
        `SELECT DISTINCT ${dim.instancia} AS instancia_id,
                ${dim.codigo} AS codigo, ${dim.nome} AS nome
           FROM pedido
          WHERE ${dim.codigo} IS NOT NULL`,
      )
      .all() as { instancia_id: number; codigo: string; nome: string | null }[];

    const inserir = meta.prepare(
      `INSERT INTO ${tabela} (instancia_id, codigo, nome, atualizado_em)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(instancia_id, codigo) DO UPDATE SET
         nome = COALESCE(excluded.nome, ${tabela}.nome),
         atualizado_em = excluded.atualizado_em`,
    );

    for (const linha of linhas) {
      inserir.run(linha.instancia_id, String(linha.codigo), linha.nome, agora);
      const id = (
        meta
          .prepare(
            `SELECT id FROM ${tabela} WHERE instancia_id = ? AND codigo = ?`,
          )
          .get(linha.instancia_id, String(linha.codigo)) as { id: number }
      ).id;
      mapas[dim.tabela].set(
        `${linha.instancia_id}|${String(linha.codigo)}`,
        id,
      );
    }
  }

  return mapas;
}

async function copiarFatos(
  legado: Db,
  fato: FatoConn,
  mapas: MapasDim,
): Promise<number> {
  await executar(fato, DDL_FATO);
  await executar(
    fato,
    `INSERT INTO _schema_version VALUES (${FATO_SCHEMA_VERSION})`,
  );

  const pedidos = legado
    .prepare(
      'SELECT * FROM pedido ORDER BY instancia_id, codigo_filial, numero_pedido',
    )
    .all() as Record<string, unknown>[];

  const sql = `INSERT OR REPLACE INTO pedido (
    instancia_id, codigo_filial, numero_pedido, dia, data_pedido, hora, minuto,
    posicao_pedido, tipo_venda, dim_filial_id, dim_cliente_id, dim_rca_id,
    dim_emitente_id, codigo_cobranca, numero_nota, valor_pedido, valor_atendido,
    custo_financeiro, percentual_lucro, lote_id, ingerido_em
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  for (const p of pedidos) {
    const inst = p.instancia_id as number;
    const filial = String(p.codigo_filial);
    const dimFilial = mapas.filial.get(`${inst}|${filial}`);
    if (dimFilial === undefined) continue;

    const dimCliente = p.codigo_cliente
      ? mapas.cliente.get(`${inst}|${String(p.codigo_cliente)}`)
      : null;
    const dimRca = p.codigo_rca
      ? mapas.rca.get(`${inst}|${String(p.codigo_rca)}`)
      : null;
    const dimEmitente = p.codigo_emitente
      ? mapas.emitente.get(`${inst}|${String(p.codigo_emitente)}`)
      : null;

    await executarParams(fato, sql, [
      inst,
      filial,
      String(p.numero_pedido),
      String(p.dia),
      String(p.data_pedido),
      p.hora as number | null,
      p.minuto as number | null,
      p.posicao_pedido as string | null,
      p.tipo_venda as string | null,
      dimFilial,
      dimCliente ?? null,
      dimRca ?? null,
      dimEmitente ?? null,
      p.codigo_cobranca as string | null,
      p.numero_nota as string | null,
      p.valor_pedido as number,
      p.valor_atendido as number | null,
      p.custo_financeiro as number | null,
      p.percentual_lucro as number | null,
      p.lote_id as number,
      String(p.ingerido_em),
    ]);
  }

  return pedidos.length;
}

export async function validarMigracaoAsync(
  legado: Db,
  fato: FatoConn,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const v1 = legado
    .prepare(
      'SELECT COUNT(*) AS qt, COALESCE(SUM(valor_pedido), 0) AS valor FROM pedido',
    )
    .get() as { qt: number; valor: number };

  const v2 = await consultarUm<{ qt: number; valor: number }>(
    fato,
    'SELECT COUNT(*) AS qt, COALESCE(SUM(valor_pedido), 0) AS valor FROM pedido',
  );
  if (!v2) return { ok: false, motivo: 'fato vazio após migração' };
  if (v1.qt !== Number(v2.qt)) {
    return {
      ok: false,
      motivo: `contagem diverge: v1=${v1.qt} v2=${v2.qt}`,
    };
  }
  const tol = Math.abs(v1.valor) * 0.0001 + 0.01;
  if (Math.abs(v1.valor - Number(v2.valor)) > tol) {
    return {
      ok: false,
      motivo: `soma diverge: v1=${v1.valor} v2=${v2.valor}`,
    };
  }
  return { ok: true };
}

/** Arquiva legado e remove bases parciais para rebuild. */
export function arquivarParaRebuild(): void {
  const dir = dataDir();
  const ts = Date.now();
  for (const nome of [ARQUIVO_LEGADO, ARQUIVO_META, ARQUIVO_FATO]) {
    const caminho = join(dir, nome);
    if (existsSync(caminho)) {
      renameSync(caminho, `${caminho}.pre-duckdb-${ts}`);
    }
  }
}
