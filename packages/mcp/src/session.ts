/**
 * A LightStore kept in step with an account, for the duration of a tool call.
 *
 * The store is caught up before each call, so an agent never reasons over state
 * a phone changed a minute ago, and writes are pushed before the call returns,
 * so the agent's changes are durable by the time it reports them.
 *
 * How it reaches the account is injected. Over stdio that is HTTP; inside the
 * Worker it is the account's Durable Object directly, which avoids the Worker
 * making a request back to itself.
 */

import { LightStore, Operations } from "@light/client-sdk";
import { newNodeId, type Cursor, type JsonObject, type Op } from "@light/core";
import type { ToolContext } from "./context.js";

export interface SnapshotResult {
  cursor: Cursor;
  entities: Partial<Record<string, JsonObject[]>>;
}

export interface PullResult {
  cursor: Cursor;
  ops: Op[];
  hasMore: boolean;
}

export interface PushResult extends PullResult {
  rejected?: { id: string; reason: string }[];
}

export interface SyncTransport {
  snapshot(): Promise<SnapshotResult>;
  pull(since: Cursor): Promise<PullResult>;
  push(since: Cursor, ops: Op[]): Promise<PushResult>;
}

export interface SessionOptions {
  transport: SyncTransport;
  /** IANA zone used to decide what "today" is. Defaults to the host's. */
  timezone?: string;
}

/** Ops per request, matching the server's own cap. */
const PUSH_BATCH = 500;

export class Session {
  readonly store: LightStore;
  readonly ops: Operations;
  private readonly transport: SyncTransport;
  private readonly timezone: string | undefined;
  private cursor: Cursor = 0;
  private hydrated = false;

  constructor(options: SessionOptions) {
    this.transport = options.transport;
    this.timezone = options.timezone;
    this.store = new LightStore(newNodeId());
    this.ops = new Operations(this.store);
  }

  /** Loads the account, or catches up if it is already loaded. */
  async refresh(): Promise<void> {
    if (!this.hydrated) {
      const snapshot = await this.transport.snapshot();
      this.store.loadSnapshot(snapshot.entities as never);
      this.cursor = snapshot.cursor;
      this.hydrated = true;
      return;
    }

    let more = true;
    while (more) {
      const page = await this.transport.pull(this.cursor);
      if (page.ops.length > 0) this.store.applyRemote(page.ops);
      this.cursor = page.cursor;
      more = page.hasMore;
    }
  }

  async flush(ops: Op[]): Promise<void> {
    if (ops.length === 0) return;

    for (let i = 0; i < ops.length; i += PUSH_BATCH) {
      const response = await this.transport.push(this.cursor, ops.slice(i, i + PUSH_BATCH));
      if (response.ops.length > 0) this.store.applyRemote(response.ops);
      this.cursor = response.cursor;

      // A rejection means the server will never accept the op, so reporting it
      // is the only useful response — retrying would loop.
      if (response.rejected !== undefined && response.rejected.length > 0) {
        throw new Error(
          `the server rejected ${response.rejected.length} change(s): ` +
            response.rejected.map((r) => r.reason).join("; "),
        );
      }
    }
  }

  today(): string {
    if (this.timezone === undefined) return new Date().toISOString().slice(0, 10);
    // en-CA renders as YYYY-MM-DD, which is the form the model expects.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  get context(): ToolContext {
    return {
      store: this.store,
      ops: this.ops,
      flush: (ops) => this.flush(ops),
      today: () => this.today(),
    };
  }
}

/* ------------------------------------------------------------------ */
/* HTTP transport                                                     */
/* ------------------------------------------------------------------ */

export interface HttpTransportOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class HttpTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    // Bound, because calling an unbound `fetch` as a method gives it the
    // wrong receiver and browsers reject that as an illegal invocation.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  private async expectOk(response: Response, what: string): Promise<unknown> {
    if (!response.ok) {
      const detail = response.status === 401 ? " (is the token still valid?)" : "";
      throw new Error(`could not ${what}: ${response.status} ${response.statusText}${detail}`);
    }
    return response.json();
  }

  async snapshot(): Promise<SnapshotResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/sync/snapshot`, {
      headers: this.headers(),
    });
    return (await this.expectOk(response, "load the account")) as SnapshotResult;
  }

  async pull(since: Cursor): Promise<PullResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/sync/pull?since=${since}`, {
      headers: this.headers(),
    });
    return (await this.expectOk(response, "catch up")) as PullResult;
  }

  async push(since: Cursor, ops: Op[]): Promise<PushResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/sync`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ version: 1, since, ops }),
    });
    return (await this.expectOk(response, "save")) as PushResult;
  }
}
