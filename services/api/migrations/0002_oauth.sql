-- OAuth for the MCP endpoint, so an agent can be granted scoped access instead
-- of being handed a session token. Additive and forward-only, like 0001.

-- Clients register themselves (RFC 7591). They are public clients — an agent on
-- someone's laptop cannot keep a secret — so no secret is stored. The redirect
-- URIs are the security boundary, and they are compared exactly.
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  -- JSON array. SQLite has no array type and this is only ever read whole.
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Authorization codes. Hashed and single-use, exactly like login_codes: the
-- row is deleted when taken, whether or not the exchange then succeeds, so a
-- failed attempt cannot be retried with a different PKCE verifier.
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  -- The S256 challenge. The verifier never reaches the database.
  code_challenge TEXT NOT NULL,
  scope          TEXT NOT NULL,
  -- RFC 8707 audience, checked again every time the token is used.
  resource       TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX oauth_codes_by_expiry ON oauth_codes(expires_at);

-- Access tokens, with their refresh token alongside. Both stored only as a
-- SHA-256 hash, for the same reason sessions are: a database leak should not
-- hand over live credentials.
CREATE TABLE oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  refresh_hash TEXT UNIQUE,
  client_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX oauth_tokens_by_user ON oauth_tokens(user_id);
CREATE INDEX oauth_tokens_by_expiry ON oauth_tokens(expires_at);
CREATE INDEX oauth_tokens_by_refresh ON oauth_tokens(refresh_hash);
