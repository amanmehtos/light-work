/**
 * The Light Week API.
 *
 * The Worker is deliberately thin: it authenticates the request, works out
 * which account's Durable Object owns the data, and forwards. All task state
 * lives in that object, so the Worker holds no per-account state and can be
 * replaced without a migration.
 */

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import { PROTOCOL_VERSION, type Op } from "@light/core";
import { handleMcpRequest } from "./mcp.js";
import {
  deliverCode,
  isValidEmail,
  issueLoginCode,
  pruneExpired,
  resolveSession,
  revokeSession,
  verifyLoginCode,
  type Session,
} from "./auth.js";

export { Account } from "./account.js";

type Vars = { session: Session; token: string };

/**
 * Passes a payload the Durable Object has already serialised straight through.
 *
 * Going via Hono's `json()` would re-infer the whole response shape, which the
 * protocol's recursive JSON type cannot survive; and the body is already a
 * string, so there is nothing left to serialise.
 */
function rawJson(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
}

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

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

app.get("/", (c) =>
  c.json({
    name: "light-week-api",
    protocol: PROTOCOL_VERSION,
    docs: "https://github.com/amanmehtos/light-suite",
  }),
);

/* ------------------------------------------------------------------ */
/* auth                                                               */
/* ------------------------------------------------------------------ */

app.post("/auth/request-code", async (c) => {
  type RequestBody = { email?: string };
  const body = await c.req.json<RequestBody>().catch((): RequestBody => ({}));
  const email = body.email;
  if (email === undefined || !isValidEmail(email)) {
    return c.json({ error: "a valid email is required" }, 400);
  }

  const code = await issueLoginCode(c.env.AUTH_DB, email);
  const result = await deliverCode(c.env, email, code);

  // Always the same response shape, so the endpoint cannot be used to find out
  // which addresses have accounts.
  return c.json({
    ok: true,
    ...(result.devCode !== undefined ? { devCode: result.devCode } : {}),
  });
});

app.post("/auth/verify-code", async (c) => {
  type VerifyBody = { email?: string; code?: string; device?: string };
  const body = await c.req.json<VerifyBody>().catch((): VerifyBody => ({}));
  if (body.email === undefined || body.code === undefined) {
    return c.json({ error: "email and code are required" }, 400);
  }

  const result = await verifyLoginCode(
    c.env.AUTH_DB,
    body.email,
    body.code,
    body.device ?? c.req.header("User-Agent") ?? "",
  );

  if (!result.ok) {
    const status = result.reason === "too_many_attempts" ? 429 : 401;
    return c.json({ error: result.reason ?? "invalid code" }, status);
  }
  return c.json({ token: result.token, user: result.user });
});

/* ------------------------------------------------------------------ */
/* everything below needs a session                                   */
/* ------------------------------------------------------------------ */

/**
 * Requires a session on everything it covers.
 *
 * Mounted on a wildcard so that any route added later is protected by default;
 * the one exception is the WebSocket upgrade, which cannot carry an
 * Authorization header and so authenticates itself from the query string.
 */
const SELF_AUTHENTICATING_PATHS = new Set(["/sync/socket"]);

const bearerAuth = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  if (SELF_AUTHENTICATING_PATHS.has(new URL(c.req.url).pathname)) {
    await next();
    return;
  }

  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") === true ? header.slice(7) : undefined;
  if (token === undefined || token === "") {
    return c.json({ error: "missing bearer token" }, 401);
  }
  const session = await resolveSession(c.env.AUTH_DB, token);
  if (session === null) {
    return c.json({ error: "invalid or expired session" }, 401);
  }
  c.set("session", session);
  c.set("token", token);
  await next();
});

app.use("/sync/*", bearerAuth);
app.use("/account/*", bearerAuth);
app.use("/mcp", bearerAuth);

/** Each account's data lives in the Durable Object named after its user id. */
function accountFor(env: Env, userId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(userId));
}

app.get("/account/me", (c) => c.json(c.get("session").user));

app.post("/account/logout", async (c) => {
  await revokeSession(c.env.AUTH_DB, c.get("token"));
  return c.json({ ok: true });
});

app.get("/account/stats", async (c) => {
  const stub = accountFor(c.env, c.get("session").user.id);
  return c.json(await stub.stats());
});

/* ------------------------------------------------------------------ */
/* sync                                                               */
/* ------------------------------------------------------------------ */

/** Full state for a cold client. */
app.get("/sync/snapshot", async (c) => {
  const stub = accountFor(c.env, c.get("session").user.id);
  return rawJson(await stub.snapshotJson());
});

/** Incremental catch-up from a cursor. */
app.get("/sync/pull", async (c) => {
  const since = Number(c.req.query("since") ?? "0");
  if (!Number.isInteger(since) || since < 0) {
    return c.json({ error: "since must be a non-negative integer" }, 400);
  }
  const stub = accountFor(c.env, c.get("session").user.id);
  return rawJson(await stub.pullJson(since));
});

/** Push local mutations and receive whatever the client has not seen. */
app.post("/sync", async (c) => {
  const body = await c.req
    .json<{ version?: number; since?: number; ops?: Op[] }>()
    .catch(() => null);

  if (body === null) return c.json({ error: "body must be JSON" }, 400);
  if (body.version !== PROTOCOL_VERSION) {
    return c.json(
      { error: `unsupported protocol version ${String(body.version)}; this server speaks ${PROTOCOL_VERSION}` },
      400,
    );
  }
  if (!Array.isArray(body.ops)) return c.json({ error: "ops must be an array" }, 400);

  const since = body.since ?? 0;
  if (!Number.isInteger(since) || since < 0) {
    return c.json({ error: "since must be a non-negative integer" }, 400);
  }

  const stub = accountFor(c.env, c.get("session").user.id);
  try {
    return rawJson(await stub.pushJson(since, JSON.stringify(body.ops)));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "push failed" }, 400);
  }
});

/**
 * The realtime channel.
 *
 * Authenticated over the query string rather than a header, because the browser
 * WebSocket API cannot set one. The token is single-purpose and the connection
 * is TLS, so this is the standard trade; it is still a session token, so it is
 * never logged.
 */
app.get("/sync/socket", async (c) => {
  const token = c.req.query("token");
  if (token === undefined || token === "") {
    return c.json({ error: "token query parameter is required" }, 401);
  }
  const session = await resolveSession(c.env.AUTH_DB, token);
  if (session === null) return c.json({ error: "invalid or expired session" }, 401);

  const stub = accountFor(c.env, session.user.id);
  return stub.fetch(c.req.raw);
});

/* ------------------------------------------------------------------ */
/* MCP                                                               */
/* ------------------------------------------------------------------ */

/**
 * The built-in MCP endpoint.
 *
 * Authenticated with the same bearer token as the rest of the API, so an agent
 * is given a session token rather than a second kind of credential. Proper
 * OAuth, which lets a user grant an agent access without handing over a token
 * at all, is the next step here.
 */
app.all("/mcp", async (c) => {
  const session = c.get("session");
  const stub = accountFor(c.env, session.user.id);
  return handleMcpRequest(c.req.raw, { stub });
});

app.onError((error, c) => {
  console.error("unhandled", error);
  return c.json({ error: "internal error" }, 500);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,

  /** Housekeeping: expire sessions and codes. Wire to a cron trigger. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await pruneExpired(env.AUTH_DB);
  },
} satisfies ExportedHandler<Env>;
