import { Db } from './sqlite';

export type TabelaDim =
  'dim_filial' | 'dim_cliente' | 'dim_rca' | 'dim_emitente';

/**
 * Upsert de dimensão no SQLite meta. Retorna o surrogate `id` estável
 * para referência no DuckDB.
 */
export function upsertDimensao(
  db: Db,
  tabela: TabelaDim,
  instanciaId: number,
  codigo: string,
  nome: string | null,
  agora: string,
): number {
  db.prepare(
    `INSERT INTO ${tabela} (instancia_id, codigo, nome, atualizado_em)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(instancia_id, codigo) DO UPDATE SET
       nome = COALESCE(excluded.nome, ${tabela}.nome),
       atualizado_em = excluded.atualizado_em`,
  ).run(instanciaId, codigo, nome, agora);

  const linha = db
    .prepare(`SELECT id FROM ${tabela} WHERE instancia_id = ? AND codigo = ?`)
    .get(instanciaId, codigo) as { id: number };
  return linha.id;
}

export function contarDimensoes(
  db: Db,
  instanciaId: number,
): {
  filiais: number;
  clientes: number;
  rcas: number;
  emitentes: number;
  posicoes: number;
} {
  const contar = (tabela: string) =>
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM ${tabela} WHERE instancia_id = ?`)
        .get(instanciaId) as { c: number }
    ).c;

  return {
    filiais: contar('dim_filial'),
    clientes: contar('dim_cliente'),
    rcas: contar('dim_rca'),
    emitentes: contar('dim_emitente'),
    posicoes: contar('dim_posicao'),
  };
}
