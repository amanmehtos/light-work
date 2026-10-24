/**
 * Email-code sign-in and session tokens.
 *
 * There is deliberately no password login. A password needs a slow key
 * derivation function to be stored safely, and a slow KDF does not fit a
 * Worker's CPU budget — on Cloudflare's free plan an invocation gets about
 * 10ms, where a defensible PBKDF2 or Argon2 cost is an order of magnitude
 * more. Rather than ship a deliberately weak hash, sign-in is by emailed code,
 * which needs no KDF at all: the secret is high-entropy and server-generated,
 * so a single SHA-256 is the right amount of hashing.
 *
 * This file knows nothing about where the data lives; it talks to an
 * {@link AuthStore}.
 */

import type { AuthStore, Mailer, MailResult, ResolvedSession, User } from "./ports.js";

export const SESSION_TTL_DAYS = 90;
export const CODE_TTL_MINUTES = 15;
export const MAX_CODE_ATTEMPTS = 5;

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
    // 4_294_000_000 is the largest multiple of 1e6 below 2^32; redrawing above
    // it keeps every code equally likely.
  } while (buffer[0]! >= 4_294_000_000);
  return String(buffer[0]! % 1_000_000).padStart(6, "0");
}

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normaliseEmail(email: string): string {
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

export async function issueLoginCode(
  store: AuthStore,
  rawEmail: string,
  now: number = Date.now(),
): Promise<string> {
  const email = normaliseEmail(rawEmail);
  const code = randomCode();

  // One live code per address: requesting a new one invalidates the old, so a
  // code from an older email cannot be replayed.
  await store.putLoginCode({
    codeHash: await sha256(`${email}:${code}`),
    email,
    expiresAt: new Date(now + CODE_TTL_MINUTES * 60_000).toISOString(),
    attempts: 0,
  });

  return code;
}

export type VerifyFailure = "no_code" | "expired" | "too_many_attempts" | "mismatch";

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
  token?: string;
  user?: User;
}

export async function verifyLoginCode(
  store: AuthStore,
  rawEmail: string,
  code: string,
  device: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const email = normaliseEmail(rawEmail);
  const record = await store.getLoginCode(email);

  if (record === null) return { ok: false, reason: "no_code" };

  if (new Date(record.expiresAt).getTime() < now) {
    await store.deleteLoginCode(email);
    return { ok: false, reason: "expired" };
  }

  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    await store.deleteLoginCode(email);
    return { ok: false, reason: "too_many_attempts" };
  }

  if (record.codeHash !== (await sha256(`${email}:${code.trim()}`))) {
    // Count the attempt, so guessing a six-digit code is not free.
    await store.recordFailedAttempt(email);
    return { ok: false, reason: "mismatch" };
  }

  await store.deleteLoginCode(email);
  const user = await findOrCreateUser(store, email, now);
  const token = await createSession(store, user.id, device, now);
  return { ok: true, token, user };
}

export async function findOrCreateUser(
  store: AuthStore,
  rawEmail: string,
  now: number = Date.now(),
): Promise<User> {
  const email = normaliseEmail(rawEmail);
  const existing = await store.findUserByEmail(email);
  if (existing !== null) return existing;

  const user: User = { id: newUserId(), email, name: "" };
  await store.createUser(user, new Date(now).toISOString());
  return user;
}

export async function createSession(
  store: AuthStore,
  userId: string,
  device: string,
  now: number = Date.now(),
): Promise<string> {
  const token = randomToken();
  // Only the hash is stored, so a database leak does not hand over live
  // sessions. The token is high-entropy, so one round is sufficient — there is
  // nothing to brute-force.
  await store.createSession({
    tokenHash: await sha256(token),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_DAYS * 86_400_000).toISOString(),
    device: device.slice(0, 120),
  });
  return token;
}

export async function resolveSession(
  store: AuthStore,
  token: string,
  now: number = Date.now(),
): Promise<ResolvedSession | null> {
  const session = await store.findSession(await sha256(token));
  if (session === null) return null;
  if (new Date(session.expiresAt).getTime() < now) return null;
  return session;
}

export async function revokeSession(store: AuthStore, token: string): Promise<void> {
  await store.deleteSession(await sha256(token));
}

export async function pruneExpired(store: AuthStore, now: number = Date.now()): Promise<void> {
  await store.pruneExpired(new Date(now).toISOString());
}

/**
 * Sends the code through whatever mailer is configured.
 *
 * Kept as a function rather than inlined so the one place that decides what
 * happens with no provider is visible.
 */
export async function deliverCode(
  mailer: Mailer,
  email: string,
  code: string,
): Promise<MailResult> {
  return mailer.deliverSignInCode(email, code);
}
