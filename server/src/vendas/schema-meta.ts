/** Esquema SQLite de metadados e dimensões (`vendas-meta.db`). */
export const SCHEMA_VERSION = 3;

/**
 * Introduzido na v3. Fica isolado porque é ao mesmo tempo parte do DDL inicial e
 * corpo da migração — duas cópias divergiriam no primeiro `ALTER`.
 */
const DDL_V3 = `
CREATE TABLE IF NOT EXISTS filial_alvo (
  instancia_id  INTEGER NOT NULL REFERENCES instancia(id) ON DELETE CASCADE,
  codigo_filial TEXT    NOT NULL,
  registrado_em TEXT    NOT NULL,
  PRIMARY KEY (instancia_id, codigo_filial)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_cobertura_dia
  ON cobertura(instancia_id, posicao_pedido, dia);
`;

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
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  chave             TEXT    NOT NULL UNIQUE,
  base_url          TEXT    NOT NULL,
  login             TEXT    NOT NULL,
  criada_em         TEXT    NOT NULL,
  vista_em          TEXT    NOT NULL,
  dia_verificado_em TEXT
) STRICT;

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
  lote_id        INTEGER NOT NULL REFERENCES lote(id),
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

${DIM_TEMPLATE('dim_filial')}
${DIM_TEMPLATE('dim_cliente')}
${DIM_TEMPLATE('dim_rca')}
${DIM_TEMPLATE('dim_emitente')}
${DDL_V3}
`;

export const MIGRACOES: { versao: number; sql: string }[] = [
  /**
   * v3 — `filial_alvo` e o índice de cobertura por dia.
   *
   * `filial_alvo` guarda o conjunto de filiais que a última varredura PADRÃO
   * planejou cobrir. Sem ele, "a janela está completa?" só podia ser respondida
   * contando `DISTINCT dia`, o que dava "completa" com uma filial de cinco —
   * enquanto `VendasQueryService` recusava a mesma consulta por exigir
   * `dias × filiais`. Perguntar ao ERP não serve: `filiaisPadrao()` são duas
   * chamadas HTTP, e o status é lido em poll de 1,5 s durante a sincronização.
   *
   * O índice existe porque o predicado novo filtra por range de `dia`, e a PK de
   * `cobertura` tem `codigo_filial` ANTES de `dia` — o range não é seletivo sob ela.
   */
  { versao: 3, sql: DDL_V3 },
];
