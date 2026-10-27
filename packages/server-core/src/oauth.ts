/**
 * OAuth 2.1 for the MCP endpoint.
 *
 * Agents other than Claude Code cannot be handed a token: Claude Desktop,
 * claude.ai connectors, Cursor and Zed all take a URL and run an authorization
 * flow. Without this, the only way in is to copy a session token out of the
 * browser — a credential with full read/write on the account, no audience and
 * no scope. This lets someone grant an agent a narrower thing instead.
 *
 * This server is both the resource server and the authorization server. That
 * is the simple case the MCP spec describes, and it avoids standing up a second
 * service for a deployment whose whole point is to fit on a free plan.
 *
 * Like the rest of this package it knows nothing about which cloud it runs on;
 * it needs `fetch`-era WebCrypto and a store, both of which it is given.
 */

import { sha256 } from "./auth.js";
import {
  OAUTH_SCOPES,
  type OAuthClient,
  type OAuthScope,
  type OAuthStore,
  type ResolvedOAuthToken,
} from "./ports.js";

/** Short: a code is exchanged immediately or not at all. */
export const OAUTH_CODE_TTL_MINUTES = 5;
export const ACCESS_TTL_DAYS = 30;
export const REFRESH_TTL_DAYS = 180;

function randomHex(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/* ------------------------------------------------------------------ */
/* Identifiers                                                        */
/* ------------------------------------------------------------------ */

export function newClientId(): string {
  return `c_${randomHex(16)}`;
}

export function newCode(): string {
  return randomHex(32);
}

export function newToken(): string {
  return randomHex(32);
}

/* ------------------------------------------------------------------ */
/* Scopes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads a space-delimited scope string, keeping only scopes we issue.
 *
 * An unknown scope is dropped rather than refused: RFC 6749 allows a server to
 * grant a subset, and a client asking for something we have never heard of
 * should still get the part it can have.
 */
export function parseScopes(scope: string | undefined | null): OAuthScope[] {
  if (scope === undefined || scope === null || scope.trim() === "") return [];
  const asked = new Set(scope.split(/\s+/));
  return OAUTH_SCOPES.filter((known) => asked.has(known));
}

export function formatScopes(scopes: readonly OAuthScope[]): string {
  return scopes.join(" ");
}

/** Write implies read: a grant that can edit can obviously see what it edits. */
export function canWrite(scopes: readonly OAuthScope[]): boolean {
  return scopes.includes("mcp:write");
}

/* ------------------------------------------------------------------ */
/* PKCE                                                               */
/* ------------------------------------------------------------------ */

/**
 * Checks a verifier against an S256 challenge.
 *
 * Only S256 is supported. OAuth 2.1 removes `plain`, and accepting it would let
 * anyone who sees the authorization request replay it.
 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest)) === challenge;
}

/* ------------------------------------------------------------------ */
/* Resource identity                                                  */
/* ------------------------------------------------------------------ */

/**
 * The canonical URI of this MCP server, used as the token audience.
 *
 * RFC 8707 says the most specific URI the client can give, and RFC 9728 says it
 * must match the `resource` in our own metadata — so both ends agree on
 * `<origin>/mcp`, with no trailing slash.
 */
export function canonicalResource(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

/**
 * Whether a client's `resource` names this server.
 *
 * Accepts the origin on its own as well as the full MCP path: the spec's
 * examples allow either, and a client that sends the bare origin is not wrong.
 */
export function resourceMatches(resource: string | undefined | null, origin: string): boolean {
  if (resource === undefined || resource === null || resource === "") return false;
  const normalise = (value: string): string => value.replace(/\/+$/, "").toLowerCase();
  const target = normalise(resource);
  return target === normalise(canonicalResource(origin)) || target === normalise(origin);
}

/* ------------------------------------------------------------------ */
/* Discovery documents                                                */
/* ------------------------------------------------------------------ */

/** RFC 9728. What a client fetches after the 401 tells it where to look. */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: canonicalResource(origin),
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/amanmehtos/light-work/blob/main/docs/mcp.md",
  };
}

/** RFC 8414. */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Public clients only, so there is nothing to authenticate the client with
    // at the token endpoint; PKCE does that job.
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    // RFC 9207: we return `iss` on the authorization response, so say so —
    // a client that is told this and then does not see it must reject.
    authorization_response_iss_parameter_supported: true,
  };
}

/** The challenge on a 401, which is how a client discovers all of the above. */
export function wwwAuthenticate(origin: string, error?: string, scope?: string): string {
  const parts = [
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    `scope="${scope ?? formatScopes(OAUTH_SCOPES)}"`,
  ];
  if (error !== undefined) parts.push(`error="${error}"`);
  return parts.join(", ");
}

/* ------------------------------------------------------------------ */
/* Client registration                                                */
/* ------------------------------------------------------------------ */

export interface RegistrationRequest {
  client_name?: unknown;
  redirect_uris?: unknown;
}

export type RegistrationFailure = "invalid_redirect_uri" | "invalid_client_metadata";

/**
 * Validates a dynamic registration (RFC 7591).
 *
 * Redirect URIs are the whole security boundary for a public client, so they
 * are checked here and never trusted again: everything later compares against
 * what was registered rather than against what a request asks for.
 *
 * `http` is allowed only on loopback, which is where a desktop agent listens.
 */
export function validateRegistration(
  body: RegistrationRequest,
): { ok: true; name: string; redirectUris: string[] } | { ok: false; reason: RegistrationFailure } {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { ok: false, reason: "invalid_redirect_uri" };
  }

  const redirectUris: string[] = [];
  for (const candidate of uris) {
    if (typeof candidate !== "string") return { ok: false, reason: "invalid_redirect_uri" };
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return { ok: false, reason: "invalid_redirect_uri" };
    }
    if (url.hash !== "") return { ok: false, reason: "invalid_redirect_uri" };
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !loopback) return { ok: false, reason: "invalid_redirect_uri" };
    if (url.protocol !== "http:" && url.protocol !== "https:" && !url.protocol.includes(".")) {
      // A private scheme (com.example.app:/cb) is how a native agent comes back.
      return { ok: false, reason: "invalid_redirect_uri" };
    }
    redirectUris.push(candidate);
  }

  const name = typeof body.client_name === "string" && body.client_name.trim() !== ""
    ? body.client_name.trim().slice(0, 120)
    : "An unnamed client";

  return { ok: true, name, redirectUris };
}

/** Exact string match, as RFC 7591 and OAuth 2.1 both require. */
export function redirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

/* ------------------------------------------------------------------ */
/* The grant                                                          */
/* ------------------------------------------------------------------ */

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: OAuthScope[];
  resource: string;
  state: string | null;
}

/**
 * Mints an authorization code for a request the user has just approved.
 *
 * Everything here has already been re-checked against the registered client by
 * the caller. That re-check, rather than a signature over the request, is what
 * makes it safe to carry the parameters through the browser: a tampered
 * redirect URI fails because it is not one the client registered, and a
 * tampered challenge only binds the code to a verifier the attacker cannot
 * produce a token with.
 */
export async function issueCode(
  store: OAuthStore,
  request: AuthorizationRequest,
  userId: string,
  now: number = Date.now(),
): Promise<string> {
  const code = newCode();
  await store.putCode({
    codeHash: await sha256(code),
    clientId: request.clientId,
    userId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: formatScopes(request.scopes),
    resource: request.resource,
    expiresAt: new Date(now + OAUTH_CODE_TTL_MINUTES * 60_000).toISOString(),
  });
  return code;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export async function issueTokens(
  store: OAuthStore,
  grant: { clientId: string; userId: string; scope: string; resource: string },
  now: number = Date.now(),
): Promise<IssuedTokens> {
  const accessToken = newToken();
  const refreshToken = newToken();
  const expiresAt = now + ACCESS_TTL_DAYS * 86_400_000;

  await store.createToken({
    tokenHash: await sha256(accessToken),
    refreshHash: await sha256(refreshToken),
    clientId: grant.clientId,
    userId: grant.userId,
    scope: grant.scope,
    resource: grant.resource,
    expiresAt: new Date(expiresAt).toISOString(),
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor((expiresAt - now) / 1000),
    scope: grant.scope,
  };
}

export type ExchangeFailure =
  | "invalid_grant"
  | "invalid_client"
  | "invalid_request"
  | "unsupported_grant_type";

export interface ExchangeResult {
  ok: boolean;
  reason?: ExchangeFailure;
  tokens?: IssuedTokens;
}

/**
 * Authorization code → tokens.
 *
 * The code is consumed whether or not the rest of the exchange succeeds, so a
 * failed attempt cannot be retried with a different verifier.
 */
export async function exchangeAuthorizationCode(
  store: OAuthStore,
  params: { code: string; clientId: string; redirectUri: string; verifier: string },
  now: number = Date.now(),
): Promise<ExchangeResult> {
  const record = await store.takeCode(await sha256(params.code));
  if (record === null) return { ok: false, reason: "invalid_grant" };
  if (new Date(record.expiresAt).getTime() < now) return { ok: false, reason: "invalid_grant" };
  if (record.clientId !== params.clientId) return { ok: false, reason: "invalid_client" };
  if (record.redirectUri !== params.redirectUri) return { ok: false, reason: "invalid_grant" };
  if (!(await verifyPkce(params.verifier, record.codeChallenge))) {
    return { ok: false, reason: "invalid_grant" };
  }

  return {
    ok: true,
    tokens: await issueTokens(
      store,
      {
        clientId: record.clientId,
        userId: record.userId,
        scope: record.scope,
        resource: record.resource,
      },
      now,
    ),
  };
}

/**
 * Refresh → a new pair, with the old one revoked.
 *
 * Rotation is not optional for a public client: the refresh token is sitting in
 * a config file on a laptop, so a stolen one has to stop working the moment the
 * real client uses its copy.
 */
export async function refreshTokens(
  store: OAuthStore,
  params: { refreshToken: string; clientId: string },
  now: number = Date.now(),
): Promise<ExchangeResult> {
  const record = await store.findTokenByRefresh(await sha256(params.refreshToken));
  if (record === null) return { ok: false, reason: "invalid_grant" };
  if (record.clientId !== params.clientId) return { ok: false, reason: "invalid_client" };

  await store.deleteToken(record.tokenHash);

  return {
    ok: true,
    tokens: await issueTokens(
      store,
      {
        clientId: record.clientId,
        userId: record.userId,
        scope: record.scope,
        resource: record.resource,
      },
      now,
    ),
  };
}

/**
 * An access token, if it is one of ours and still live.
 *
 * The audience is deliberately NOT checked here — the caller knows which
 * resource it is serving and checks `resource` against that, which is what
 * stops a token minted for some other server being replayed at this one.
 */
export async function resolveOAuthToken(
  store: OAuthStore,
  token: string,
  now: number = Date.now(),
): Promise<ResolvedOAuthToken | null> {
  const found = await store.findToken(await sha256(token));
  if (found === null) return null;
  if (new Date(found.expiresAt).getTime() < now) return null;
  return found;
}

/** Registers a client and returns the RFC 7591 response body. */
export async function registerClient(
  store: OAuthStore,
  name: string,
  redirectUris: string[],
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const client: OAuthClient = {
    id: newClientId(),
    name,
    redirectUris,
    createdAt: new Date(now).toISOString(),
  };
  await store.registerClient(client);
  return {
    client_id: client.id,
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_id_issued_at: Math.floor(now / 1000),
  };
}
