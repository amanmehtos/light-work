/**
 * Node-hosted stores, for local development and tests.
 *
 * One database file per account mirrors the Cloudflare shape, where each
 * account has its own Durable Object with its own SQLite. Keeping that shape
 * locally means the thing being developed against behaves like the thing that
 * is deployed.
 */

import { NodeSqliteDriver } from "./node-sqlite.js";
import { parseScopes } from "../oauth.js";
import { SqlAccountStore } from "../sql.js";
import type {
  AccountStore,
  AccountStores,
  AuthStore,
  LoginCode,
  OAuthClient,
  OAuthCode,
  OAuthTokenRecord,
  ResolvedOAuthToken,
  ResolvedSession,
  SessionRecord,
  User,
} from "../ports.js";

export class NodeSqliteAccountStores implements AccountStores {
  private readonly stores = new Map<string, SqlAccountStore>();

  /** `directory` persists one file per account; omit it to keep them in memory. */
  constructor(private readonly directory?: string) {}

  async of(userId: string): Promise<AccountStore> {
    let store = this.stores.get(userId);
    if (store === undefined) {
      const location =
        this.directory === undefined
          ? ":memory:"
          : `${this.directory}/${encodeURIComponent(userId)}.sqlite`;
      store = new SqlAccountStore(new NodeSqliteDriver(location));
      await store.migrate();
      this.stores.set(userId, store);
    }
    return store;
  }
}

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_codes (
  code_hash   TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS login_codes_by_email ON login_codes(email);

CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  refresh_hash TEXT UNIQUE,
  client_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_tokens_by_refresh ON oauth_tokens(refresh_hash);
`;

export class NodeSqliteAuthStore implements AuthStore {
  private readonly db: NodeSqliteDriver;
  private ready: Promise<void>;

  constructor(location = ":memory:") {
    this.db = new NodeSqliteDriver(location);
    this.ready = this.db.script(AUTH_SCHEMA);
  }

  private async withSchema<T>(run: () => Promise<T>): Promise<T> {
    await this.ready;
    return run();
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.withSchema(async () => {
      const rows = await this.db.query<User>(
        "SELECT id, email, name FROM users WHERE email = ?",
        [email],
      );
      return rows[0] ?? null;
    });
  }

  async createUser(user: User, createdAt: string): Promise<void> {
    await this.withSchema(() =>
      this.db.run("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)", [
        user.id,
        user.email,
        user.name,
        createdAt,
      ]),
    );
  }

  async putLoginCode(code: LoginCode): Promise<void> {
    await this.withSchema(async () => {
      await this.db.run("DELETE FROM login_codes WHERE email = ?", [code.email]);
      await this.db.run(
        "INSERT INTO login_codes (code_hash, email, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?)",
        [code.codeHash, code.email, new Date().toISOString(), code.expiresAt, code.attempts],
      );
    });
  }

  async getLoginCode(email: string): Promise<LoginCode | null> {
    return this.withSchema(async () => {
      const rows = await this.db.query<{
        code_hash: string;
        email: string;
        expires_at: string;
        attempts: number;
      }>("SELECT code_hash, email, expires_at, attempts FROM login_codes WHERE email = ?", [email]);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        codeHash: row.code_hash,
        email: row.email,
        expiresAt: row.expires_at,
        attempts: row.attempts,
      };
    });
  }

  async deleteLoginCode(email: string): Promise<void> {
    await this.withSchema(() => this.db.run("DELETE FROM login_codes WHERE email = ?", [email]));
  }

  async recordFailedAttempt(email: string): Promise<void> {
    await this.withSchema(() =>
      this.db.run("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?", [email]),
    );
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.withSchema(() =>
      this.db.run(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, device) VALUES (?, ?, ?, ?, ?)",
        [
          session.tokenHash,
          session.userId,
          session.createdAt,
          session.expiresAt,
          session.device,
        ],
      ),
    );
  }

  async findSession(tokenHash: string): Promise<ResolvedSession | null> {
    return this.withSchema(async () => {
      const rows = await this.db.query<{
        expires_at: string;
        id: string;
        email: string;
        name: string;
      }>(
        `SELECT s.expires_at, u.id, u.email, u.name
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
        [tokenHash],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        user: { id: row.id, email: row.email, name: row.name },
        expiresAt: row.expires_at,
      };
    });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.withSchema(() =>
      this.db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]),
    );
  }

  /* ---------------------------------------------------------------- */
  /* OAuth                                                             */
  /* ---------------------------------------------------------------- */

  async registerClient(client: OAuthClient): Promise<void> {
    await this.withSchema(() =>
      this.db.run(
        "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
        [client.id, client.name, JSON.stringify(client.redirectUris), client.createdAt],
      ),
    );
  }

  async findClient(id: string): Promise<OAuthClient | null> {
    return this.withSchema(async () => {
      const rows = await this.db.query<{
        id: string;
        name: string;
        redirect_uris: string;
        created_at: string;
      }>("SELECT id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ?", [id]);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        name: row.name,
        redirectUris: JSON.parse(row.redirect_uris) as string[],
        createdAt: row.created_at,
      };
    });
  }

  async putCode(code: OAuthCode): Promise<void> {
    await this.withSchema(() =>
      this.db.run(
        `INSERT INTO oauth_codes
           (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          code.codeHash,
          code.clientId,
          code.userId,
          code.redirectUri,
          code.codeChallenge,
          code.scope,
          code.resource,
          code.expiresAt,
        ],
      ),
    );
  }

  async takeCode(codeHash: string): Promise<OAuthCode | null> {
    return this.withSchema(async () => {
      const rows = await this.db.query<{
        client_id: string;
        user_id: string;
        redirect_uri: string;
        code_challenge: string;
        scope: string;
        resource: string;
        expires_at: string;
      }>(
        `SELECT client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at
           FROM oauth_codes WHERE code_hash = ?`,
        [codeHash],
      );
      // Consumed on read, valid or not, so a failed exchange cannot be retried.
      await this.db.run("DELETE FROM oauth_codes WHERE code_hash = ?", [codeHash]);
      const row = rows[0];
      if (row === undefined) return null;
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
    });
  }

  async createToken(token: OAuthTokenRecord): Promise<void> {
    await this.withSchema(() =>
      this.db.run(
        `INSERT INTO oauth_tokens
           (token_hash, refresh_hash, client_id, user_id, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          token.tokenHash,
          token.refreshHash,
          token.clientId,
          token.userId,
          token.scope,
          token.resource,
          new Date().toISOString(),
          token.expiresAt,
        ],
      ),
    );
  }

  async findToken(tokenHash: string): Promise<ResolvedOAuthToken | null> {
    return this.withSchema(async () => {
      const rows = await this.db.query<{
        client_id: string;
        scope: string;
        resource: string;
        expires_at: string;
        id: string;
        email: string;
        name: string;
      }>(
        `SELECT t.client_id, t.scope, t.resource, t.expires_at, u.id, u.email, u.name
           FROM oauth_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?`,
        [tokenHash],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        user: { id: row.id, email: row.email, name: row.name },
        clientId: row.client_id,
        scopes: parseScopes(row.scope),
        resource: row.resource,
        expiresAt: row.expires_at,
      };
    });
  }

  async findTokenByRefresh(refreshHash: string): Promise<OAuthTokenRecord | null> {
    return this.withSchema(async () => {
      const rows = await this.db.query<{
        token_hash: string;
        refresh_hash: string | null;
        client_id: string;
        user_id: string;
        scope: string;
        resource: string;
        expires_at: string;
      }>(
        `SELECT token_hash, refresh_hash, client_id, user_id, scope, resource, expires_at
           FROM oauth_tokens WHERE refresh_hash = ?`,
        [refreshHash],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        tokenHash: row.token_hash,
        refreshHash: row.refresh_hash,
        clientId: row.client_id,
        userId: row.user_id,
        scope: row.scope,
        resource: row.resource,
        expiresAt: row.expires_at,
      };
    });
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.withSchema(() =>
      this.db.run("DELETE FROM oauth_tokens WHERE token_hash = ?", [tokenHash]),
    );
  }

  async pruneExpired(nowIso: string): Promise<void> {
    await this.withSchema(async () => {
      await this.db.run("DELETE FROM sessions WHERE expires_at < ?", [nowIso]);
      await this.db.run("DELETE FROM login_codes WHERE expires_at < ?", [nowIso]);
      await this.db.run("DELETE FROM oauth_codes WHERE expires_at < ?", [nowIso]);
      await this.db.run("DELETE FROM oauth_tokens WHERE expires_at < ?", [nowIso]);
    });
  }
}
