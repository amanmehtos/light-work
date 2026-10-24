/**
 * Cloudflare implementations of the server's ports.
 *
 * This is the only file in the deployment that knows it is on Cloudflare.
 * Everything else is `@light/server-core`, which is why moving to another
 * cloud is a matter of writing a sibling to this file rather than reworking
 * the server — see docs/hosting.md.
 */

import type {
  AccountStore,
  AccountStores,
  AuthStore,
  CompactionResult,
  LoginCode,
  Mailer,
  MailResult,
  Realtime,
  ResolvedSession,
  SessionRecord,
  Snapshot,
  User,
} from "@light/server-core";
import type { Cursor, Op, PullResponse, PushResponse } from "@light/core";
import type { Account } from "./account.js";

type AccountStub = DurableObjectStub<Account>;

/** The account's Durable Object, behind the store port. */
class DurableObjectAccountStore implements AccountStore {
  constructor(private readonly stub: AccountStub) {}

  async snapshot(): Promise<Snapshot> {
    return JSON.parse(await this.stub.snapshotJson()) as Snapshot;
  }

  async pull(since: Cursor): Promise<PullResponse> {
    return JSON.parse(await this.stub.pullJson(since)) as PullResponse;
  }

  async push(since: Cursor, ops: Op[]): Promise<PushResponse & { stale?: boolean }> {
    return JSON.parse(await this.stub.pushJson(since, JSON.stringify(ops))) as PushResponse & {
      stale?: boolean;
    };
  }

  async compact(now?: number): Promise<CompactionResult> {
    return this.stub.compact(now);
  }

  async stats() {
    return this.stub.stats();
  }
}

export class DurableObjectAccountStores implements AccountStores {
  constructor(private readonly namespace: DurableObjectNamespace<Account>) {}

  async of(userId: string): Promise<AccountStore> {
    // The object is named after the user, so an account always resolves to the
    // same instance and its writes stay serialised.
    return new DurableObjectAccountStore(this.namespace.get(this.namespace.idFromName(userId)));
  }
}

/**
 * Realtime, through the same object that holds the data.
 *
 * Every device for an account is already connected to its Durable Object, so
 * both the fanout and the socket upgrade go there.
 */
export class DurableObjectRealtime implements Realtime {
  constructor(private readonly namespace: DurableObjectNamespace<Account>) {}

  private stub(userId: string): AccountStub {
    return this.namespace.get(this.namespace.idFromName(userId));
  }

  async notify(userId: string, cursor: Cursor, node: string): Promise<void> {
    await this.stub(userId).notify(cursor, node);
  }

  async upgrade(userId: string, request: Request): Promise<Response> {
    return this.stub(userId).fetch(request);
  }
}

/* ------------------------------------------------------------------ */
/* Auth, in D1                                                        */
/* ------------------------------------------------------------------ */

/**
 * D1 holds only this: users, sessions and sign-in codes. Small, globally
 * queryable by email, and written roughly once per sign-in rather than once per
 * keystroke — which is what keeps the free tier's row-write budget intact.
 */
export class D1AuthStore implements AuthStore {
  constructor(private readonly db: D1Database) {}

  async findUserByEmail(email: string): Promise<User | null> {
    return this.db
      .prepare("SELECT id, email, name FROM users WHERE email = ?")
      .bind(email)
      .first<User>();
  }

  async createUser(user: User, createdAt: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
      .bind(user.id, user.email, user.name, createdAt)
      .run();
  }

  async putLoginCode(code: LoginCode): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM login_codes WHERE email = ?").bind(code.email),
      this.db
        .prepare(
          "INSERT INTO login_codes (code_hash, email, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(code.codeHash, code.email, new Date().toISOString(), code.expiresAt, code.attempts),
    ]);
  }

  async getLoginCode(email: string): Promise<LoginCode | null> {
    const row = await this.db
      .prepare("SELECT code_hash, email, expires_at, attempts FROM login_codes WHERE email = ?")
      .bind(email)
      .first<{ code_hash: string; email: string; expires_at: string; attempts: number }>();
    if (row === null) return null;
    return {
      codeHash: row.code_hash,
      email: row.email,
      expiresAt: row.expires_at,
      attempts: row.attempts,
    };
  }

  async deleteLoginCode(email: string): Promise<void> {
    await this.db.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();
  }

  async recordFailedAttempt(email: string): Promise<void> {
    await this.db
      .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?")
      .bind(email)
      .run();
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, device) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        session.tokenHash,
        session.userId,
        session.createdAt,
        session.expiresAt,
        session.device,
      )
      .run();
  }

  async findSession(tokenHash: string): Promise<ResolvedSession | null> {
    const row = await this.db
      .prepare(
        `SELECT s.expires_at AS expiresAt, u.id, u.email, u.name
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
      )
      .bind(tokenHash)
      .first<{ expiresAt: string; id: string; email: string; name: string }>();
    if (row === null) return null;
    return {
      user: { id: row.id, email: row.email, name: row.name },
      expiresAt: row.expiresAt,
    };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  async pruneExpired(nowIso: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso),
      this.db.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(nowIso),
    ]);
  }
}

/* ------------------------------------------------------------------ */
/* Mail                                                               */
/* ------------------------------------------------------------------ */

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async deliverSignInCode(email: string, code: string): Promise<MailResult> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [email],
        subject: `${code} is your Light Week sign-in code`,
        text:
          `Your Light Week sign-in code is ${code}.\n\n` +
          "It expires in fifteen minutes. If you did not ask for it, you can ignore this email.",
      }),
    });

    if (!response.ok) throw new Error(`mail delivery failed: ${response.status}`);
    return { delivered: true };
  }
}

/**
 * Chooses a mailer from the environment.
 *
 * With no provider and no development flag this throws rather than silently
 * doing nothing, because a sign-in that reports success and sends no email is
 * worse than one that fails loudly.
 */
export function mailerFor(env: Env): Mailer {
  if (env.RESEND_API_KEY !== undefined && env.RESEND_API_KEY !== "") {
    return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM ?? "Light Week <login@lightweek.app>");
  }
  if (env.DEV_LOGIN === "1") {
    return {
      async deliverSignInCode(_email: string, code: string): Promise<MailResult> {
        return { delivered: false, devCode: code };
      },
    };
  }
  return {
    async deliverSignInCode(): Promise<MailResult> {
      throw new Error("no mail provider configured; set RESEND_API_KEY");
    },
  };
}
