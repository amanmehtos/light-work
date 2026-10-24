/**
 * What the server needs from whatever cloud it is running on.
 *
 * Everything above this file — routing, auth, sync, MCP — is ordinary
 * TypeScript with no knowledge of Cloudflare, AWS or anything else. A new
 * target is a matter of implementing these four interfaces, which is the whole
 * point: the decision about where this runs should be reversible.
 *
 * The ports are deliberately coarse. A port per SQL statement would leak the
 * storage model into every adapter and make a non-relational backend painful;
 * a port per *capability* lets DynamoDB and Postgres each do the obvious thing.
 */

import type { Cursor, EntityKind, JsonObject, Op, PullResponse, PushResponse } from "@light/core";
import type { GoogleConfig } from "./google.js";

/* ------------------------------------------------------------------ */
/* Account data                                                       */
/* ------------------------------------------------------------------ */

export interface Snapshot {
  version: number;
  cursor: Cursor;
  /** Live entities only, grouped by kind. */
  entities: Partial<Record<EntityKind, JsonObject[]>>;
}

export interface CompactionResult {
  prunedOps: number;
  prunedTombstones: number;
}

export type AccountStats = Record<string, number | string | null>;

/**
 * One account's task graph.
 *
 * Implementations must serialise writes per account — the oplog's sequence
 * numbers have to be gapless, which is the guarantee the sync cursor rests on.
 * A Durable Object gets this for free; a Postgres implementation needs a
 * transaction, and DynamoDB a conditional write.
 */
export interface AccountStore {
  snapshot(): Promise<Snapshot>;
  pull(since: Cursor): Promise<PullResponse>;
  /** Returns `stale: true` when `since` predates retained history. */
  push(since: Cursor, ops: Op[]): Promise<PushResponse & { stale?: boolean }>;
  compact(now?: number): Promise<CompactionResult>;
  stats(): Promise<AccountStats>;
}

export interface AccountStores {
  /** The store for one account. Called per request; cheap to resolve. */
  of(userId: string): Promise<AccountStore>;
}

/* ------------------------------------------------------------------ */
/* Accounts and sessions                                              */
/* ------------------------------------------------------------------ */

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface LoginCode {
  codeHash: string;
  email: string;
  expiresAt: string;
  attempts: number;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  device: string;
}

export interface ResolvedSession {
  user: User;
  expiresAt: string;
}

/**
 * Global account data: small, queryable by email, and read on every request.
 *
 * Deliberately separate from {@link AccountStore}, because on Cloudflare these
 * live in different services for a reason — see docs/architecture.md on the
 * free-tier write budget.
 */
export interface AuthStore {
  findUserByEmail(email: string): Promise<User | null>;
  createUser(user: User, createdAt: string): Promise<void>;

  /** Replaces any existing code for the address: one live code per account. */
  putLoginCode(code: LoginCode): Promise<void>;
  getLoginCode(email: string): Promise<LoginCode | null>;
  deleteLoginCode(email: string): Promise<void>;
  recordFailedAttempt(email: string): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  findSession(tokenHash: string): Promise<ResolvedSession | null>;
  deleteSession(tokenHash: string): Promise<void>;

  /** Housekeeping, run on a schedule. */
  pruneExpired(nowIso: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Realtime                                                           */
/* ------------------------------------------------------------------ */

/**
 * Telling an account's other devices that there is something to pull.
 *
 * Only a nudge crosses this interface, never data — clients always pull, so a
 * runtime with no push at all can implement `notify` as a no-op and degrade to
 * polling rather than to missing changes.
 */
export interface Realtime {
  notify(userId: string, cursor: Cursor, node: string): Promise<void>;
  /**
   * Handles a WebSocket upgrade, where the runtime has one. Absent means the
   * socket endpoint reports that this deployment does not offer it.
   */
  upgrade?(userId: string, request: Request): Promise<Response>;
}

/* ------------------------------------------------------------------ */
/* Mail                                                               */
/* ------------------------------------------------------------------ */

export interface MailResult {
  delivered: boolean;
  /** Returned only by the development mailer, which sends nothing. */
  devCode?: string;
}

export interface Mailer {
  deliverSignInCode(email: string, code: string): Promise<MailResult>;
}

/* ------------------------------------------------------------------ */

export interface ServerContext {
  accounts: AccountStores;
  auth: AuthStore;
  realtime: Realtime;
  mailer: Mailer;
  /**
   * Google sign-in, when the deployment has an OAuth client configured.
   * Absent means the routes are not mounted at all and the app offers only
   * the email code, so a deployment never advertises a button that cannot work.
   */
  google?: GoogleConfig;
  /** Injectable for tests. */
  now?: () => number;
  /** Shown at the root endpoint, so a deployment can say where it runs. */
  platform?: string;
}
