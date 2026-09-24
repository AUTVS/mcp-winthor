/** Esquema DuckDB do fato (`estoque-fato.duckdb`). */
export const FATO_SCHEMA_VERSION = 1;

export const DDL_FATO = `
CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS produto_estoque (
  instancia_id      INTEGER   NOT NULL,
  codigo_filial     VARCHAR   NOT NULL,
  codigo_produto    VARCHAR   NOT NULL,
  descricao         VARCHAR,
  saldo             DOUBLE,
  saldo_reservado   DOUBLE,
  dim_filial_id     INTEGER   NOT NULL,
  dim_produto_id    INTEGER   NOT NULL,
  lote_id           INTEGER   NOT NULL,
  ingerido_em       TIMESTAMP NOT NULL,
  PRIMARY KEY (instancia_id, codigo_filial, codigo_produto)
);

CREATE INDEX IF NOT EXISTS ix_produto_filial
  ON produto_estoque(instancia_id, codigo_filial);

CREATE INDEX IF NOT EXISTS ix_produto_lote ON produto_estoque(lote_id);
`;
