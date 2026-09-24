/** Esquema legado v1 — monolítico em `vendas.db`. Usado só na migração. */
export const SCHEMA_V1_VERSION = 1;

export const DDL_V1 = `
CREATE TABLE IF NOT EXISTS instancia (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  chave             TEXT    NOT NULL UNIQUE,
  base_url          TEXT    NOT NULL,
  login             TEXT    NOT NULL,
  criada_em         TEXT    NOT NULL,
  vista_em          TEXT    NOT NULL,
  dia_verificado_em TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS pedido (
  instancia_id     INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo_filial    TEXT    NOT NULL,
  numero_pedido    TEXT    NOT NULL,
  dia              TEXT    NOT NULL,
  data_pedido      TEXT    NOT NULL,
  hora             INTEGER,
  minuto           INTEGER,
  posicao_pedido   TEXT,
  tipo_venda       TEXT,
  nome_filial      TEXT,
  codigo_cliente   TEXT,
  nome_cliente     TEXT,
  codigo_rca       TEXT,
  nome_rca         TEXT,
  codigo_emitente  TEXT,
  nome_emitente    TEXT,
  codigo_cobranca  TEXT,
  numero_nota      TEXT,
  valor_pedido     REAL    NOT NULL DEFAULT 0,
  valor_atendido   REAL,
  custo_financeiro REAL,
  percentual_lucro REAL,
  lote_id          INTEGER NOT NULL,
  ingerido_em      TEXT    NOT NULL,
  PRIMARY KEY (instancia_id, codigo_filial, numero_pedido)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_pedido_dia
  ON pedido(instancia_id, dia, codigo_filial, posicao_pedido);
CREATE INDEX IF NOT EXISTS ix_pedido_cliente ON pedido(instancia_id, codigo_cliente, dia);
CREATE INDEX IF NOT EXISTS ix_pedido_rca     ON pedido(instancia_id, codigo_rca, dia);
CREATE INDEX IF NOT EXISTS ix_pedido_lote    ON pedido(lote_id);

CREATE TABLE IF NOT EXISTS lote (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  instancia_id     INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo_filial    TEXT    NOT NULL,
  periodo          TEXT    NOT NULL,
  posicao_pedido   TEXT    NOT NULL,
  margem_min_lucro TEXT    NOT NULL,
  dia_inicio       TEXT    NOT NULL,
  dia_fim          TEXT    NOT NULL,
  iniciado_em      TEXT    NOT NULL,
  concluido_em     TEXT,
  estado           TEXT    NOT NULL,
  paginas          INTEGER NOT NULL DEFAULT 0,
  linhas           INTEGER NOT NULL DEFAULT 0,
  proxima_pagina   INTEGER NOT NULL DEFAULT 1,
  total_upstream   INTEGER,
  valor_upstream   REAL,
  custo_upstream   REAL,
  qt_local         INTEGER,
  valor_local      REAL,
  divergencia_pct  REAL,
  confere          INTEGER,
  removidos        INTEGER NOT NULL DEFAULT 0,
  motivo           TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS ix_lote_estado ON lote(instancia_id, estado, iniciado_em);

CREATE TABLE IF NOT EXISTS cobertura (
  instancia_id   INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo_filial  TEXT    NOT NULL,
  dia            TEXT    NOT NULL,
  posicao_pedido TEXT    NOT NULL,
  lote_id        INTEGER NOT NULL,
  atualizado_em  TEXT    NOT NULL,
  qt_pedidos     INTEGER NOT NULL,
  valor          REAL    NOT NULL,
  estado         TEXT    NOT NULL,
  PRIMARY KEY (instancia_id, codigo_filial, dia, posicao_pedido)
) STRICT;

CREATE TABLE IF NOT EXISTS ancora (
  instancia_id    INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo_filial   TEXT    NOT NULL,
  periodo         TEXT    NOT NULL,
  posicao_pedido  TEXT    NOT NULL,
  verificado_em   TEXT    NOT NULL,
  dia_inicio      TEXT    NOT NULL,
  dia_fim         TEXT    NOT NULL,
  qt_upstream     INTEGER NOT NULL,
  valor_upstream  REAL,
  qt_local        INTEGER NOT NULL,
  valor_local     REAL    NOT NULL,
  divergencia_pct REAL,
  confere         INTEGER NOT NULL,
  PRIMARY KEY (instancia_id, codigo_filial, periodo, posicao_pedido)
) STRICT;

CREATE TABLE IF NOT EXISTS dim_posicao (
  instancia_id INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo       TEXT    NOT NULL,
  rotulo       TEXT    NOT NULL,
  aprendido_em TEXT    NOT NULL,
  PRIMARY KEY (instancia_id, codigo)
) STRICT;
`;
