/**
 * The SQLite schema inside each account's Durable Object.
 *
 * Two tables carry the weight. `entities` holds current state as a merged
 * record per row — values, the per-field clocks the merge rule needs, and a
 * tombstone. `oplog` is the append-only history, and its autoincrement `seq` is
 * the sync cursor clients page through.
 *
 * Current state is kept materialised rather than folded from the log on every
 * read, because a read is the common case and a 50-project account accumulates
 * a log far larger than its state.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  kind        TEXT NOT NULL,
  id          TEXT NOT NULL,
  -- JSON object of current field values.
  value       TEXT NOT NULL,
  -- JSON object of field name -> encoded HLC of the last write to it.
  clocks      TEXT NOT NULL,
  -- Encoded HLC of the latest delete seen, or NULL if never deleted.
  deleted_at  TEXT,
  -- Derived from deleted_at vs the newest field clock. Stored so that listing
  -- live rows is an index scan rather than a per-row recomputation.
  live        INTEGER NOT NULL,
  -- The oplog seq of the most recent op to touch this row.
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS entities_by_seq ON entities(updated_seq);
CREATE INDEX IF NOT EXISTS entities_live ON entities(kind, live);

CREATE TABLE IF NOT EXISTS oplog (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The client-generated op id. UNIQUE is what makes a retried push idempotent.
  op_id       TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  fields      TEXT,
  clock       TEXT NOT NULL,
  node        TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
