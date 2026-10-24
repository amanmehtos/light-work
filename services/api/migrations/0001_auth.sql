-- Global auth tables. Everything else lives in the per-account Durable Object.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- Session tokens are stored only as a SHA-256 hash, so a database leak does not
-- hand over live sessions. The token itself is high-entropy random, so a single
-- hash round is sufficient — there is nothing to brute-force.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  -- Free-text label so a user can tell their devices apart when revoking.
  device      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_by_user ON sessions(user_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

-- Short-lived email sign-in codes. Also stored hashed, and single-use.
CREATE TABLE login_codes (
  code_hash   TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX login_codes_by_email ON login_codes(email);
