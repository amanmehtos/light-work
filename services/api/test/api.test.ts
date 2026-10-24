import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Clock, encodeHLC, newId, type Op } from "@light/core";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

let seq = 0;
function uniqueEmail(): string {
  return `user${seq++}-${Date.now()}@example.com`;
}

async function signIn(email = uniqueEmail()): Promise<{ token: string; email: string }> {
  const requested = await SELF.fetch("https://api.test/auth/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(requested.status).toBe(200);
  const { devCode } = await requested.json<{ devCode?: string }>();
  expect(devCode).toBeDefined();

  const verified = await SELF.fetch("https://api.test/auth/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code: devCode, device: "vitest" }),
  });
  expect(verified.status).toBe(200);
  const { token } = await verified.json<{ token: string }>();
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

function makeOp(clock: Clock, partial: Partial<Op> & { entityId: string }): Op {
  return {
    id: newId(),
    kind: "task",
    type: "upsert",
    clock: encodeHLC(clock.next()),
    node: clock.node,
    ...partial,
  };
}

/** A delete op has no `fields` key at all, rather than an undefined one. */
function deleteOp(clock: Clock, entityId: string): Op {
  return {
    id: newId(),
    kind: "task",
    entityId,
    type: "delete",
    clock: encodeHLC(clock.next()),
    node: clock.node,
  };
}

async function push(token: string, since: number, ops: Op[]) {
  const response = await SELF.fetch(
    "https://api.test/sync",
    authed(token, { method: "POST", body: JSON.stringify({ version: 1, since, ops }) }),
  );
  return { status: response.status, body: await response.json<any>() };
}

/* ------------------------------------------------------------------ */
/* auth                                                              */
/* ------------------------------------------------------------------ */

describe("auth", () => {
  it("signs a new user in with an emailed code", async () => {
    const { token, email } = await signIn();
    const me = await SELF.fetch("https://api.test/account/me", authed(token));
    expect(me.status).toBe(200);
    expect(await me.json<{ email: string }>()).toMatchObject({ email });
  });

  it("rejects an invalid email", async () => {
    const response = await SELF.fetch("https://api.test/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects the wrong code", async () => {
    const email = uniqueEmail();
    await SELF.fetch("https://api.test/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const response = await SELF.fetch("https://api.test/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: "000000" }),
    });
    expect(response.status).toBe(401);
  });

  it("locks a code out after repeated wrong guesses", async () => {
    const email = uniqueEmail();
    const requested = await SELF.fetch("https://api.test/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const { devCode } = await requested.json<{ devCode: string }>();

    for (let i = 0; i < 5; i++) {
      await SELF.fetch("https://api.test/auth/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: "111111" }),
      });
    }

    // The real code must no longer work once the attempt budget is spent.
    const response = await SELF.fetch("https://api.test/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: devCode }),
    });
    expect([401, 429]).toContain(response.status);
  });

  it("invalidates the previous code when a new one is requested", async () => {
    const email = uniqueEmail();
    const first = await SELF.fetch("https://api.test/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const { devCode: oldCode } = await first.json<{ devCode: string }>();

    await SELF.fetch("https://api.test/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    const response = await SELF.fetch("https://api.test/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: oldCode }),
    });
    expect(response.status).toBe(401);
  });

  it("refuses sync without a token", async () => {
    const response = await SELF.fetch("https://api.test/sync/snapshot");
    expect(response.status).toBe(401);
  });

  it("refuses sync with a bogus token", async () => {
    const response = await SELF.fetch("https://api.test/sync/snapshot", authed("deadbeef"));
    expect(response.status).toBe(401);
  });

  it("stops working after logout", async () => {
    const { token } = await signIn();
    const out = await SELF.fetch("https://api.test/account/logout", authed(token, { method: "POST" }));
    expect(out.status).toBe(200);
    const after = await SELF.fetch("https://api.test/account/me", authed(token));
    expect(after.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* sync                                                              */
/* ------------------------------------------------------------------ */

describe("sync", () => {
  let token: string;
  let clock: Clock;

  beforeEach(async () => {
    ({ token } = await signIn());
    clock = new Clock(`device-${newId().slice(-6)}`);
  });

  it("stores a pushed entity and returns it in a snapshot", async () => {
    const result = await push(token, 0, [
      makeOp(clock, {
        kind: "project",
        entityId: "p1",
        fields: { id: "p1", name: "🔬 3WM 🏆 Assets", parentId: null, order: "V" },
      }),
      makeOp(clock, {
        entityId: "t1",
        fields: { id: "t1", projectId: "p1", content: "Ship Light Week v0.1", priority: 1 },
      }),
    ]);

    expect(result.status).toBe(200);
    expect(result.body.accepted).toHaveLength(2);
    expect(result.body.rejected).toHaveLength(0);

    const snapshot = await SELF.fetch("https://api.test/sync/snapshot", authed(token));
    const body = await snapshot.json<any>();
    expect(body.cursor).toBe(2);
    expect(body.entities.project).toHaveLength(1);
    expect(body.entities.task[0]).toMatchObject({ content: "Ship Light Week v0.1", priority: 1 });
  });

  it("keeps accounts separate", async () => {
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "mine" } }),
    ]);

    const other = await signIn();
    const snapshot = await SELF.fetch("https://api.test/sync/snapshot", authed(other.token));
    const body = await snapshot.json<any>();
    expect(body.cursor).toBe(0);
    expect(body.entities.task ?? []).toHaveLength(0);
  });

  it("is idempotent when a push is retried", async () => {
    const op = makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "once" } });

    const first = await push(token, 0, [op]);
    expect(first.body.accepted).toEqual([op.id]);

    // The same op id again, exactly as a client retrying a timed-out request.
    const second = await push(token, 0, [op]);
    expect(second.body.accepted).toEqual([op.id]);

    const snapshot = await SELF.fetch("https://api.test/sync/snapshot", authed(token));
    const body = await snapshot.json<any>();
    expect(body.entities.task).toHaveLength(1);
    expect(body.cursor).toBe(1);
  });

  it("merges two devices editing different fields of one task", async () => {
    const phone = new Clock("phone");
    const laptop = new Clock("laptop");

    const created = makeOp(phone, {
      entityId: "t1",
      fields: { id: "t1", content: "Draft", priority: 4 },
    });
    await push(token, 0, [created]);

    // Both devices have seen the creation, then edit different fields offline.
    laptop.observe(new Clock("phone").peek());
    const phoneEdit = makeOp(phone, { entityId: "t1", fields: { priority: 1 } });
    const laptopEdit = makeOp(laptop, { entityId: "t1", fields: { content: "Ready pitch deck" } });

    await push(token, 1, [laptopEdit]);
    await push(token, 2, [phoneEdit]);

    const snapshot = await SELF.fetch("https://api.test/sync/snapshot", authed(token));
    const body = await snapshot.json<any>();
    expect(body.entities.task[0]).toMatchObject({ content: "Ready pitch deck", priority: 1 });
  });

  it("returns a second device's changes in the push response", async () => {
    const phone = new Clock("phone");
    await push(token, 0, [
      makeOp(phone, { entityId: "t1", fields: { id: "t1", content: "from the phone" } }),
    ]);

    // The laptop pushes with a stale cursor and should be told what it missed.
    const laptop = new Clock("laptop");
    const result = await push(token, 0, [
      makeOp(laptop, { entityId: "t2", fields: { id: "t2", content: "from the laptop" } }),
    ]);

    expect(result.body.ops.map((op: Op) => op.entityId)).toContain("t1");
    expect(result.body.cursor).toBe(2);
  });

  it("pulls incrementally from a cursor", async () => {
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "one" } }),
      makeOp(clock, { entityId: "t2", fields: { id: "t2", content: "two" } }),
    ]);

    const pulled = await SELF.fetch("https://api.test/sync/pull?since=1", authed(token));
    const body = await pulled.json<any>();
    expect(body.ops).toHaveLength(1);
    expect(body.ops[0].entityId).toBe("t2");
    expect(body.hasMore).toBe(false);
  });

  it("removes a deleted entity from the snapshot", async () => {
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "doomed" } }),
    ]);
    await push(token, 1, [deleteOp(clock, "t1")]);

    const snapshot = await SELF.fetch("https://api.test/sync/snapshot", authed(token));
    const body = await snapshot.json<any>();
    expect(body.entities.task ?? []).toHaveLength(0);
  });

  it("revives an entity when an edit lands after the delete", async () => {
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "doomed" } }),
    ]);
    await push(token, 1, [deleteOp(clock, "t1")]);
    await push(token, 2, [makeOp(clock, { entityId: "t1", fields: { content: "undeleted" } })]);

    const snapshot = await SELF.fetch("https://api.test/sync/snapshot", authed(token));
    const body = await snapshot.json<any>();
    expect(body.entities.task).toHaveLength(1);
    expect(body.entities.task[0]).toMatchObject({ content: "undeleted" });
  });

  it("rejects an unknown entity kind without failing the whole push", async () => {
    const result = await push(token, 0, [
      { ...makeOp(clock, { entityId: "x1" }), kind: "wormhole" as never },
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "fine" } }),
    ]);

    expect(result.body.rejected).toHaveLength(1);
    expect(result.body.rejected[0].reason).toContain("wormhole");
    expect(result.body.accepted).toHaveLength(1);
  });

  it("rejects a mismatched protocol version", async () => {
    const response = await SELF.fetch(
      "https://api.test/sync",
      authed(token, { method: "POST", body: JSON.stringify({ version: 99, since: 0, ops: [] }) }),
    );
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain("unsupported protocol version");
  });

  it("rejects a negative cursor", async () => {
    const response = await SELF.fetch(
      "https://api.test/sync",
      authed(token, { method: "POST", body: JSON.stringify({ version: 1, since: -5, ops: [] }) }),
    );
    expect(response.status).toBe(400);
  });

  it("survives an import-sized batch", async () => {
    const ops: Op[] = [];
    for (let i = 0; i < 400; i++) {
      ops.push(
        makeOp(clock, { entityId: `t${i}`, fields: { id: `t${i}`, content: `task ${i}`, priority: 4 } }),
      );
    }
    const result = await push(token, 0, ops);
    expect(result.status).toBe(200);
    expect(result.body.accepted).toHaveLength(400);

    const snapshot = await SELF.fetch("https://api.test/sync/snapshot", authed(token));
    const body = await snapshot.json<any>();
    expect(body.entities.task).toHaveLength(400);
  });

  it("pages a pull that exceeds the page size", async () => {
    const ops: Op[] = [];
    for (let i = 0; i < 600; i++) {
      ops.push(makeOp(clock, { entityId: `t${i}`, fields: { id: `t${i}`, content: `t${i}` } }));
    }
    await push(token, 0, ops);

    const first = await SELF.fetch("https://api.test/sync/pull?since=0", authed(token));
    const firstBody = await first.json<any>();
    expect(firstBody.ops).toHaveLength(500);
    expect(firstBody.hasMore).toBe(true);

    const second = await SELF.fetch(
      `https://api.test/sync/pull?since=${firstBody.cursor}`,
      authed(token),
    );
    const secondBody = await second.json<any>();
    expect(secondBody.ops).toHaveLength(100);
    expect(secondBody.hasMore).toBe(false);
  });

  it("reports account statistics", async () => {
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "counted" } }),
    ]);
    const response = await SELF.fetch("https://api.test/account/stats", authed(token));
    const stats = await response.json<any>();
    expect(stats.cursor).toBe(1);
    expect(stats.liveEntities).toBe(1);
    expect(stats.ops).toBe(1);
    expect(stats.databaseBytes).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* realtime                                                          */
/* ------------------------------------------------------------------ */

describe("realtime", () => {
  it("greets a connecting device with the current cursor", async () => {
    const { token } = await signIn();
    const clock = new Clock("phone");
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "already here" } }),
    ]);

    const response = await SELF.fetch(`https://api.test/sync/socket?token=${token}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    const hello = await new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => resolve(event.data as string), { once: true });
    });
    expect(JSON.parse(hello)).toMatchObject({ type: "hello", cursor: 1 });
    socket.close();
  });

  it("notifies a connected device when another device pushes", async () => {
    const { token } = await signIn();
    const response = await SELF.fetch(`https://api.test/sync/socket?token=${token}`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket!;
    socket.accept();

    const messages: string[] = [];
    socket.addEventListener("message", (event) => {
      messages.push(event.data as string);
    });

    // Drain the hello before the push, so the assertion is about the notice.
    await new Promise((resolve) => setTimeout(resolve, 50));
    messages.length = 0;

    const clock = new Clock("other-device");
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "pushed elsewhere" } }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const notice = messages.map((m) => JSON.parse(m)).find((m) => m.type === "changed");
    expect(notice).toMatchObject({ type: "changed", cursor: 1 });
    socket.close();
  });

  it("refuses a socket without a token", async () => {
    const response = await SELF.fetch("https://api.test/sync/socket", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* maintenance                                                       */
/* ------------------------------------------------------------------ */

describe("compaction", () => {
  it("prunes oplog history past the retention window but keeps live state", async () => {
    const { token } = await signIn();
    const clock = new Clock("phone");
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "keep me" } }),
    ]);

    const me = await SELF.fetch("https://api.test/account/me", authed(token));
    const { id: userId } = await me.json<{ id: string }>();
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(userId));

    // Compact as if it were a year from now, so everything is past retention.
    const result = await stub.compact(Date.now() + 365 * 86_400_000);
    expect(result.prunedOps).toBe(1);

    // The task itself must survive; only its history is gone.
    const snapshot = JSON.parse(await stub.snapshotJson()) as any;
    expect(snapshot.entities.task).toHaveLength(1);
  });

  it("drops tombstones once no op refers to them", async () => {
    const { token } = await signIn();
    const clock = new Clock("phone");
    await push(token, 0, [
      makeOp(clock, { entityId: "t1", fields: { id: "t1", content: "temporary" } }),
    ]);
    await push(token, 1, [deleteOp(clock, "t1")]);

    const me = await SELF.fetch("https://api.test/account/me", authed(token));
    const { id: userId } = await me.json<{ id: string }>();
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(userId));

    const before = await stub.stats();
    expect(before.tombstones).toBe(1);

    const result = await stub.compact(Date.now() + 365 * 86_400_000);
    expect(result.prunedTombstones).toBe(1);
    expect((await stub.stats()).tombstones).toBe(0);
  });
});
