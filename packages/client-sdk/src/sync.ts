/**
 * Talking to the server.
 *
 * The client is offline-first in the strict sense: a mutation is applied to the
 * local store and appended to a durable queue, and the network is a separate
 * concern that drains the queue when it can. Nothing in the UI path awaits a
 * request.
 *
 * The queue is the only state that has to survive a restart. Everything else
 * can be rebuilt from a snapshot.
 */

import { ENTITY_KINDS, PROTOCOL_VERSION, type Cursor, type JsonObject, type Op } from "@light/core";
import type { LightStore } from "./store.js";

export interface QueueStorage {
  load(): Promise<{ ops: Op[]; cursor: Cursor }>;
  save(state: { ops: Op[]; cursor: Cursor }): Promise<void>;
}

/** Keeps the queue only for the lifetime of the process. */
export class MemoryQueueStorage implements QueueStorage {
  private state: { ops: Op[]; cursor: Cursor } = { ops: [], cursor: 0 };
  async load() {
    return this.state;
  }
  async save(state: { ops: Op[]; cursor: Cursor }) {
    this.state = { ops: [...state.ops], cursor: state.cursor };
  }
}

/** The slice of `localStorage` the queue needs, so a test can stand one in. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Keeps the queue in `localStorage`, so an edit made offline survives a reload.
 *
 * Until this existed the web app ran on `MemoryQueueStorage` and every queued
 * op died with the tab: the "N queued" badge was a promise the page could not
 * keep across a refresh.
 *
 * `localStorage` is not dependable — private windows, blocked site data and a
 * full quota all make it throw, sometimes on read and sometimes only on write
 * — so every access is wrapped, and every save is also kept in memory. A
 * browser that cannot persist therefore behaves exactly as the app did before
 * this class: the queue lives as long as the page and no longer. Failing loudly
 * was the alternative, and it was rejected because the person typing a task has
 * done nothing wrong and cannot fix their browser's settings.
 *
 * The cursor is written alongside the ops because the two are one fact: "these
 * are the ops the server has not seen, as of this point in its log". It is the
 * caller's job (see `SyncClient.start`) not to trust that cursor against a
 * store that did not survive the reload.
 *
 * The key is a parameter because a browser is shared between people: ops
 * queued by one account must never be pushed into another's after a sign-out.
 */
export class WebQueueStorage implements QueueStorage {
  private readonly memory = new MemoryQueueStorage();

  constructor(
    private readonly key = "light-week.queue",
    private readonly area: () => KeyValueStorage = () => globalThis.localStorage,
  ) {}

  async load(): Promise<{ ops: Op[]; cursor: Cursor }> {
    try {
      const raw = this.area().getItem(this.key);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { ops?: unknown; cursor?: unknown };
        if (Array.isArray(parsed.ops) && typeof parsed.cursor === "number") {
          return { ops: parsed.ops as Op[], cursor: parsed.cursor };
        }
      }
    } catch {
      // Unreadable storage and unparseable contents get the same answer: start
      // empty. A corrupt queue cannot be repaired, and the next save replaces it.
    }
    return this.memory.load();
  }

  async save(state: { ops: Op[]; cursor: Cursor }): Promise<void> {
    await this.memory.save(state);
    try {
      this.area().setItem(this.key, JSON.stringify(state));
    } catch {
      // Memory already has it; see the class comment.
    }
  }
}

export interface SyncClientOptions {
  baseUrl: string;
  token: string;
  store: LightStore;
  storage?: QueueStorage;
  fetchImpl?: typeof fetch;
  /** Called whenever the connection state or queue depth changes. */
  onStatus?: (status: SyncStatus) => void;
}

export interface SyncStatus {
  state: "offline" | "syncing" | "idle" | "error";
  pending: number;
  cursor: Cursor;
  lastError?: string;
}

interface PushBody {
  version: typeof PROTOCOL_VERSION;
  since: Cursor;
  ops: Op[];
}

interface SyncResponse {
  version: number;
  cursor: Cursor;
  ops: (Op & { seq: Cursor })[];
  hasMore: boolean;
  accepted?: string[];
  rejected?: { id: string; reason: string }[];
  stale?: boolean;
}

/** Ops per request, matching the server's own cap. */
const PUSH_BATCH = 500;

export class SyncClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly store: LightStore;
  private readonly storage: QueueStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly onStatus: (status: SyncStatus) => void;

  private queue: Op[] = [];
  private cursor: Cursor = 0;
  private running = false;
  /** Set when a sync is requested while one is already in flight. */
  private again = false;
  private socket: WebSocket | null = null;

  constructor(options: SyncClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.store = options.store;
    this.storage = options.storage ?? new MemoryQueueStorage();
    // Bound, because calling an unbound `fetch` as a method gives it the
    // wrong receiver and browsers reject that as an illegal invocation.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onStatus = options.onStatus ?? (() => {});
  }

  async start(): Promise<void> {
    const saved = await this.storage.load();
    this.queue = saved.ops;
    this.cursor = saved.cursor;

    // A cursor of zero means this client has never synced, so it bootstraps
    // from a snapshot rather than replaying history it cannot have. So does an
    // empty store with a cursor beyond zero: the queue can be persisted while
    // the store, which lives in memory, is not, and pulling "since" a cursor
    // into a store that holds none of what came before it would leave the
    // account looking empty after every reload.
    const cold = ENTITY_KINDS.every((kind) => this.store.count(kind) === 0);
    if (this.cursor === 0 || cold) await this.bootstrap();
    await this.sync();
  }

  /** Stages a mutation and schedules a sync. Returns once staged, not sent. */
  enqueue(ops: Op[]): void {
    this.queue.push(...ops);
    void this.persist();
    void this.sync();
  }

  get status(): SyncStatus {
    return { state: this.running ? "syncing" : "idle", pending: this.queue.length, cursor: this.cursor };
  }

  private async persist(): Promise<void> {
    await this.storage.save({ ops: this.queue, cursor: this.cursor });
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  private async bootstrap(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/sync/snapshot`, {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`snapshot failed: ${response.status}`);
    const body = (await response.json()) as {
      cursor: Cursor;
      entities: Partial<Record<string, JsonObject[]>>;
    };
    this.store.loadSnapshot(body.entities as never);
    // The snapshot is the server's state, which by definition lacks whatever is
    // still queued. Putting those ops back on top keeps an edit made offline
    // visible after a reload rather than reappearing only once it has made the
    // round trip. Applying one the server already has is harmless: the merge
    // is idempotent.
    if (this.queue.length > 0) this.store.applyRemote(this.queue);
    this.cursor = body.cursor;
    await this.persist();
  }

  /**
   * One pass: push whatever is queued, apply whatever comes back, repeat while
   * the server says there is more. Re-entrant calls collapse into one pass.
   */
  async sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.onStatus({ state: "syncing", pending: this.queue.length, cursor: this.cursor });

    try {
      do {
        this.again = false;
        await this.drain();
      } while (this.again);
      this.onStatus({ state: "idle", pending: this.queue.length, cursor: this.cursor });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onStatus({
        state: "error",
        pending: this.queue.length,
        cursor: this.cursor,
        lastError: message,
      });
    } finally {
      this.running = false;
    }
  }

  private async drain(): Promise<void> {
    // Push in batches, keeping the queue intact until the server confirms each
    // batch — a failure mid-way leaves the unsent remainder queued.
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, PUSH_BATCH);
      const body: PushBody = { version: PROTOCOL_VERSION, since: this.cursor, ops: batch };

      const response = await this.fetchImpl(`${this.baseUrl}/sync`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`push failed: ${response.status} ${await response.text()}`);

      const result = (await response.json()) as SyncResponse;
      await this.absorb(result);

      const accepted = new Set(result.accepted ?? []);
      const rejected = new Set((result.rejected ?? []).map((r) => r.id));
      // Rejected ops are dropped rather than retried: the server rejects only
      // what it will never accept, so retrying would loop forever.
      this.queue = this.queue.filter((op) => !accepted.has(op.id) && !rejected.has(op.id));
      await this.persist();
    }

    // Nothing to push: just catch up.
    let more = true;
    while (more) {
      const response = await this.fetchImpl(
        `${this.baseUrl}/sync/pull?since=${this.cursor}`,
        { headers: this.headers() },
      );
      if (!response.ok) throw new Error(`pull failed: ${response.status}`);
      const result = (await response.json()) as SyncResponse;
      await this.absorb(result);
      more = result.hasMore;
    }
  }

  private async absorb(result: SyncResponse): Promise<void> {
    // The server tells us when our cursor has fallen outside retained history,
    // in which case catching up incrementally is impossible.
    if (result.stale === true) {
      await this.bootstrap();
      return;
    }
    // Ops this device produced are already in the store; applying them again is
    // harmless because the merge is idempotent, so there is no echo filter.
    if (result.ops.length > 0) this.store.applyRemote(result.ops);
    if (result.cursor > this.cursor) this.cursor = result.cursor;
    await this.persist();
  }

  /**
   * Opens the realtime channel.
   *
   * The socket only carries a nudge; the client still pulls. That keeps one
   * code path for catching up whether the client was connected or not, and
   * means a dropped socket degrades to polling rather than to missing data.
   */
  connect(onNotice?: () => void): void {
    if (this.socket !== null) return;
    const url = `${this.baseUrl.replace(/^http/, "ws")}/sync/socket?token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (data === "pong") return;
      try {
        const message = JSON.parse(data) as { type?: string; node?: string };
        if (message.type !== "changed") return;
        // Our own push already returned these ops, so skip the echo.
        if (message.node === this.store.node) return;
        onNotice?.();
        void this.sync();
      } catch {
        // A message we cannot parse is not worth tearing the socket down for.
      }
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      this.onStatus({ state: "offline", pending: this.queue.length, cursor: this.cursor });
    });
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
  }
}
