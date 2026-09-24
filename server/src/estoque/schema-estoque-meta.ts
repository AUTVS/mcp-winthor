/** Esquema SQLite de metadados e dimensões (`estoque-meta.db`). */
export const SCHEMA_VERSION = 1;

const DIM_TEMPLATE = (nome: string) => `
CREATE TABLE IF NOT EXISTS ${nome} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instancia_id  INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo        TEXT    NOT NULL,
  nome          TEXT,
  atualizado_em TEXT    NOT NULL,
  UNIQUE (instancia_id, codigo)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_${nome}_codigo ON ${nome}(instancia_id, codigo);
`;

export const DDL_META = `
CREATE TABLE IF NOT EXISTS instancia (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chave      TEXT    NOT NULL UNIQUE,
  base_url   TEXT    NOT NULL,
  login      TEXT    NOT NULL,
  criada_em  TEXT    NOT NULL,
  vista_em   TEXT    NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS lote (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instancia_id    INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo_filial   TEXT    NOT NULL,
  iniciado_em     TEXT    NOT NULL,
  concluido_em    TEXT,
  estado          TEXT    NOT NULL,
  paginas         INTEGER NOT NULL DEFAULT 0,
  linhas          INTEGER NOT NULL DEFAULT 0,
  proxima_pagina  INTEGER NOT NULL DEFAULT 1,
  total_upstream  INTEGER,
  qt_local        INTEGER,
  motivo          TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS ix_lote_estado
  ON lote(instancia_id, estado, iniciado_em);

CREATE TABLE IF NOT EXISTS cobertura (
  instancia_id   INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo_filial  TEXT    NOT NULL,
  lote_id        INTEGER NOT NULL REFERENCES lote(id),
  atualizado_em  TEXT    NOT NULL,
  qt_produtos    INTEGER NOT NULL,
  estado         TEXT    NOT NULL,
  PRIMARY KEY (instancia_id, codigo_filial)
) STRICT;

CREATE TABLE IF NOT EXISTS filial_alvo (
  instancia_id  INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo_filial TEXT    NOT NULL,
  registrado_em TEXT    NOT NULL,
  PRIMARY KEY (instancia_id, codigo_filial)
) STRICT;

${DIM_TEMPLATE('dim_filial')}
${DIM_TEMPLATE('dim_produto')}
`;

export const MIGRACOES: { versao: number; sql: string }[] = [];
