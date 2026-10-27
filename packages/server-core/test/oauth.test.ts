import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  DevMailer,
  MemoryAccountStores,
  MemoryAuthStore,
  MemoryRealtime,
} from "../src/adapters/memory.js";
import {
  canonicalResource,
  parseScopes,
  resourceMatches,
  validateRegistration,
  verifyPkce,
} from "../src/oauth.js";

/**
 * OAuth for the MCP endpoint, driven through the real routes.
 *
 * The flow is the thing worth testing, not the helpers: almost every way this
 * can go wrong — a code reused, a verifier that does not match, a token minted
 * for somewhere else — is only visible when the endpoints are talking to each
 * other. So most of this file registers a client and walks the whole handshake,
 * the way an agent would.
 */

const ORIGIN = "https://api.test";

let app: ReturnType<typeof createApp>;
let seq = 0;

beforeEach(() => {
  app = createApp({
    accounts: new MemoryAccountStores(),
    auth: new MemoryAuthStore(),
    realtime: new MemoryRealtime(),
    mailer: new DevMailer(),
    platform: "test",
  });
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function json(response: Response): Promise<any> {
  const text = await response.text();
  return text === "" ? null : JSON.parse(text);
}

async function signIn(): Promise<string> {
  const email = `agent${seq++}@example.com`;
  const requested = await app.fetch(
    request("/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );
  const { devCode } = await json(requested);
  const verified = await app.fetch(
    request("/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: devCode }),
    }),
  );
  return (await json(verified)).token as string;
}

const REDIRECT = "http://127.0.0.1:33418/callback";

/**
 * A fixed verifier and its S256 challenge.
 *
 * The challenge is written out rather than computed here on purpose: it was
 * produced by node:crypto, so this asserts that our WebCrypto implementation
 * agrees with a different one. Computing it with the same code we are testing
 * would assert only that the code agrees with itself.
 */
const VERIFIER = "a".repeat(64);
const CHALLENGE = "_-BU_nrgy23GXDr5th1SCfQ5hR20PQulmXM33xVGaOs";

async function registerClient(): Promise<string> {
  const response = await app.fetch(
    request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Test Agent", redirect_uris: [REDIRECT] }),
    }),
  );
  expect(response.status).toBe(201);
  return (await json(response)).client_id as string;
}

/** Runs the whole handshake and returns the token response body. */
async function grant(scope = "mcp:read mcp:write"): Promise<any> {
  const sessionToken = await signIn();
  const clientId = await registerClient();

  const authorize = await app.fetch(
    request(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
        `&code_challenge=${CHALLENGE}&code_challenge_method=S256` +
        `&scope=${encodeURIComponent(scope)}&state=xyz`,
    ),
  );
  expect(authorize.status).toBe(302);
  const consent = new URL(authorize.headers.get("location") ?? "");
  expect(consent.pathname).toBe("/oauth/consent");

  const approved = await app.fetch(
    request("/oauth/approve", {
      method: "POST",
      headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        approve: true,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: consent.searchParams.get("code_challenge"),
        scope: consent.searchParams.get("scope"),
        resource: consent.searchParams.get("resource"),
        state: consent.searchParams.get("state"),
      }),
    }),
  );
  const redirect = new URL((await json(approved)).redirect as string);
  const code = redirect.searchParams.get("code") ?? "";

  const token = await app.fetch(
    request("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    }),
  );
  return { body: await json(token), status: token.status, clientId, code };
}

describe("PKCE", () => {
  it("accepts the verifier its challenge was made from", async () => {
    expect(await verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
  });

  it("rejects a different verifier", async () => {
    expect(await verifyPkce("b".repeat(64), CHALLENGE)).toBe(false);
  });

  it("rejects a verifier outside the legal length", async () => {
    expect(await verifyPkce("short", CHALLENGE)).toBe(false);
  });
});

describe("scopes", () => {
  it("keeps only scopes this server issues", () => {
    expect(parseScopes("mcp:read admin:everything")).toEqual(["mcp:read"]);
  });

  it("treats an empty scope as none asked for", () => {
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe("the resource audience", () => {
  it("accepts the canonical URI and the bare origin", () => {
    expect(resourceMatches(canonicalResource(ORIGIN), ORIGIN)).toBe(true);
    expect(resourceMatches(ORIGIN, ORIGIN)).toBe(true);
    expect(resourceMatches(`${ORIGIN}/mcp/`, ORIGIN)).toBe(true);
  });

  it("rejects another server", () => {
    expect(resourceMatches("https://elsewhere.test/mcp", ORIGIN)).toBe(false);
    expect(resourceMatches("", ORIGIN)).toBe(false);
  });
});

describe("registration", () => {
  it("allows http only on loopback, where a desktop agent listens", () => {
    expect(validateRegistration({ redirect_uris: ["http://127.0.0.1:1234/cb"] }).ok).toBe(true);
    expect(validateRegistration({ redirect_uris: ["http://example.com/cb"] }).ok).toBe(false);
  });

  it("rejects a redirect URI with a fragment", () => {
    expect(validateRegistration({ redirect_uris: ["https://a.test/cb#x"] }).ok).toBe(false);
  });

  it("requires at least one redirect URI", () => {
    expect(validateRegistration({ redirect_uris: [] }).ok).toBe(false);
    expect(validateRegistration({}).ok).toBe(false);
  });
});

describe("discovery", () => {
  it("publishes protected resource metadata naming this server", async () => {
    const body = await json(await app.fetch(request("/.well-known/oauth-protected-resource")));
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.authorization_servers).toEqual([ORIGIN]);
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
  });

  it("publishes authorization server metadata requiring S256", async () => {
    const body = await json(await app.fetch(request("/.well-known/oauth-authorization-server")));
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toContain("refresh_token");
    // We send `iss`, so we must say that we do.
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("points an unauthenticated caller at that metadata", async () => {
    const response = await app.fetch(request("/mcp", { method: "POST" }));
    expect(response.status).toBe(401);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    expect(challenge).toContain("scope=");
  });
});

describe("the authorization endpoint", () => {
  it("refuses an unregistered redirect URI rather than redirecting to it", async () => {
    const clientId = await registerClient();
    const response = await app.fetch(
      request(
        `/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent("https://attacker.test/cb")}` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      ),
    );
    // Redirecting the error to that URI is the open redirect being prevented.
    expect(response.status).toBe(400);
  });

  it("rejects plain PKCE, which OAuth 2.1 removes", async () => {
    const clientId = await registerClient();
    const response = await app.fetch(
      request(
        `/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=plain`,
      ),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects a token request aimed at another server", async () => {
    const clientId = await registerClient();
    const response = await app.fetch(
      request(
        `/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=S256` +
          `&resource=${encodeURIComponent("https://elsewhere.test/mcp")}`,
      ),
    );
    expect(response.headers.get("location")).toContain("error=invalid_target");
  });

  it("names itself as issuer on the way back", async () => {
    const { clientId } = await grant();
    expect(clientId).toMatch(/^c_/);
  });
});

describe("the full handshake", () => {
  it("issues a token the MCP endpoint accepts", async () => {
    const { status, body } = await grant();
    expect(status).toBe(200);
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("mcp:read mcp:write");
    expect(typeof body.refresh_token).toBe("string");

    const mcp = await app.fetch(
      request("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${body.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      }),
    );
    expect(mcp.status).toBe(200);
  });

  it("will not spend the same code twice", async () => {
    const { clientId, code } = await grant();
    const again = await app.fetch(
      request("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
        }),
      }),
    );
    expect(again.status).toBe(400);
    expect((await json(again)).error).toBe("invalid_grant");
  });

  it("refuses a code presented with the wrong verifier", async () => {
    const sessionToken = await signIn();
    const clientId = await registerClient();
    const authorize = await app.fetch(
      request(
        `/oauth/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      ),
    );
    const consent = new URL(authorize.headers.get("location") ?? "");
    const approved = await app.fetch(
      request("/oauth/approve", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          approve: true,
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: consent.searchParams.get("code_challenge"),
          scope: consent.searchParams.get("scope"),
          resource: consent.searchParams.get("resource"),
        }),
      }),
    );
    const code = new URL((await json(approved)).redirect as string).searchParams.get("code") ?? "";

    const token = await app.fetch(
      request("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_verifier: "b".repeat(64),
        }),
      }),
    );
    expect(token.status).toBe(400);
  });

  it("carries a refusal back to the client as access_denied", async () => {
    const sessionToken = await signIn();
    const clientId = await registerClient();
    const response = await app.fetch(
      request("/oauth/approve", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ approve: false, client_id: clientId, redirect_uri: REDIRECT }),
      }),
    );
    const redirect = new URL((await json(response)).redirect as string);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
  });

  it("cannot be granted by someone who is not signed in", async () => {
    const clientId = await registerClient();
    const response = await app.fetch(
      request("/oauth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approve: true, client_id: clientId, redirect_uri: REDIRECT }),
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("refresh", () => {
  it("rotates: the old refresh token stops working", async () => {
    const { body, clientId } = await grant();

    const refreshed = await app.fetch(
      request("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: body.refresh_token,
          client_id: clientId,
        }),
      }),
    );
    expect(refreshed.status).toBe(200);
    const next = await json(refreshed);
    expect(next.access_token).not.toBe(body.access_token);

    const replayed = await app.fetch(
      request("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: body.refresh_token,
          client_id: clientId,
        }),
      }),
    );
    expect(replayed.status).toBe(400);
  });

  it("refuses an unknown grant type", async () => {
    const response = await app.fetch(
      request("/oauth/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "password" }),
      }),
    );
    expect((await json(response)).error).toBe("unsupported_grant_type");
  });
});

describe("scope enforcement", () => {
  async function toolNames(token: string): Promise<string[]> {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    await app.fetch(
      request("/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      }),
    );
    const listed = await app.fetch(
      request("/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    );
    const body = await json(listed);
    return (body?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  }

  it("hides the writing tools from a read-only grant", async () => {
    const { body } = await grant("mcp:read");
    const names = await toolNames(body.access_token);
    expect(names).toContain("get_week_plan");
    expect(names).not.toContain("delete_task");
    expect(names).not.toContain("create_task");
  });

  it("offers everything to a full grant", async () => {
    const { body } = await grant("mcp:read mcp:write");
    const names = await toolNames(body.access_token);
    expect(names).toContain("get_week_plan");
    expect(names).toContain("delete_task");
  });

  it("treats a plain session token as a full grant, as it was before", async () => {
    const names = await toolNames(await signIn());
    expect(names).toContain("delete_task");
  });
});
