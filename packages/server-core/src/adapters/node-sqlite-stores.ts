/**
 * Node-hosted stores, for local development and tests.
 *
 * One database file per account mirrors the Cloudflare shape, where each
 * account has its own Durable Object with its own SQLite. Keeping that shape
 * locally means the thing being developed against behaves like the thing that
 * is deployed.
 */

import { NodeSqliteDriver } from "./node-sqlite.js";
import { SqlAccountStore } from "../sql.js";
import type {
  AccountStore,
  AccountStores,
  AuthStore,
  LoginCode,
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

  async pruneExpired(nowIso: string): Promise<void> {
    await this.withSchema(async () => {
      await this.db.run("DELETE FROM sessions WHERE expires_at < ?", [nowIso]);
      await this.db.run("DELETE FROM login_codes WHERE expires_at < ?", [nowIso]);
    });
  }
}
