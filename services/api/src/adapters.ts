/**
 * Cloudflare implementations of the server's ports.
 *
 * This is the only file in the deployment that knows it is on Cloudflare.
 * Everything else is `@light/server-core`, which is why moving to another
 * cloud is a matter of writing a sibling to this file rather than reworking
 * the server — see docs/hosting.md.
 */

import { parseScopes } from "@light/server-core";
import type {
  AccountStore,
  AccountStores,
  AuthStore,
  CompactionResult,
  GoogleConfig,
  LoginCode,
  Mailer,
  MailResult,
  OAuthClient,
  OAuthCode,
  OAuthTokenRecord,
  Realtime,
  ResolvedOAuthToken,
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

  /* ---------------------------------------------------------------- */
  /* OAuth                                                             */
  /* ---------------------------------------------------------------- */

  async registerClient(client: OAuthClient): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(client.id, client.name, JSON.stringify(client.redirectUris), client.createdAt)
      .run();
  }

  async findClient(id: string): Promise<OAuthClient | null> {
    const row = await this.db
      .prepare("SELECT id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ?")
      .bind(id)
      .first<{ id: string; name: string; redirect_uris: string; created_at: string }>();
    if (row === null) return null;
    return {
      id: row.id,
      name: row.name,
      redirectUris: JSON.parse(row.redirect_uris) as string[],
      createdAt: row.created_at,
    };
  }

  async putCode(code: OAuthCode): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO oauth_codes
           (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        code.codeHash,
        code.clientId,
        code.userId,
        code.redirectUri,
        code.codeChallenge,
        code.scope,
        code.resource,
        code.expiresAt,
      )
      .run();
  }

  /** Read and delete in one batch: a code is good for exactly one attempt. */
  async takeCode(codeHash: string): Promise<OAuthCode | null> {
    const row = await this.db
      .prepare(
        `SELECT client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at
           FROM oauth_codes WHERE code_hash = ?`,
      )
      .bind(codeHash)
      .first<{
        client_id: string;
        user_id: string;
        redirect_uri: string;
        code_challenge: string;
        scope: string;
        resource: string;
        expires_at: string;
      }>();
    await this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").bind(codeHash).run();
    if (row === null) return null;
    return {
      codeHash,
      clientId: row.client_id,
      userId: row.user_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      scope: row.scope,
      resource: row.resource,
      expiresAt: row.expires_at,
    };
  }

  async createToken(token: OAuthTokenRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO oauth_tokens
           (token_hash, refresh_hash, client_id, user_id, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        token.tokenHash,
        token.refreshHash,
        token.clientId,
        token.userId,
        token.scope,
        token.resource,
        new Date().toISOString(),
        token.expiresAt,
      )
      .run();
  }

  async findToken(tokenHash: string): Promise<ResolvedOAuthToken | null> {
    const row = await this.db
      .prepare(
        `SELECT t.client_id, t.scope, t.resource, t.expires_at AS expiresAt, u.id, u.email, u.name
           FROM oauth_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?`,
      )
      .bind(tokenHash)
      .first<{
        client_id: string;
        scope: string;
        resource: string;
        expiresAt: string;
        id: string;
        email: string;
        name: string;
      }>();
    if (row === null) return null;
    return {
      user: { id: row.id, email: row.email, name: row.name },
      clientId: row.client_id,
      scopes: parseScopes(row.scope),
      resource: row.resource,
      expiresAt: row.expiresAt,
    };
  }

  async findTokenByRefresh(refreshHash: string): Promise<OAuthTokenRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT token_hash, refresh_hash, client_id, user_id, scope, resource, expires_at
           FROM oauth_tokens WHERE refresh_hash = ?`,
      )
      .bind(refreshHash)
      .first<{
        token_hash: string;
        refresh_hash: string | null;
        client_id: string;
        user_id: string;
        scope: string;
        resource: string;
        expires_at: string;
      }>();
    if (row === null) return null;
    return {
      tokenHash: row.token_hash,
      refreshHash: row.refresh_hash,
      clientId: row.client_id,
      userId: row.user_id,
      scope: row.scope,
      resource: row.resource,
      expiresAt: row.expires_at,
    };
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").bind(tokenHash).run();
  }

  async pruneExpired(nowIso: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso),
      this.db.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(nowIso),
      this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(nowIso),
      this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").bind(nowIso),
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
 * Builds the Google OAuth config from the environment, or returns undefined
 * when no client is configured — which is what keeps the routes unmounted and
 * the button hidden rather than offering a sign-in that cannot complete.
 *
 * `origin` is where the Worker believes it is answering. That is right in
 * production, where the Worker serves the app too, and wrong behind the dev
 * server's `/api` proxy, which is what PUBLIC_URL and GOOGLE_REDIRECT_URI are
 * for.
 */
export function googleFor(env: Env, origin: string): GoogleConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (clientId === undefined || clientId === "" || clientSecret === undefined || clientSecret === "") {
    return undefined;
  }

  const appUrl = (env.PUBLIC_URL ?? origin).replace(/\/+$/, "");
  return {
    clientId,
    clientSecret,
    redirectUri: env.GOOGLE_REDIRECT_URI ?? `${appUrl}/auth/google/callback`,
    appUrl,
  };
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
