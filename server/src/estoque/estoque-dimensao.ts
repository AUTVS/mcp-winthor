import { Db } from '../vendas/sqlite';

export type TabelaDimEstoque = 'dim_filial' | 'dim_produto';

export function upsertDimensaoEstoque(
  db: Db,
  tabela: TabelaDimEstoque,
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

export function contarDimensoesEstoque(
  db: Db,
  instanciaId: number,
): { filiais: number; produtos: number } {
  const contar = (tabela: string) =>
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM ${tabela} WHERE instancia_id = ?`)
        .get(instanciaId) as { c: number }
    ).c;

  return {
    filiais: contar('dim_filial'),
    produtos: contar('dim_produto'),
  };
}
