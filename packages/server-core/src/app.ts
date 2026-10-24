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
  deliverCode,
  isValidEmail,
  issueLoginCode,
  resolveSession,
  revokeSession,
  verifyLoginCode,
} from "./auth.js";
import { handleMcpRequest } from "./mcp.js";
import type { ResolvedSession, ServerContext } from "./ports.js";

type Vars = { session: ResolvedSession; token: string };

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

  app.get("/", (c) =>
    c.json({
      name: "light-week-api",
      protocol: PROTOCOL_VERSION,
      platform: context.platform ?? "unknown",
      docs: "https://github.com/amanmehtos/light-suite",
    }),
  );

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
  app.use("/mcp", bearerAuth);

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
   * Authenticated with the same bearer token as the rest of the API, so an
   * agent is given a session token rather than a second kind of credential.
   * Proper OAuth, which lets a user grant an agent access without handing over
   * a token at all, is the next step here.
   */
  app.all("/mcp", async (c) => {
    const store = await context.accounts.of(c.get("session").user.id);
    return handleMcpRequest(c.req.raw, {
      store,
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
