import { beforeEach, describe, expect, it } from "vitest";
import { Clock, encodeHLC, newId, type Op } from "@light/core";
import { createApp } from "../src/app.js";
import {
  DevMailer,
  MemoryAccountStores,
  MemoryAuthStore,
  MemoryRealtime,
} from "../src/adapters/memory.js";

/**
 * The whole API, with no cloud underneath it.
 *
 * These run in plain node against the in-memory adapters, which is only
 * possible because nothing above `ports.ts` knows where it is deployed. The
 * Cloudflare suite in services/api covers the same surface inside workerd; if
 * the two ever disagree, the difference is in an adapter rather than in the
 * server, which is exactly where it is cheap to find.
 */

let app: ReturnType<typeof createApp>;
let realtime: MemoryRealtime;
let seq = 0;

beforeEach(() => {
  realtime = new MemoryRealtime();
  app = createApp({
    accounts: new MemoryAccountStores(),
    auth: new MemoryAuthStore(),
    realtime,
    mailer: new DevMailer(),
    platform: "test",
  });
});

async function json(response: Response): Promise<any> {
  const text = await response.text();
  return text === "" ? null : JSON.parse(text);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.test${path}`, init);
}

async function signIn(): Promise<{ token: string; email: string }> {
  const email = `user${seq++}-${Date.now()}@example.com`;

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
  const { token } = await json(verified);
  return { token, email };
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
}

describe("the service", () => {
  it("says which platform it is running on", async () => {
    const body = await json(await app.fetch(request("/")));
    expect(body.platform).toBe("test");
    expect(body.protocol).toBe(1);
  });
});

describe("auth", () => {
  it("signs a new user in with an emailed code", async () => {
    const { token, email } = await signIn();
    const me = await app.fetch(request("/account/me", authed(token)));
    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({ email });
  });

  it("rejects an invalid email", async () => {
    const response = await app.fetch(
      request("/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("locks a code out after repeated wrong guesses", async () => {
    const email = `locked-${Date.now()}@example.com`;
    const requested = await app.fetch(
      request("/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
    const { devCode } = await json(requested);

    for (let i = 0; i < 5; i++) {
      await app.fetch(
        request("/auth/verify-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code: "111111" }),
        }),
      );
    }

    const response = await app.fetch(
      request("/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: devCode }),
      }),
    );
    expect([401, 429]).toContain(response.status);
  });

  it("refuses sync without a token", async () => {
    expect((await app.fetch(request("/sync/snapshot"))).status).toBe(401);
  });

  it("stops working after logout", async () => {
    const { token } = await signIn();
    await app.fetch(request("/account/logout", authed(token, { method: "POST" })));
    expect((await app.fetch(request("/account/me", authed(token)))).status).toBe(401);
  });
});

describe("sync", () => {
  function op(clock: Clock, partial: Partial<Op> & { entityId: string }): Op {
    return {
      id: newId(),
      kind: "task",
      type: "upsert",
      clock: encodeHLC(clock.next()),
      node: clock.node,
      ...partial,
    };
  }

  it("stores a pushed entity and returns it in a snapshot", async () => {
    const { token } = await signIn();
    const clock = new Clock("device-a");

    const pushed = await app.fetch(
      request(
        "/sync",
        authed(token, {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            since: 0,
            ops: [op(clock, { entityId: "t1", fields: { id: "t1", content: "Ship it" } })],
          }),
        }),
      ),
    );
    expect(pushed.status).toBe(200);
    expect((await json(pushed)).accepted).toHaveLength(1);

    const snapshot = await json(await app.fetch(request("/sync/snapshot", authed(token))));
    expect(snapshot.entities.task).toHaveLength(1);
    expect(snapshot.entities.task[0]).toMatchObject({ content: "Ship it" });
  });

  it("keeps accounts apart", async () => {
    const first = await signIn();
    const clock = new Clock("device-a");
    await app.fetch(
      request(
        "/sync",
        authed(first.token, {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            since: 0,
            ops: [op(clock, { entityId: "t1", fields: { id: "t1", content: "mine" } })],
          }),
        }),
      ),
    );

    const second = await signIn();
    const snapshot = await json(await app.fetch(request("/sync/snapshot", authed(second.token))));
    expect(snapshot.entities.task ?? []).toHaveLength(0);
  });

  it("notifies the account's other devices after a push", async () => {
    const { token } = await signIn();
    const clock = new Clock("phone");
    await app.fetch(
      request(
        "/sync",
        authed(token, {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            since: 0,
            ops: [op(clock, { entityId: "t1", fields: { id: "t1" } })],
          }),
        }),
      ),
    );
    expect(realtime.notices).toHaveLength(1);
    expect(realtime.notices[0]).toMatchObject({ cursor: 1, node: "phone" });
  });

  it("does not notify when a push changed nothing", async () => {
    const { token } = await signIn();
    await app.fetch(
      request(
        "/sync",
        authed(token, { method: "POST", body: JSON.stringify({ version: 1, since: 0, ops: [] }) }),
      ),
    );
    expect(realtime.notices).toHaveLength(0);
  });

  it("rejects a mismatched protocol version", async () => {
    const { token } = await signIn();
    const response = await app.fetch(
      request(
        "/sync",
        authed(token, { method: "POST", body: JSON.stringify({ version: 99, since: 0, ops: [] }) }),
      ),
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error).toContain("unsupported protocol version");
  });

  it("says plainly when a deployment has no realtime channel", async () => {
    const { token } = await signIn();
    // The in-memory realtime implements notify but not upgrade, which is the
    // shape a runtime without sockets would have.
    const response = await app.fetch(request(`/sync/socket?token=${token}`));
    expect(response.status).toBe(501);
    expect((await json(response)).error).toContain("poll");
  });
});
