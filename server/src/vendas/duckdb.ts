import {
  DuckDBConnection,
  DuckDBInstance,
  DuckDBValue,
} from '@duckdb/node-api';

export type FatoConn = DuckDBConnection;

export async function abrirDuckDB(caminho: string): Promise<{
  instance: DuckDBInstance;
  conn: FatoConn;
}> {
  const instance = await DuckDBInstance.create(caminho);
  const conn = await instance.connect();
  return { instance, conn };
}

/** Executa SQL sem retorno. */
export async function executar(conn: FatoConn, sql: string): Promise<void> {
  await conn.run(sql);
}

/** Executa SQL parametrizado sem retorno. */
export async function executarParams(
  conn: FatoConn,
  sql: string,
  params: DuckDBValue[],
): Promise<void> {
  const prepared = await conn.prepare(sql);
  await prepared.bind(params);
  await prepared.run();
}

/** Retorna linhas como objetos `{ coluna: valor }`. */
export async function consultar<T extends Record<string, unknown>>(
  conn: FatoConn,
  sql: string,
  params: DuckDBValue[] = [],
): Promise<T[]> {
  const prepared = await conn.prepare(sql);
  await prepared.bind(params);
  const reader = await prepared.runAndReadAll();
  const colunas = reader.columnNames();
  return reader.getRows().map((row) => {
    const obj: Record<string, unknown> = {};
    colunas.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj as T;
  });
}

/** Retorna uma linha ou undefined. */
export async function consultarUm<T extends Record<string, unknown>>(
  conn: FatoConn,
  sql: string,
  params: DuckDBValue[] = [],
): Promise<T | undefined> {
  const linhas = await consultar<T>(conn, sql, params);
  return linhas[0];
}
