/** Esquema DuckDB do fato (`vendas-fato.duckdb`). */
export const FATO_SCHEMA_VERSION = 1;

export const DDL_FATO = `
CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pedido (
  instancia_id       INTEGER   NOT NULL,
  codigo_filial      VARCHAR   NOT NULL,
  numero_pedido      VARCHAR   NOT NULL,
  dia                DATE      NOT NULL,
  data_pedido        VARCHAR   NOT NULL,
  hora               INTEGER,
  minuto             INTEGER,
  posicao_pedido     VARCHAR,
  tipo_venda         VARCHAR,
  dim_filial_id      INTEGER   NOT NULL,
  dim_cliente_id     INTEGER,
  dim_rca_id         INTEGER,
  dim_emitente_id    INTEGER,
  codigo_cobranca    VARCHAR,
  numero_nota        VARCHAR,
  valor_pedido       DOUBLE    NOT NULL DEFAULT 0,
  valor_atendido     DOUBLE,
  custo_financeiro   DOUBLE,
  percentual_lucro   DOUBLE,
  lote_id            INTEGER   NOT NULL,
  ingerido_em        TIMESTAMP NOT NULL,
  PRIMARY KEY (instancia_id, codigo_filial, numero_pedido)
);

CREATE INDEX IF NOT EXISTS ix_pedido_dia
  ON pedido(instancia_id, dia, dim_filial_id);

CREATE INDEX IF NOT EXISTS ix_pedido_lote ON pedido(lote_id);
`;
