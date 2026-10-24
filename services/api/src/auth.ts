/**
 * Email-code sign-in and session tokens.
 *
 * There is deliberately no password login. A password needs a slow KDF to be
 * stored safely, and a slow KDF does not fit a Worker's CPU budget — on the free
 * plan an invocation gets about 10ms, where a defensible PBKDF2 or Argon2 cost
 * is an order of magnitude more. Rather than ship a deliberately weak hash, sign
 * in is by emailed code, which needs no KDF at all: the secret is high-entropy
 * and server-generated, so a single SHA-256 is the right amount of hashing.
 *
 * OAuth providers (GitHub, Google, Apple) are the natural next addition and slot
 * in beside this; they need real client credentials, so they are configuration
 * rather than code to write blind.
 */

const SESSION_TTL_DAYS = 90;
const CODE_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Session {
  user: User;
  expiresAt: string;
}

/* ---------------------------------------------------------------- */
/* primitives                                                       */
/* ---------------------------------------------------------------- */

function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A 6-digit code, drawn without modulo bias. */
function randomCode(): string {
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
    // 4294000000 is the largest multiple of 1e6 below 2^32; redrawing above it
    // keeps every code equally likely.
  } while (buffer[0]! >= 4_294_000_000);
  return String(buffer[0]! % 1_000_000).padStart(6, "0");
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  // Deliberately permissive: the only real proof an address works is that the
  // code arrives, so this rejects obvious nonsense and nothing more.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

function newUserId(): string {
  return `u_${randomToken(12)}`;
}

/* ---------------------------------------------------------------- */
/* sign-in codes                                                    */
/* ---------------------------------------------------------------- */

export interface CodeIssued {
  /** Returned only when there is no mail provider configured, for local dev. */
  devCode?: string;
}

export async function issueLoginCode(
  db: D1Database,
  rawEmail: string,
  now: number = Date.now(),
): Promise<string> {
  const email = normaliseEmail(rawEmail);
  const code = randomCode();
  const codeHash = await sha256(`${email}:${code}`);

  // One live code per address: requesting a new one invalidates the old, so a
  // code from an older email cannot be replayed.
  await db.batch([
    db.prepare("DELETE FROM login_codes WHERE email = ?").bind(email),
    db
      .prepare(
        "INSERT INTO login_codes (code_hash, email, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, 0)",
      )
      .bind(
        codeHash,
        email,
        new Date(now).toISOString(),
        new Date(now + CODE_TTL_MINUTES * 60_000).toISOString(),
      ),
  ]);

  return code;
}

export interface VerifyResult {
  ok: boolean;
  reason?: "no_code" | "expired" | "too_many_attempts" | "mismatch";
  token?: string;
  user?: User;
}

export async function verifyLoginCode(
  db: D1Database,
  rawEmail: string,
  code: string,
  device: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const email = normaliseEmail(rawEmail);
  const codeHash = await sha256(`${email}:${code.trim()}`);

  const row = await db
    .prepare("SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?")
    .bind(email)
    .first<{ code_hash: string; expires_at: string; attempts: number }>();

  if (row === null) return { ok: false, reason: "no_code" };

  if (new Date(row.expires_at).getTime() < now) {
    await db.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();
    return { ok: false, reason: "expired" };
  }

  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await db.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();
    return { ok: false, reason: "too_many_attempts" };
  }

  if (row.code_hash !== codeHash) {
    // Count the attempt so guessing a 6-digit code is not free.
    await db
      .prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?")
      .bind(email)
      .run();
    return { ok: false, reason: "mismatch" };
  }

  await db.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();
  const user = await findOrCreateUser(db, email, now);
  const token = await createSession(db, user.id, device, now);
  return { ok: true, token, user };
}

/* ---------------------------------------------------------------- */
/* users and sessions                                               */
/* ---------------------------------------------------------------- */

export async function findOrCreateUser(
  db: D1Database,
  rawEmail: string,
  now: number = Date.now(),
): Promise<User> {
  const email = normaliseEmail(rawEmail);
  const existing = await db
    .prepare("SELECT id, email, name FROM users WHERE email = ?")
    .bind(email)
    .first<User>();
  if (existing !== null) return existing;

  const user: User = { id: newUserId(), email, name: "" };
  await db
    .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(user.id, user.email, user.name, new Date(now).toISOString())
    .run();
  return user;
}

export async function createSession(
  db: D1Database,
  userId: string,
  device: string,
  now: number = Date.now(),
): Promise<string> {
  const token = randomToken();
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, device) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      await sha256(token),
      userId,
      new Date(now).toISOString(),
      new Date(now + SESSION_TTL_DAYS * 86_400_000).toISOString(),
      device.slice(0, 120),
    )
    .run();
  return token;
}

export async function resolveSession(
  db: D1Database,
  token: string,
  now: number = Date.now(),
): Promise<Session | null> {
  const row = await db
    .prepare(
      `SELECT s.expires_at AS expiresAt, u.id, u.email, u.name
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .bind(await sha256(token))
    .first<{ expiresAt: string; id: string; email: string; name: string }>();

  if (row === null) return null;
  if (new Date(row.expiresAt).getTime() < now) return null;

  return {
    user: { id: row.id, email: row.email, name: row.name },
    expiresAt: row.expiresAt,
  };
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

/** Drops expired sessions and codes. Cheap enough to run on a cron. */
export async function pruneExpired(db: D1Database, now: number = Date.now()): Promise<void> {
  const iso = new Date(now).toISOString();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(iso),
    db.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(iso),
  ]);
}

/* ---------------------------------------------------------------- */
/* delivery                                                         */
/* ---------------------------------------------------------------- */

/**
 * Sends the sign-in code.
 *
 * With no provider configured the code is returned to the caller instead, which
 * is what makes local development and the test suite workable. That path is
 * gated on `DEV_LOGIN` so it can never be reached in a deployed Worker.
 */
export async function deliverCode(
  env: Env,
  email: string,
  code: string,
): Promise<{ delivered: boolean; devCode?: string }> {
  if (env.RESEND_API_KEY === undefined || env.RESEND_API_KEY === "") {
    if (env.DEV_LOGIN === "1") return { delivered: false, devCode: code };
    throw new Error("no mail provider configured; set RESEND_API_KEY");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM ?? "Light Week <login@lightweek.app>",
      to: [email],
      subject: `${code} is your Light Week sign-in code`,
      text: `Your Light Week sign-in code is ${code}.\n\nIt expires in ${CODE_TTL_MINUTES} minutes. If you did not ask for it, you can ignore this email.`,
    }),
  });

  if (!response.ok) {
    throw new Error(`mail delivery failed: ${response.status}`);
  }
  return { delivered: true };
}
