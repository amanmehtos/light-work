/**
 * The account store, over any SQLite-family database.
 *
 * One implementation of the merge rule, the oplog and compaction, shared by
 * every target that can run SQLite — a Durable Object's embedded database, D1,
 * libSQL, or a local file. Postgres needs a dialect variant of {@link SCHEMA}
 * (`BIGSERIAL` rather than `AUTOINCREMENT`, `$1` placeholders); the logic above
 * it is unchanged, which is the reason this lives behind a driver at all.
 */

import {
  PROTOCOL_VERSION,
  applyOp,
  isEntityKind,
  isLive,
  type Cursor,
  type EntityKind,
  type JsonObject,
  type Op,
  type PullResponse,
  type PushResponse,
  type Record_,
  type SequencedOp,
} from "@light/core";
import type { AccountStats, AccountStore, CompactionResult, Snapshot } from "./ports.js";

/** A minimal database. Placeholders are `?`; the driver translates if it must. */
export interface SqlDriver {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Several statements at once, for schema creation. */
  script(sql: string): Promise<void>;
}

export const SCHEMA_VERSION = 1;

/**
 * Two tables carry the weight. `entities` holds current state as a merged
 * record per row — values, the per-field clocks the merge rule needs, and a
 * tombstone. `oplog` is the append-only history, and its autoincrement `seq` is
 * the sync cursor clients page through.
 *
 * Current state is materialised rather than folded from the log on every read,
 * because reads are the common case and an active account accumulates a log far
 * larger than the state it produces.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  kind        TEXT NOT NULL,
  id          TEXT NOT NULL,
  value       TEXT NOT NULL,
  clocks      TEXT NOT NULL,
  deleted_at  TEXT,
  live        INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS entities_by_seq ON entities(updated_seq);
CREATE INDEX IF NOT EXISTS entities_live ON entities(kind, live);

CREATE TABLE IF NOT EXISTS oplog (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
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

/** Cap on ops returned per pull, so a long-offline client pages rather than times out. */
export const PULL_PAGE_SIZE = 500;
/** Cap on ops accepted per push, mirrored by the client's batching. */
export const MAX_PUSH_OPS = 1000;
/** How long oplog history is retained. Clients further behind must re-snapshot. */
export const OPLOG_RETENTION_DAYS = 30;

interface EntityRow {
  kind: string;
  id: string;
  value: string;
  clocks: string;
  deleted_at: string | null;
  live: number;
  updated_seq: number;
}

interface OpRow {
  seq: number;
  op_id: string;
  kind: string;
  entity_id: string;
  type: string;
  fields: string | null;
  clock: string;
  node: string;
  received_at: string;
}

export class SqlAccountStore implements AccountStore {
  constructor(private readonly db: SqlDriver) {}

  /** Creates the schema. Safe to call repeatedly. */
  async migrate(): Promise<void> {
    await this.db.script(SCHEMA);
    await this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  private async getMeta(key: string): Promise<string | null> {
    const rows = await this.db.query<{ value: string }>(
      "SELECT value FROM meta WHERE key = ?",
      [key],
    );
    return rows[0]?.value ?? null;
  }

  /**
   * The highest sequence ever issued for this account.
   *
   * Read from the log where there is one, and from `meta` where compaction has
   * emptied it. Falling back to zero would be a quiet disaster: the server
   * would advertise a cursor below the one clients already hold, and start
   * re-issuing sequence numbers it has used before.
   */
  async cursor(): Promise<Cursor> {
    const rows = await this.db.query<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM oplog");
    const inLog = rows[0]?.seq ?? 0;
    const recorded = Number(await this.getMeta("last_seq")) || 0;
    return Math.max(inLog, recorded);
  }

  async snapshot(): Promise<Snapshot> {
    const rows = await this.db.query<EntityRow>(
      "SELECT * FROM entities WHERE live = 1 ORDER BY kind, id",
    );

    const entities: Partial<Record<EntityKind, JsonObject[]>> = {};
    for (const row of rows) {
      if (!isEntityKind(row.kind)) continue;
      const bucket = entities[row.kind] ?? [];
      bucket.push(JSON.parse(row.value) as JsonObject);
      entities[row.kind] = bucket;
    }

    return { version: PROTOCOL_VERSION, cursor: await this.cursor(), entities };
  }

  async pull(since: Cursor): Promise<PullResponse> {
    const rows = await this.db.query<OpRow>(
      "SELECT * FROM oplog WHERE seq > ? ORDER BY seq ASC LIMIT ?",
      [since, PULL_PAGE_SIZE + 1],
    );

    const hasMore = rows.length > PULL_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PULL_PAGE_SIZE) : rows;

    return {
      version: PROTOCOL_VERSION,
      cursor: page.length > 0 ? page[page.length - 1]!.seq : since,
      ops: page.map(toSequencedOp),
      hasMore,
    };
  }

  /**
   * Whether `since` is still covered by retained history.
   *
   * With an empty log the oldest thing still obtainable is whatever comes
   * next, so a client holding anything older than the last issued sequence has
   * missed history and must re-snapshot. Treating an empty log as "nothing was
   * pruned" would hand that client an empty pull and let it believe it was up
   * to date.
   */
  private async isCursorStale(since: Cursor): Promise<boolean> {
    if (since === 0) return false;
    const rows = await this.db.query<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM oplog");
    const oldest = rows[0]?.seq ?? (await this.cursor()) + 1;
    return since < oldest - 1;
  }

  async push(since: Cursor, ops: Op[]): Promise<PushResponse & { stale?: boolean }> {
    if (ops.length > MAX_PUSH_OPS) {
      throw new Error(`push of ${ops.length} ops exceeds the ${MAX_PUSH_OPS} limit`);
    }

    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    const receivedAt = new Date().toISOString();

    for (const op of ops) {
      if (!isEntityKind(op.kind)) {
        rejected.push({ id: op.id, reason: `unknown entity kind "${op.kind}"` });
        continue;
      }
      if (op.type !== "upsert" && op.type !== "delete") {
        rejected.push({ id: op.id, reason: `unknown op type "${op.type}"` });
        continue;
      }
      if (typeof op.clock !== "string" || op.clock === "") {
        rejected.push({ id: op.id, reason: "missing clock" });
        continue;
      }

      // A retried push replays op ids we already hold. Report them accepted so
      // the client clears its queue, but do not apply them twice.
      const seen = await this.db.query<{ seq: number }>(
        "SELECT seq FROM oplog WHERE op_id = ?",
        [op.id],
      );
      if (seen.length > 0) {
        accepted.push(op.id);
        continue;
      }

      await this.applyAndLog(op, receivedAt);
      accepted.push(op.id);
    }

    const cursor = await this.cursor();
    const stale = await this.isCursorStale(since);
    const pulled = stale
      ? { version: PROTOCOL_VERSION as typeof PROTOCOL_VERSION, cursor, ops: [], hasMore: false }
      : await this.pull(since);

    return { ...pulled, accepted, rejected, ...(stale ? { stale: true } : {}) };
  }

  private async applyAndLog(op: Op, receivedAt: string): Promise<void> {
    const existingRows = await this.db.query<EntityRow>(
      "SELECT * FROM entities WHERE kind = ? AND id = ?",
      [op.kind, op.entityId],
    );
    const existingRow = existingRows[0];

    const existing: Record_<JsonObject> | null =
      existingRow === undefined
        ? null
        : {
            value: JSON.parse(existingRow.value) as JsonObject,
            clocks: JSON.parse(existingRow.clocks) as Record<string, string>,
            deletedAt: existingRow.deleted_at,
          };

    const merged = applyOp(existing, op);

    // The op goes in the log whether or not it changed anything: other clients
    // need to see it to converge, and its presence is what makes a retried push
    // idempotent.
    await this.db.run(
      `INSERT INTO oplog (op_id, kind, entity_id, type, fields, clock, node, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        op.id,
        op.kind,
        op.entityId,
        op.type,
        op.fields === undefined ? null : JSON.stringify(op.fields),
        op.clock,
        op.node,
        receivedAt,
      ],
    );
    const seq = await this.cursor();
    // Remembered separately, so the sequence survives the log being pruned.
    await this.setMeta("last_seq", String(seq));

    await this.db.run(
      `INSERT INTO entities (kind, id, value, clocks, deleted_at, live, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET
         value = excluded.value,
         clocks = excluded.clocks,
         deleted_at = excluded.deleted_at,
         live = excluded.live,
         updated_seq = excluded.updated_seq`,
      [
        op.kind,
        op.entityId,
        JSON.stringify(merged.record.value),
        JSON.stringify(merged.record.clocks),
        merged.record.deletedAt,
        isLive(merged.record) ? 1 : 0,
        seq,
      ],
    );
  }

  async compact(now: number = Date.now()): Promise<CompactionResult> {
    const cutoff = new Date(now - OPLOG_RETENTION_DAYS * 86_400_000).toISOString();

    const before = await this.countOps();
    await this.db.run("DELETE FROM oplog WHERE received_at < ?", [cutoff]);
    const prunedOps = before - (await this.countOps());

    // A tombstone is only droppable once no retained op refers to it; otherwise
    // replaying the log would resurrect the row.
    const tombstonesBefore = await this.countTombstones();
    await this.db.run(
      `DELETE FROM entities
        WHERE live = 0
          AND NOT EXISTS (SELECT 1 FROM oplog WHERE oplog.kind = entities.kind AND oplog.entity_id = entities.id)`,
    );
    const prunedTombstones = tombstonesBefore - (await this.countTombstones());

    await this.setMeta("last_compacted_at", new Date(now).toISOString());
    return { prunedOps, prunedTombstones };
  }

  private async countOps(): Promise<number> {
    const rows = await this.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM oplog");
    return rows[0]?.n ?? 0;
  }

  private async countTombstones(): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM entities WHERE live = 0",
    );
    return rows[0]?.n ?? 0;
  }

  async stats(): Promise<AccountStats> {
    const live = await this.db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM entities WHERE live = 1",
    );
    return {
      cursor: await this.cursor(),
      ops: await this.countOps(),
      liveEntities: live[0]?.n ?? 0,
      tombstones: await this.countTombstones(),
      lastCompactedAt: await this.getMeta("last_compacted_at"),
      schemaVersion: await this.getMeta("schema_version"),
    };
  }
}

function toSequencedOp(row: OpRow): SequencedOp {
  const op: SequencedOp = {
    id: row.op_id,
    kind: row.kind as EntityKind,
    entityId: row.entity_id,
    type: row.type as "upsert" | "delete",
    clock: row.clock,
    node: row.node,
    seq: row.seq,
    receivedAt: row.received_at,
  };
  if (row.fields !== null) op.fields = JSON.parse(row.fields) as JsonObject;
  return op;
}
