/**
 * One Durable Object per account: the authoritative store for that account's
 * task graph, and the hub every one of its devices connects to.
 *
 * Choosing a Durable Object over D1 for this is the central architectural call,
 * and it is driven by the free tier. Cloudflare allows 100k D1 row writes a day
 * across the whole account, and since September 2026 queries past that limit
 * fail rather than throttle; a syncing task app would spend that on ordinary
 * editing. Durable Object storage has a separate allowance.
 *
 * Three things fall out of it: writes are serialised per account, so the
 * oplog's sequence is gapless; every device for an account already talks to
 * this object, so realtime fanout is a local broadcast; and one account cannot
 * read another's rows, because they are not in the same database.
 *
 * The logic itself is not here. It lives in `@light/server-core` as
 * `SqlAccountStore`, which this wires to the object's embedded SQLite — so the
 * same code backs the Node and (eventually) Postgres targets.
 */

import { DurableObject } from "cloudflare:workers";
import {
  SqlAccountStore,
  type AccountStats,
  type CompactionResult,
  type SqlDriver,
} from "@light/server-core";
import type { Op, ServerMessage } from "@light/core";

/** The object's embedded SQLite, behind the driver the shared store expects. */
class DurableObjectSqlDriver implements SqlDriver {
  constructor(private readonly sql: SqlStorage) {}

  async query<T>(statement: string, params: unknown[] = []): Promise<T[]> {
    return this.sql.exec(statement, ...(params as never[])).toArray() as T[];
  }

  async run(statement: string, params: unknown[] = []): Promise<void> {
    this.sql.exec(statement, ...(params as never[]));
  }

  async script(statements: string): Promise<void> {
    this.sql.exec(statements);
  }
}

export class Account extends DurableObject<Env> {
  private readonly store: SqlAccountStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlAccountStore(new DurableObjectSqlDriver(ctx.storage.sql));
    // Requests queue until the schema exists, so the first one after a cold
    // start cannot race the migration.
    ctx.blockConcurrencyWhile(async () => {
      await this.store.migrate();
    });
  }

  /* ------------------------------------------------------------ */
  /* RPC surface                                                   */
  /*                                                               */
  /* These take and return JSON strings. Two reasons. The payloads  */
  /* are serialised exactly once rather than being structured-      */
  /* cloned across the boundary and then serialised again for the   */
  /* response. And the protocol's JSON type is recursive, which the */
  /* runtime's RPC serializability check cannot traverse — a method */
  /* returning it exceeds TypeScript's instantiation depth.         */
  /* ------------------------------------------------------------ */

  async snapshotJson(): Promise<string> {
    return JSON.stringify(await this.store.snapshot());
  }

  async pullJson(since: number): Promise<string> {
    return JSON.stringify(await this.store.pull(since));
  }

  async pushJson(since: number, opsJson: string): Promise<string> {
    const ops = JSON.parse(opsJson) as Op[];
    return JSON.stringify(await this.store.push(since, ops));
  }

  async compact(now?: number): Promise<CompactionResult> {
    return this.store.compact(now);
  }

  async stats(): Promise<AccountStats> {
    return { ...(await this.store.stats()), databaseBytes: this.ctx.storage.sql.databaseSize };
  }

  /* ------------------------------------------------------------ */
  /* realtime                                                      */
  /* ------------------------------------------------------------ */

  /**
   * Accepts a device's WebSocket.
   *
   * Hibernation matters on the free plan: an accepted socket costs nothing
   * while idle, so a handful of devices can stay connected all day without
   * burning duration.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(
      JSON.stringify({
        type: "hello",
        cursor: JSON.parse(await this.snapshotJson()).cursor as number,
        node: "server",
      } satisfies ServerMessage),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tells this account's connected devices that there is something to pull. */
  async notify(cursor: number, node: string): Promise<void> {
    const payload = JSON.stringify({ type: "changed", cursor, node } satisfies ServerMessage);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A dead socket is not worth failing a write over.
      }
    }
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
    // 1006 is an abnormal close, where calling close() again would throw.
    if (code !== 1006) {
      try {
        ws.close(1000, "closing");
      } catch {
        // Already gone.
      }
    }
  }
}
