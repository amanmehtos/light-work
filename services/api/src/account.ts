/**
 * One Durable Object per account: the authoritative store for that account's
 * task graph, and the hub every one of its devices connects to.
 *
 * Choosing a Durable Object over D1 for this is the central architectural call.
 * It buys three things. Writes are strongly consistent and serialised per
 * account, so the oplog sequence has no gaps and no races. The storage
 * allowance is separate from D1's free-tier row-write cap, which a sync-heavy
 * app would otherwise exhaust on task edits. And because every device for an
 * account already talks to the same object, realtime fanout is a local
 * broadcast rather than a pub/sub service.
 */

import { DurableObject } from "cloudflare:workers";
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
  type ServerMessage,
} from "@light/core";
import { SCHEMA, SCHEMA_VERSION } from "./schema.js";

/** Cap on ops returned per pull, so a long-offline client pages instead of timing out. */
const PULL_PAGE_SIZE = 500;

/** Cap on ops accepted per push, mirrored by the client's batching. */
const MAX_PUSH_OPS = 1000;

/** How long oplog history is retained. Clients further behind must re-snapshot. */
const OPLOG_RETENTION_DAYS = 30;

// The index signature is what satisfies SqlStorage's row constraint.
interface EntityRow extends Record<string, SqlStorageValue> {
  kind: string;
  id: string;
  value: string;
  clocks: string;
  deleted_at: string | null;
  live: number;
  updated_seq: number;
}

interface OpRow extends Record<string, SqlStorageValue> {
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

export interface Snapshot {
  version: typeof PROTOCOL_VERSION;
  cursor: Cursor;
  /** Live entities only, grouped by kind. Tombstones are not worth sending. */
  entities: Partial<Record<EntityKind, JsonObject[]>>;
}

export class Account extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // blockConcurrencyWhile keeps requests queued until the schema exists, so
    // the first request after a cold start cannot race the migration.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      this.setMeta("schema_version", String(SCHEMA_VERSION));
    });
  }

  /* ------------------------------------------------------------ */
  /* meta                                                          */
  /* ------------------------------------------------------------ */

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private getMeta(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows[0]?.value ?? null;
  }

  /** The highest seq assigned so far, which is the account's current cursor. */
  private cursor(): Cursor {
    const rows = this.sql
      .exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM oplog")
      .toArray();
    return rows[0]?.seq ?? 0;
  }

  /* ------------------------------------------------------------ */
  /* reads                                                         */
  /* ------------------------------------------------------------ */

  /* ------------------------------------------------------------ */
  /* RPC surface                                                   */
  /*                                                               */
  /* The methods the Worker calls take and return JSON strings.    */
  /* Two reasons. The payloads are serialised exactly once instead */
  /* of being structured-cloned across the RPC boundary and then   */
  /* serialised again for the response. And the protocol's JSON    */
  /* type is recursive, which the runtime's RPC serializability    */
  /* check cannot traverse — a method returning it exceeds         */
  /* TypeScript's instantiation depth. The typed implementations   */
  /* below stay private, so they are not part of that surface.     */
  /* ------------------------------------------------------------ */

  snapshotJson(): string {
    return JSON.stringify(this.snapshot());
  }

  pullJson(since: number): string {
    return JSON.stringify(this.pull(since));
  }

  pushJson(since: number, opsJson: string): string {
    const ops = JSON.parse(opsJson) as Op[];
    return JSON.stringify(this.push(since, ops));
  }

  /**
   * Everything a fresh client needs to start up.
   *
   * A new device cannot replay the oplog from zero — the log is pruned, and on a
   * busy account it is far bigger than the state it produces. It bootstraps from
   * here instead and then tails the log from `cursor`.
   */
  private snapshot(): Snapshot {
    const rows = this.sql
      .exec<EntityRow>("SELECT * FROM entities WHERE live = 1 ORDER BY kind, id")
      .toArray();

    const entities: Partial<Record<EntityKind, JsonObject[]>> = {};
    for (const row of rows) {
      if (!isEntityKind(row.kind)) continue;
      const bucket = entities[row.kind] ?? [];
      bucket.push(JSON.parse(row.value) as JsonObject);
      entities[row.kind] = bucket;
    }

    return { version: PROTOCOL_VERSION, cursor: this.cursor(), entities };
  }

  /** Ops with a seq above `since`, oldest first. */
  private pull(since: Cursor): PullResponse {
    const rows = this.sql
      .exec<OpRow>(
        "SELECT * FROM oplog WHERE seq > ? ORDER BY seq ASC LIMIT ?",
        since,
        PULL_PAGE_SIZE + 1,
      )
      .toArray();

    const hasMore = rows.length > PULL_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PULL_PAGE_SIZE) : rows;

    return {
      version: PROTOCOL_VERSION,
      cursor: page.length > 0 ? page[page.length - 1]!.seq : since,
      ops: page.map(toSequencedOp),
      hasMore,
    };
  }

  /** Whether `since` is still covered by retained history. */
  private isCursorStale(since: Cursor): boolean {
    if (since === 0) return false;
    const rows = this.sql
      .exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM oplog")
      .toArray();
    const oldest = rows[0]?.seq;
    if (oldest == null) return false;
    // The client's cursor must sit at or above the op just before the oldest we
    // still hold, otherwise it has missed history and needs a fresh snapshot.
    return since < oldest - 1;
  }

  /* ------------------------------------------------------------ */
  /* writes                                                        */
  /* ------------------------------------------------------------ */

  /**
   * Applies a batch of ops and returns everything the client has not yet seen.
   *
   * The merge rule decides conflicts, so the server does not need to reject an
   * op for being out of date — a stale op simply loses on the fields it touches
   * and is recorded for other clients to converge on.
   */
  private push(since: Cursor, ops: Op[]): PushResponse & { stale?: boolean } {
    if (ops.length > MAX_PUSH_OPS) {
      throw new Error(`push of ${ops.length} ops exceeds the ${MAX_PUSH_OPS} limit`);
    }

    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    const receivedAt = new Date().toISOString();
    let wrote = false;

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

      // A retried push replays op ids we already hold. Treat them as accepted
      // so the client clears its queue, but do not apply them twice.
      const seen = this.sql
        .exec<{ seq: number }>("SELECT seq FROM oplog WHERE op_id = ?", op.id)
        .toArray();
      if (seen.length > 0) {
        accepted.push(op.id);
        continue;
      }

      this.applyAndLog(op, receivedAt);
      accepted.push(op.id);
      wrote = true;
    }

    const cursor = this.cursor();
    if (wrote) this.broadcast({ type: "changed", cursor, node: ops[0]?.node ?? "" });

    const stale = this.isCursorStale(since);
    const pulled = stale
      ? { version: PROTOCOL_VERSION as typeof PROTOCOL_VERSION, cursor, ops: [], hasMore: false }
      : this.pull(since);

    return { ...pulled, accepted, rejected, ...(stale ? { stale: true } : {}) };
  }

  private applyAndLog(op: Op, receivedAt: string): void {
    const existingRows = this.sql
      .exec<EntityRow>("SELECT * FROM entities WHERE kind = ? AND id = ?", op.kind, op.entityId)
      .toArray();
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
    // need to see it to converge, and its presence is what makes the push
    // idempotent on retry.
    this.sql.exec(
      `INSERT INTO oplog (op_id, kind, entity_id, type, fields, clock, node, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      op.id,
      op.kind,
      op.entityId,
      op.type,
      op.fields === undefined ? null : JSON.stringify(op.fields),
      op.clock,
      op.node,
      receivedAt,
    );
    const seq = this.cursor();

    this.sql.exec(
      `INSERT INTO entities (kind, id, value, clocks, deleted_at, live, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET
         value = excluded.value,
         clocks = excluded.clocks,
         deleted_at = excluded.deleted_at,
         live = excluded.live,
         updated_seq = excluded.updated_seq`,
      op.kind,
      op.entityId,
      JSON.stringify(merged.record.value),
      JSON.stringify(merged.record.clocks),
      merged.record.deletedAt,
      isLive(merged.record) ? 1 : 0,
      seq,
    );
  }

  /* ------------------------------------------------------------ */
  /* realtime                                                      */
  /* ------------------------------------------------------------ */

  /**
   * Accepts a device's WebSocket.
   *
   * Hibernation matters on the free plan: an accepted socket costs nothing while
   * idle, so a handful of devices can stay connected all day without burning
   * duration. Only the notice is pushed, never the data — the client pulls, so
   * there is one code path for catching up whether it was connected or not.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(
      JSON.stringify({ type: "hello", cursor: this.cursor(), node: "server" } satisfies ServerMessage),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // The socket is a notification channel only; mutations go over HTTP where
    // they get a response and a retry story. A ping keeps middleboxes happy.
    if (typeof message === "string" && message === "ping") ws.send("pong");
  }

  webSocketError(): void {
    // Nothing to clean up: hibernation tracks sockets for us.
  }

  webSocketClose(ws: WebSocket, code: number): void {
    // 1006 means an abnormal close, where calling close() again would throw.
    if (code !== 1006) {
      try {
        ws.close(1000, "closing");
      } catch {
        // Already gone.
      }
    }
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A dead socket is not worth failing a write over.
      }
    }
  }

  /* ------------------------------------------------------------ */
  /* maintenance                                                   */
  /* ------------------------------------------------------------ */

  /**
   * Drops oplog history past the retention window and tombstones no client can
   * still need. Entity rows are kept; only the log is pruned.
   */
  compact(now: number = Date.now()): { prunedOps: number; prunedTombstones: number } {
    const cutoff = new Date(now - OPLOG_RETENTION_DAYS * 86_400_000).toISOString();

    const before = this.countOps();
    this.sql.exec("DELETE FROM oplog WHERE received_at < ?", cutoff);
    const prunedOps = before - this.countOps();

    // A tombstone is only droppable once no retained op refers to it; otherwise
    // replaying the log would resurrect the row.
    const tombstonesBefore = this.countTombstones();
    this.sql.exec(
      `DELETE FROM entities
        WHERE live = 0
          AND NOT EXISTS (SELECT 1 FROM oplog WHERE oplog.kind = entities.kind AND oplog.entity_id = entities.id)`,
    );
    const prunedTombstones = tombstonesBefore - this.countTombstones();

    this.setMeta("last_compacted_at", new Date(now).toISOString());
    return { prunedOps, prunedTombstones };
  }

  private countOps(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM oplog").toArray()[0]?.n ?? 0;
  }

  private countTombstones(): number {
    return (
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM entities WHERE live = 0").toArray()[0]
        ?.n ?? 0
    );
  }

  /** Diagnostics, surfaced to the account owner rather than hidden in logs. */
  stats(): Record<string, number | string | null> {
    return {
      cursor: this.cursor(),
      ops: this.countOps(),
      liveEntities:
        this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM entities WHERE live = 1").toArray()[0]
          ?.n ?? 0,
      tombstones: this.countTombstones(),
      databaseBytes: this.sql.databaseSize,
      lastCompactedAt: this.getMeta("last_compacted_at"),
      schemaVersion: this.getMeta("schema_version"),
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
