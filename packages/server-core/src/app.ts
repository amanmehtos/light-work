/**
 * The Light Week API.
 *
 * Plain Hono over the ports in `ports.ts`: nothing here knows which cloud it is
 * running on. An adapter supplies the four implementations and calls
 * `createApp`; everything else — routing, auth, sync, MCP — is shared.
 */

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import { PROTOCOL_VERSION, type Op } from "@light/core";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/index.js";
import {
  createSession,
  deliverCode,
  findOrCreateUser,
  isValidEmail,
  issueLoginCode,
  resolveSession,
  revokeSession,
  verifyLoginCode,
} from "./auth.js";
import { authorizeUrl, exchangeCode, verifyState } from "./google.js";
import {
  authorizationServerMetadata,
  canWrite,
  canonicalResource,
  exchangeAuthorizationCode,
  formatScopes,
  issueCode,
  parseScopes,
  protectedResourceMetadata,
  redirectUriAllowed,
  refreshTokens,
  registerClient,
  resolveOAuthToken,
  resourceMatches,
  validateRegistration,
  wwwAuthenticate,
} from "./oauth.js";
import { handleMcpRequest } from "./mcp.js";
import { OAUTH_SCOPES, type OAuthScope, type ResolvedSession, type ServerContext } from "./ports.js";

type Vars = {
  session: ResolvedSession;
  token: string;
  /** What the credential is allowed to do. A session token gets everything. */
  scopes: OAuthScope[];
};

export interface AppOptions extends ServerContext {
  /** Passed through to the MCP server; Workers must supply the cfworker one. */
  jsonSchemaValidator?: jsonSchemaValidator;
}

/**
 * Passes a payload straight through without Hono's response type inference,
 * which cannot survive the protocol's recursive JSON type.
 */
function rawJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}

export function createApp(context: AppOptions) {
  const app = new Hono<{ Variables: Vars }>();
  const now = context.now ?? Date.now;

  app.use(
    "*",
    cors({
      // The desktop and iOS clients send no Origin; the web app sends its own.
      origin: (origin) => origin ?? "*",
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      credentials: false,
    }),
  );

  const serviceInfo = () => ({
    name: "light-week-api",
    protocol: PROTOCOL_VERSION,
    platform: context.platform ?? "unknown",
    docs: "https://github.com/amanmehtos/light-work",
    // Which ways in this deployment actually has, so the sign-in screen can
    // offer a Google button only where one is configured rather than showing
    // a control that fails when pressed.
    auth: { code: true, google: context.google !== undefined },
  });

  app.get("/", (c) => c.json(serviceInfo()));

  /**
   * The same thing at a fixed path.
   *
   * In the combined deployment the web app owns `/`, so `/` returns the SPA's
   * HTML rather than this. A health check needs somewhere that is the API
   * whichever way the service is deployed.
   */
  app.get("/healthz", (c) => c.json({ ...serviceInfo(), ok: true }));

  /* ---------------------------------------------------------------- */
  /* auth                                                             */
  /* ---------------------------------------------------------------- */

  app.post("/auth/request-code", async (c) => {
    type Body = { email?: string };
    const body = await c.req.json<Body>().catch((): Body => ({}));
    if (body.email === undefined || !isValidEmail(body.email)) {
      return c.json({ error: "a valid email is required" }, 400);
    }

    const code = await issueLoginCode(context.auth, body.email, now());
    const result = await deliverCode(context.mailer, body.email, code);

    // Always the same response shape, so this cannot be used to discover which
    // addresses have accounts.
    return c.json({
      ok: true,
      ...(result.devCode !== undefined ? { devCode: result.devCode } : {}),
    });
  });

  app.post("/auth/verify-code", async (c) => {
    type Body = { email?: string; code?: string; device?: string };
    const body = await c.req.json<Body>().catch((): Body => ({}));
    if (body.email === undefined || body.code === undefined) {
      return c.json({ error: "email and code are required" }, 400);
    }

    const result = await verifyLoginCode(
      context.auth,
      body.email,
      body.code,
      body.device ?? c.req.header("User-Agent") ?? "",
      now(),
    );

    if (!result.ok) {
      const status = result.reason === "too_many_attempts" ? 429 : 401;
      return c.json({ error: result.reason ?? "invalid code" }, status);
    }
    return c.json({ token: result.token, user: result.user });
  });

  /* ---------------------------------------------------------------- */
  /* sign in with Google                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Mounted only when an OAuth client is configured, so an unconfigured
   * deployment answers 404 rather than 500.
   */
  if (context.google !== undefined) {
    const google = context.google;

    app.get("/auth/google/start", async (c) => c.redirect(await authorizeUrl(google, now()), 302));

    app.get("/auth/google/callback", async (c) => {
      /** Back to the sign-in screen with something the user can act on. */
      const failed = (reason: string) =>
        c.redirect(`${google.appUrl}/#error=${encodeURIComponent(reason)}`, 302);

      // Google reports a refused consent screen this way, not as an error.
      const denied = c.req.query("error");
      if (denied !== undefined) return failed(denied);

      const code = c.req.query("code");
      const state = c.req.query("state");
      if (code === undefined || state === undefined) return failed("missing_code");
      if (!(await verifyState(google, state, now()))) return failed("bad_state");

      let identity;
      try {
        identity = await exchangeCode(google, code, now());
      } catch {
        // The detail belongs in the logs, not in a URL the user is about to
        // land on: a failure here is a setup problem, not something they can fix.
        return failed("google_sign_in_failed");
      }

      // Same account as the email code would reach. Google has proved the
      // address, which is exactly what a sign-in code proves, so the two routes
      // converge on one user rather than creating a second account per method.
      const user = await findOrCreateUser(context.auth, identity.email, now());
      const token = await createSession(context.auth, user.id, c.req.header("User-Agent") ?? "", now());

      // The fragment, never the query string: it is not sent to any server and
      // stays out of access logs and Referer headers. The app consumes it and
      // scrubs it from the address bar on arrival.
      return c.redirect(`${google.appUrl}/#token=${encodeURIComponent(token)}`, 302);
    });
  }

  /* ---------------------------------------------------------------- */
  /* everything below needs a session                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Mounted on wildcards so that any route added later is protected by
   * default. The one exception is the WebSocket upgrade, which cannot carry an
   * Authorization header and so authenticates itself from the query string.
   */
  const SELF_AUTHENTICATING = new Set(["/sync/socket"]);

  const bearerAuth = createMiddleware<{ Variables: Vars }>(async (c, next) => {
    if (SELF_AUTHENTICATING.has(new URL(c.req.url).pathname)) {
      await next();
      return;
    }

    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") === true ? header.slice(7) : undefined;
    if (token === undefined || token === "") {
      return c.json({ error: "missing bearer token" }, 401);
    }
    const session = await resolveSession(context.auth, token, now());
    if (session === null) {
      return c.json({ error: "invalid or expired session" }, 401);
    }
    c.set("session", session);
    c.set("token", token);
    await next();
  });

  app.use("/sync/*", bearerAuth);
  app.use("/account/*", bearerAuth);

  /* ---------------------------------------------------------------- */
  /* OAuth                                                            */
  /*                                                                  */
  /* This server is both the resource server and the authorization    */
  /* server. That is the simple case the MCP spec describes, and it   */
  /* avoids standing up a second service for a deployment whose whole */
  /* point is to fit on a free plan.                                  */
  /* ---------------------------------------------------------------- */

  const originOf = (c: { req: { url: string } }): string => new URL(c.req.url).origin;

  /** RFC 9728. How a client gets from a 401 to an authorization server. */
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(protectedResourceMetadata(originOf(c))),
  );

  /** The same document under the resource path, which some clients prefer. */
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(protectedResourceMetadata(originOf(c))),
  );

  /** RFC 8414. */
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(authorizationServerMetadata(originOf(c))),
  );

  /** Dynamic client registration (RFC 7591). */
  app.post("/oauth/register", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_client_metadata" }, 400);
    }
    const checked = validateRegistration(body as Record<string, unknown>);
    if (!checked.ok) {
      return c.json({ error: checked.reason }, 400);
    }
    const registered = await registerClient(
      context.auth,
      checked.name,
      checked.redirectUris,
      now(),
    );
    return c.json(registered, 201);
  });

  /**
   * The authorization endpoint.
   *
   * It cannot tell who is asking: the web app keeps its token in localStorage,
   * not a cookie, so nothing server-rendered here knows the user. So this
   * validates what it can and hands the request to the app, which is signed in
   * and can ask. The parameters travel through the browser unsigned because
   * /oauth/approve checks every one of them against the registered client
   * again — a tampered redirect URI is not one the client registered, and a
   * tampered challenge only binds the code to a verifier the tamperer cannot
   * produce.
   */
  app.get("/oauth/authorize", async (c) => {
    const query = c.req.query();
    const origin = originOf(c);

    const client = await context.auth.findClient(query.client_id ?? "");
    if (client === null) {
      return c.json({ error: "invalid_client", error_description: "unknown client" }, 400);
    }

    const redirectUri = query.redirect_uri ?? "";
    // An unregistered redirect URI is the one error that must NOT be sent to
    // that URI: doing so is the open redirect this check exists to prevent.
    if (!redirectUriAllowed(client, redirectUri)) {
      return c.json(
        { error: "invalid_request", error_description: "redirect_uri is not registered" },
        400,
      );
    }

    const bounce = (error: string): Response => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      if (query.state !== undefined) url.searchParams.set("state", query.state);
      url.searchParams.set("iss", origin);
      return c.redirect(url.toString(), 302);
    };

    if (query.response_type !== "code") return bounce("unsupported_response_type");
    if (query.code_challenge === undefined || query.code_challenge === "") {
      return bounce("invalid_request");
    }
    // OAuth 2.1 drops `plain`; accepting it would let anyone who sees the
    // authorization request replay it.
    if (query.code_challenge_method !== "S256") return bounce("invalid_request");
    if (query.resource !== undefined && !resourceMatches(query.resource, origin)) {
      return bounce("invalid_target");
    }

    // A client that asks for nothing gets everything it could have asked for,
    // which is the OAuth default-scope convention. The consent screen shows
    // exactly what is being granted either way, and a silently read-only
    // connection would fail later in a way nobody could diagnose.
    const asked = parseScopes(query.scope);
    const scopes = asked.length > 0 ? asked : [...OAUTH_SCOPES];

    // The consent screen is a page of the app, which is not always here.
    const consent = new URL("/oauth/consent", context.appUrl ?? origin);
    consent.searchParams.set("client_id", client.id);
    consent.searchParams.set("client_name", client.name);
    consent.searchParams.set("redirect_uri", redirectUri);
    consent.searchParams.set("code_challenge", query.code_challenge);
    consent.searchParams.set("scope", formatScopes(scopes));
    consent.searchParams.set("resource", query.resource ?? canonicalResource(origin));
    if (query.state !== undefined) consent.searchParams.set("state", query.state);
    return c.redirect(consent.toString(), 302);
  });

  /**
   * The grant itself, made by the signed-in user through the app.
   *
   * Authenticated with the session, which is what proves who is granting. Every
   * parameter is re-checked here rather than trusted from the redirect.
   */
  app.post("/oauth/approve", bearerAuth, async (c) => {
    const origin = originOf(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
    const client = await context.auth.findClient(clientId);
    if (client === null || !redirectUriAllowed(client, redirectUri)) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const state = typeof body.state === "string" ? body.state : null;
    const url = new URL(redirectUri);
    if (state !== null) url.searchParams.set("state", state);
    // RFC 9207: say who issued this, so a client that recorded our issuer can
    // reject a response that came from somewhere else.
    url.searchParams.set("iss", origin);

    if (body.approve !== true) {
      url.searchParams.set("error", "access_denied");
      return c.json({ redirect: url.toString() });
    }

    const resource = typeof body.resource === "string" ? body.resource : canonicalResource(origin);
    if (!resourceMatches(resource, origin)) return c.json({ error: "invalid_target" }, 400);

    const codeChallenge = typeof body.code_challenge === "string" ? body.code_challenge : "";
    if (codeChallenge === "") return c.json({ error: "invalid_request" }, 400);

    const scopes = parseScopes(typeof body.scope === "string" ? body.scope : "");
    if (scopes.length === 0) return c.json({ error: "invalid_scope" }, 400);

    const code = await issueCode(
      context.auth,
      {
        clientId: client.id,
        redirectUri,
        codeChallenge,
        scopes,
        resource: canonicalResource(origin),
        state,
      },
      c.get("session").user.id,
      now(),
    );
    url.searchParams.set("code", code);
    return c.json({ redirect: url.toString() });
  });

  /** The token endpoint. Public clients, so PKCE rather than a client secret. */
  app.post("/oauth/token", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (form === null) return c.json({ error: "invalid_request" }, 400);
    const field = (name: string): string => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };

    const grantType = field("grant_type");
    const result =
      grantType === "authorization_code"
        ? await exchangeAuthorizationCode(
            context.auth,
            {
              code: field("code"),
              clientId: field("client_id"),
              redirectUri: field("redirect_uri"),
              verifier: field("code_verifier"),
            },
            now(),
          )
        : grantType === "refresh_token"
          ? await refreshTokens(
              context.auth,
              { refreshToken: field("refresh_token"), clientId: field("client_id") },
              now(),
            )
          : { ok: false as const, reason: "unsupported_grant_type" as const };

    if (!result.ok || result.tokens === undefined) {
      return c.json({ error: result.reason ?? "invalid_grant" }, 400);
    }

    return new Response(
      JSON.stringify({
        access_token: result.tokens.accessToken,
        token_type: "Bearer",
        expires_in: result.tokens.expiresIn,
        refresh_token: result.tokens.refreshToken,
        scope: result.tokens.scope,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          // Tokens must not sit in a shared cache.
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      },
    );
  });

  /**
   * /mcp takes either kind of credential.
   *
   * An OAuth access token is the documented way and carries a scope and an
   * audience. A plain session token still works, because that is what the
   * existing setups use and breaking them to tidy this up would be rude — it is
   * simply treated as a full-powered grant.
   */
  const mcpAuth = createMiddleware<{ Variables: Vars }>(async (c, next) => {
    const origin = originOf(c);
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") === true ? header.slice(7) : undefined;

    const challenge = (error: string, description: string): Response =>
      new Response(JSON.stringify({ error: description }), {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "WWW-Authenticate": wwwAuthenticate(origin, error),
        },
      });

    if (token === undefined || token === "") {
      return challenge("invalid_request", "missing bearer token");
    }

    const granted = await resolveOAuthToken(context.auth, token, now());
    if (granted !== null) {
      // The audience check. Without it a token minted by this server for some
      // other resource would be accepted here.
      if (!resourceMatches(granted.resource, origin)) {
        return challenge("invalid_token", "token was issued for another resource");
      }
      c.set("session", { user: granted.user, expiresAt: granted.expiresAt });
      c.set("token", token);
      c.set("scopes", granted.scopes);
      await next();
      return;
    }

    const session = await resolveSession(context.auth, token, now());
    if (session === null) return challenge("invalid_token", "invalid or expired token");
    c.set("session", session);
    c.set("token", token);
    c.set("scopes", [...OAUTH_SCOPES]);
    await next();
  });

  app.use("/mcp", mcpAuth);

  app.get("/account/me", (c) => c.json(c.get("session").user));

  app.post("/account/logout", async (c) => {
    await revokeSession(context.auth, c.get("token"));
    return c.json({ ok: true });
  });

  app.get("/account/stats", async (c) => {
    const store = await context.accounts.of(c.get("session").user.id);
    return c.json(await store.stats());
  });

  /* ---------------------------------------------------------------- */
  /* sync                                                             */
  /* ---------------------------------------------------------------- */

  app.get("/sync/snapshot", async (c) => {
    const store = await context.accounts.of(c.get("session").user.id);
    return rawJson(await store.snapshot());
  });

  app.get("/sync/pull", async (c) => {
    const since = Number(c.req.query("since") ?? "0");
    if (!Number.isInteger(since) || since < 0) {
      return c.json({ error: "since must be a non-negative integer" }, 400);
    }
    const store = await context.accounts.of(c.get("session").user.id);
    return rawJson(await store.pull(since));
  });

  app.post("/sync", async (c) => {
    const body = await c.req
      .json<{ version?: number; since?: number; ops?: Op[] }>()
      .catch(() => null);

    if (body === null) return c.json({ error: "body must be JSON" }, 400);
    if (body.version !== PROTOCOL_VERSION) {
      return c.json(
        {
          error:
            `unsupported protocol version ${String(body.version)};` +
            ` this server speaks ${PROTOCOL_VERSION}`,
        },
        400,
      );
    }
    if (!Array.isArray(body.ops)) return c.json({ error: "ops must be an array" }, 400);

    const since = body.since ?? 0;
    if (!Number.isInteger(since) || since < 0) {
      return c.json({ error: "since must be a non-negative integer" }, 400);
    }

    const userId = c.get("session").user.id;
    const store = await context.accounts.of(userId);
    try {
      const result = await store.push(since, body.ops);
      if (result.accepted.length > 0) {
        await context.realtime.notify(userId, result.cursor, body.ops[0]?.node ?? "");
      }
      return rawJson(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "push failed" }, 400);
    }
  });

  /**
   * The realtime channel.
   *
   * Authenticated over the query string because the browser WebSocket API
   * cannot set a header. The token is still a session token, so it is never
   * logged. A runtime without sockets simply does not implement `upgrade`, and
   * clients fall back to polling.
   */
  app.get("/sync/socket", async (c) => {
    const token = c.req.query("token");
    if (token === undefined || token === "") {
      return c.json({ error: "token query parameter is required" }, 401);
    }
    const session = await resolveSession(context.auth, token, now());
    if (session === null) return c.json({ error: "invalid or expired session" }, 401);

    if (context.realtime.upgrade === undefined) {
      return c.json(
        { error: "this deployment does not offer a realtime channel; poll /sync/pull instead" },
        501,
      );
    }
    return context.realtime.upgrade(session.user.id, c.req.raw);
  });

  /* ---------------------------------------------------------------- */
  /* MCP                                                              */
  /* ---------------------------------------------------------------- */

/**
   * A read-only grant does not get the writing tools at all.
   *
   * Hiding them beats registering them and failing: an agent that cannot see
   * `delete_task` will not plan around it, whereas one that can see it will try
   * and then have to explain itself.
   */
  app.all("/mcp", async (c) => {
    const store = await context.accounts.of(c.get("session").user.id);
    return handleMcpRequest(c.req.raw, {
      store,
      writable: canWrite(c.get("scopes")),
      ...(context.jsonSchemaValidator !== undefined
        ? { jsonSchemaValidator: context.jsonSchemaValidator }
        : {}),
    });
  });

  app.onError((error, c) => {
    console.error("unhandled", error);
    return c.json({ error: "internal error" }, 500);
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
