/**
 * In-memory adapters.
 *
 * These exist for two reasons. They make the server's own tests fast and
 * runtime-free. And they are a genuine *second* implementation of every port,
 * which is the only way to find out whether a port is really an abstraction or
 * just the first backend's shape with an interface drawn around it — the
 * account store here reaches the same merge decisions through a Map that the
 * SQL one reaches through two tables.
 *
 * They are not a deployment target: everything is lost when the process ends.
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
import type {
  AccountStats,
  AccountStore,
  AccountStores,
  CompactionResult,
  LoginCode,
  Mailer,
  MailResult,
  Realtime,
  ResolvedSession,
  SessionRecord,
  Snapshot,
  User,
  AuthStore,
} from "../ports.js";
import { MAX_PUSH_OPS, OPLOG_RETENTION_DAYS, PULL_PAGE_SIZE } from "../sql.js";

export class MemoryAccountStore implements AccountStore {
  private readonly log: SequencedOp[] = [];
  private readonly opIds = new Set<string>();
  private readonly entities = new Map<string, Record_<JsonObject>>();
  private lastCompactedAt: string | null = null;
  /**
   * Monotonic, and deliberately not derived from the log's length: compaction
   * empties the log, and reusing a sequence number a client has already seen
   * would make it ignore the new op entirely.
   */
  private lastSeq = 0;

  private key(kind: string, id: string): string {
    return `${kind}\u0000${id}`;
  }

  private cursor(): Cursor {
    return this.lastSeq;
  }

  async snapshot(): Promise<Snapshot> {
    const entities: Partial<Record<EntityKind, JsonObject[]>> = {};
    for (const [key, record] of this.entities) {
      if (!isLive(record)) continue;
      const kind = key.slice(0, key.indexOf("\u0000"));
      if (!isEntityKind(kind)) continue;
      const bucket = entities[kind] ?? [];
      bucket.push(record.value);
      entities[kind] = bucket;
    }
    return { version: PROTOCOL_VERSION, cursor: this.cursor(), entities };
  }

  async pull(since: Cursor): Promise<PullResponse> {
    const matching = this.log.filter((op) => op.seq > since);
    const hasMore = matching.length > PULL_PAGE_SIZE;
    const page = hasMore ? matching.slice(0, PULL_PAGE_SIZE) : matching;
    return {
      version: PROTOCOL_VERSION,
      cursor: page.length > 0 ? page[page.length - 1]!.seq : since,
      ops: page,
      hasMore,
    };
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
      if (this.opIds.has(op.id)) {
        accepted.push(op.id);
        continue;
      }

      const key = this.key(op.kind, op.entityId);
      const merged = applyOp(this.entities.get(key) ?? null, op);
      this.entities.set(key, merged.record);

      this.opIds.add(op.id);
      this.lastSeq += 1;
      this.log.push({ ...op, seq: this.lastSeq, receivedAt });
      accepted.push(op.id);
    }

    // With an empty log the oldest obtainable op is the next one, so anything
    // older than the last issued sequence has missed history.
    const oldest = this.log[0]?.seq ?? this.lastSeq + 1;
    const stale = since !== 0 && since < oldest - 1;
    const pulled = stale
      ? { version: PROTOCOL_VERSION as typeof PROTOCOL_VERSION, cursor: this.cursor(), ops: [], hasMore: false }
      : await this.pull(since);

    return { ...pulled, accepted, rejected, ...(stale ? { stale: true } : {}) };
  }

  async compact(now: number = Date.now()): Promise<CompactionResult> {
    const cutoff = new Date(now - OPLOG_RETENTION_DAYS * 86_400_000).toISOString();

    const before = this.log.length;
    const kept = this.log.filter((op) => op.receivedAt >= cutoff);
    this.log.length = 0;
    this.log.push(...kept);
    const prunedOps = before - this.log.length;

    const referenced = new Set(kept.map((op) => this.key(op.kind, op.entityId)));
    let prunedTombstones = 0;
    for (const [key, record] of [...this.entities]) {
      if (!isLive(record) && !referenced.has(key)) {
        this.entities.delete(key);
        prunedTombstones += 1;
      }
    }

    this.lastCompactedAt = new Date(now).toISOString();
    return { prunedOps, prunedTombstones };
  }

  async stats(): Promise<AccountStats> {
    let live = 0;
    let tombstones = 0;
    for (const record of this.entities.values()) {
      if (isLive(record)) live += 1;
      else tombstones += 1;
    }
    return {
      cursor: this.cursor(),
      ops: this.log.length,
      liveEntities: live,
      tombstones,
      lastCompactedAt: this.lastCompactedAt,
      schemaVersion: "memory",
    };
  }
}

export class MemoryAccountStores implements AccountStores {
  private readonly byUser = new Map<string, MemoryAccountStore>();

  async of(userId: string): Promise<AccountStore> {
    let store = this.byUser.get(userId);
    if (store === undefined) {
      store = new MemoryAccountStore();
      this.byUser.set(userId, store);
    }
    return store;
  }
}

export class MemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, User>();
  private readonly codes = new Map<string, LoginCode>();
  private readonly sessions = new Map<string, SessionRecord>();

  async findUserByEmail(email: string): Promise<User | null> {
    return this.users.get(email) ?? null;
  }

  async createUser(user: User): Promise<void> {
    this.users.set(user.email, user);
  }

  async putLoginCode(code: LoginCode): Promise<void> {
    this.codes.set(code.email, code);
  }

  async getLoginCode(email: string): Promise<LoginCode | null> {
    return this.codes.get(email) ?? null;
  }

  async deleteLoginCode(email: string): Promise<void> {
    this.codes.delete(email);
  }

  async recordFailedAttempt(email: string): Promise<void> {
    const code = this.codes.get(email);
    if (code !== undefined) this.codes.set(email, { ...code, attempts: code.attempts + 1 });
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  async findSession(tokenHash: string): Promise<ResolvedSession | null> {
    const session = this.sessions.get(tokenHash);
    if (session === undefined) return null;
    const user = [...this.users.values()].find((candidate) => candidate.id === session.userId);
    if (user === undefined) return null;
    return { user, expiresAt: session.expiresAt };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async pruneExpired(nowIso: string): Promise<void> {
    for (const [hash, session] of [...this.sessions]) {
      if (session.expiresAt < nowIso) this.sessions.delete(hash);
    }
    for (const [email, code] of [...this.codes]) {
      if (code.expiresAt < nowIso) this.codes.delete(email);
    }
  }
}

/** Records what would have been sent, and reports nothing to anyone else. */
export class MemoryRealtime implements Realtime {
  readonly notices: { userId: string; cursor: Cursor; node: string }[] = [];

  async notify(userId: string, cursor: Cursor, node: string): Promise<void> {
    this.notices.push({ userId, cursor, node });
  }
}

/**
 * Hands the code back instead of emailing it.
 *
 * This is what makes the app usable without a mail provider configured. It is
 * only ever wired up behind an explicit development flag — see the Cloudflare
 * adapter, which refuses to construct it otherwise.
 */
export class DevMailer implements Mailer {
  readonly sent: { email: string; code: string }[] = [];

  async deliverSignInCode(email: string, code: string): Promise<MailResult> {
    this.sent.push({ email, code });
    return { delivered: false, devCode: code };
  }
}
