/**
 * A SQL driver over Node's built-in SQLite.
 *
 * Two jobs. It runs the server locally with nothing installed — no wrangler, no
 * container — which makes `node` a viable way to work on the app. And it is the
 * second runtime for {@link SqlAccountStore}, which is what demonstrates that
 * the store is not quietly Cloudflare-shaped: the same code, the same schema,
 * the same tests, a different database.
 *
 * `node:sqlite` is still marked experimental upstream, so this is a development
 * and test target rather than something to deploy.
 */

import { DatabaseSync } from "node:sqlite";
import type { SqlDriver } from "../sql.js";

export class NodeSqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync;

  /** Defaults to an in-memory database; pass a path to persist. */
  constructor(location = ":memory:") {
    this.db = new DatabaseSync(location);
    // The schema relies on ON CONFLICT upserts and foreign-key-free tables, so
    // the only pragma that matters is write-ahead logging for a file database.
    if (location !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }

  async script(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
