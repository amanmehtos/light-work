/**
 * Sign-in with Google.
 *
 * The authorization-code flow, server side: the browser is sent to Google, comes
 * back with a one-time code, and the Worker exchanges that code for tokens over
 * its own TLS connection using the client secret. The alternative — Google
 * Identity Services handing an ID token straight to the page — would put the
 * verification burden in the browser and still need a server round trip to mint
 * a session, so it buys nothing here.
 *
 * Like the rest of this package, nothing below knows which cloud it runs on; it
 * needs `fetch` and WebCrypto, both of which are platform baseline.
 */

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Where Google sends the browser back. Must match a URI registered on the
   * OAuth client *exactly*, so it is configurable rather than derived: behind
   * the dev server the browser uses `/api/auth/google/callback` while the
   * Worker only ever sees `/auth/google/callback`.
   */
  redirectUri: string;
  /** Where the SPA lives, for the final hand-off. Same origin in production. */
  appUrl: string;
}

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** How long a sign-in may sit half-finished before the state is stale. */
const STATE_TTL_MS = 10 * 60_000;

export interface GoogleIdentity {
  email: string;
  name: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * CSRF state, signed rather than stored.
 *
 * The obvious implementation is a row per sign-in attempt, but D1's write
 * budget is the whole reason the task graph lives in a Durable Object (see
 * docs/architecture.md) and a redirect is not worth spending it on. An HMAC
 * over a nonce and a timestamp proves the callback belongs to a flow this
 * Worker started, which is all state is for.
 */
export async function issueState(config: GoogleConfig, now: number = Date.now()): Promise<string> {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ n: base64UrlEncode(nonce), t: now })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(config.clientSecret), new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyState(
  config: GoogleConfig,
  state: string,
  now: number = Date.now(),
): Promise<boolean> {
  const [payload, signature] = state.split(".");
  if (payload === undefined || signature === undefined) return false;

  const expected = await crypto.subtle.sign("HMAC", await hmacKey(config.clientSecret), new TextEncoder().encode(payload));
  if (base64UrlEncode(new Uint8Array(expected)) !== signature) return false;

  try {
    const { t } = JSON.parse(base64UrlDecode(payload)) as { t?: number };
    return typeof t === "number" && now - t < STATE_TTL_MS && now - t > -STATE_TTL_MS;
  } catch {
    return false;
  }
}

export async function authorizeUrl(config: GoogleConfig, now: number = Date.now()): Promise<string> {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", await issueState(config, now));
  // Always offer the account chooser: one browser, more than one Google
  // account is the normal case, and silently reusing the last one is a
  // surprising way to end up in the wrong task list.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/**
 * Reads the claims out of an ID token without checking its signature.
 *
 * That is safe *here* and nowhere else: this token did not come through the
 * browser, it came back on the Worker's own TLS connection to Google's token
 * endpoint, authenticated with the client secret. Google documents this
 * exact exemption for the code flow. The checks below are therefore about
 * catching a misconfigured client, not a forged token — if this function is
 * ever reused for a token that arrived from a client, it needs full JWKS
 * verification first.
 */
function readIdToken(idToken: string, clientId: string, now: number): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts[1] === undefined) throw new Error("malformed id_token");

  const claims = JSON.parse(base64UrlDecode(parts[1])) as {
    iss?: string;
    aud?: string;
    exp?: number;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
  };

  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") {
    throw new Error("unexpected issuer");
  }
  if (claims.aud !== clientId) throw new Error("token issued for another client");
  if (typeof claims.exp === "number" && claims.exp * 1000 < now) throw new Error("expired id_token");

  // A Google account can carry an unverified address; treating one as proof of
  // identity would let anyone claim another person's account by signing up with
  // their address elsewhere.
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (typeof claims.email !== "string" || !verified) throw new Error("no verified email on the account");

  return { email: claims.email, name: typeof claims.name === "string" ? claims.name : "" };
}

export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  now: number = Date.now(),
): Promise<GoogleIdentity> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    // Google's error body names the misconfiguration (redirect_uri_mismatch and
    // invalid_client being the two that actually happen), and it is worth
    // keeping: without it this is an unattributable 500 during setup.
    throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  }

  const { id_token } = (await response.json()) as { id_token?: string };
  if (typeof id_token !== "string") throw new Error("no id_token in the token response");

  return readIdToken(id_token, config.clientId, now);
}
