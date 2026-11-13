import { describe, expect, it, vi } from "vitest";
import type { Op } from "@light/core";
import { Operations } from "../src/operations.js";
import { LightStore } from "../src/store.js";
import { SyncClient, WebQueueStorage, type KeyValueStorage } from "../src/sync.js";

/** A `localStorage` that works, backed by a map the test can hand to a "reloaded" page. */
function workingArea(backing = new Map<string, string>()): KeyValueStorage {
  return {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value),
  };
}

/** What a private window or blocked site data does: every access throws. */
function brokenArea(): KeyValueStorage {
  const refuse = (): never => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return { getItem: refuse, setItem: refuse };
}

function someOps(count = 2): Op[] {
  const store = new LightStore("author");
  const ops = new Operations(store);
  const project = ops.createProject({ name: "Work" });
  const tasks = Array.from({ length: count - 1 }, (_, i) =>
    ops.createTask({ projectId: project.result.id, content: `task ${i}` }).ops,
  ).flat();
  return [...project.ops, ...tasks].slice(0, count);
}

describe("WebQueueStorage", () => {
  it("round-trips ops and cursor", async () => {
    const storage = new WebQueueStorage("q", () => workingArea());
    const ops = someOps(3);

    await storage.save({ ops, cursor: 42 });

    expect(await storage.load()).toEqual({ ops, cursor: 42 });
  });

  it("starts empty when nothing has been saved", async () => {
    const storage = new WebQueueStorage("q", () => workingArea());
    expect(await storage.load()).toEqual({ ops: [], cursor: 0 });
  });

  it("is read back by a fresh instance over the same storage, which is a reload", async () => {
    const backing = new Map<string, string>();
    const ops = someOps(2);
    await new WebQueueStorage("q", () => workingArea(backing)).save({ ops, cursor: 7 });

    const afterReload = new WebQueueStorage("q", () => workingArea(backing));

    expect(await afterReload.load()).toEqual({ ops, cursor: 7 });
  });

  it("keeps different keys apart, so one account's queue is not another's", async () => {
    const backing = new Map<string, string>();
    const alice = new WebQueueStorage("queue:alice", () => workingArea(backing));
    const bob = new WebQueueStorage("queue:bob", () => workingArea(backing));

    await alice.save({ ops: someOps(2), cursor: 1 });

    expect(await bob.load()).toEqual({ ops: [], cursor: 0 });
  });

  it("degrades to memory when localStorage throws, as it does in private mode", async () => {
    const storage = new WebQueueStorage("q", brokenArea);
    const ops = someOps(2);

    // Neither call may reject: the person typing a task has done nothing wrong.
    await expect(storage.save({ ops, cursor: 3 })).resolves.toBeUndefined();

    // And the queue still lasts as long as the page does.
    expect(await storage.load()).toEqual({ ops, cursor: 3 });
  });

  it("keeps working in memory when only writes fail, as a full quota does", async () => {
    const area: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    const storage = new WebQueueStorage("q", () => area);
    const ops = someOps(2);

    await storage.save({ ops, cursor: 9 });

    expect(await storage.load()).toEqual({ ops, cursor: 9 });
  });

  it("treats unparseable or misshapen contents as an empty queue", async () => {
    for (const junk of ["{not json", "null", '{"ops":"nope","cursor":1}', '{"ops":[]}', "[]"]) {
      const backing = new Map([["q", junk]]);
      const storage = new WebQueueStorage("q", () => workingArea(backing));
      expect(await storage.load()).toEqual({ ops: [], cursor: 0 });
    }
  });

  it("reaches for the global localStorage when none is given, and survives it being absent", async () => {
    vi.stubGlobal("localStorage", undefined);
    try {
      const storage = new WebQueueStorage();
      const ops = someOps(2);
      await storage.save({ ops, cursor: 1 });
      expect(await storage.load()).toEqual({ ops, cursor: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/** Just enough server to start a client against. */
function fakeServer(options: { online: boolean; entities?: Record<string, unknown[]>; cursor?: number }) {
  const received: Op[] = [];
  const state = { online: options.online };
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!state.online) throw new TypeError("Failed to fetch");
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/sync/snapshot")) {
      return json({ cursor: options.cursor ?? 10, entities: options.entities ?? {} });
    }
    if (url.includes("/sync/pull")) {
      return json({ version: 1, cursor: options.cursor ?? 10, ops: [], hasMore: false });
    }
    const body = JSON.parse(String(init?.body)) as { ops: Op[] };
    received.push(...body.ops);
    return json({
      version: 1,
      cursor: options.cursor ?? 10,
      ops: [],
      hasMore: false,
      accepted: body.ops.map((op) => op.id),
    });
  };
  return { fetchImpl, received, state };
}

function client(store: LightStore, storage: WebQueueStorage, fetchImpl: typeof fetch) {
  return new SyncClient({ baseUrl: "http://server", token: "t", store, storage, fetchImpl });
}

describe("SyncClient with a persistent queue", () => {
  it("delivers an edit made offline after the page is reloaded", async () => {
    const backing = new Map<string, string>();

    // First page load: offline, the edit is staged and cannot be sent.
    const offline = fakeServer({ online: false });
    const firstStore = new LightStore("device");
    const first = client(firstStore, new WebQueueStorage("q", () => workingArea(backing)), offline.fetchImpl);
    const staged = new Operations(firstStore).createProject({ name: "Written offline" });
    first.enqueue(staged.ops);
    await vi.waitFor(() => expect(backing.get("q")).toBeDefined());
    expect(offline.received).toEqual([]);

    // Reload: a new store, a new client, the same localStorage, and a network.
    const online = fakeServer({ online: true });
    const secondStore = new LightStore("device");
    const second = client(secondStore, new WebQueueStorage("q", () => workingArea(backing)), online.fetchImpl);
    await second.start();

    expect(online.received.map((op) => op.id)).toEqual(staged.ops.map((op) => op.id));
    expect(second.status.pending).toBe(0);
    expect(JSON.parse(backing.get("q") ?? "{}").ops).toEqual([]);
  });

  it("shows a queued edit straight after a reload, before it has reached the server", async () => {
    const backing = new Map<string, string>();
    const storage = () => new WebQueueStorage("q", () => workingArea(backing));

    const writer = new LightStore("device");
    const staged = new Operations(writer).createProject({ name: "Pending" });
    await storage().save({ ops: staged.ops, cursor: 5 });

    // The server is unreachable for pushes but the snapshot is served: the
    // closest thing to "online but the push has not landed yet".
    const server = fakeServer({ online: true });
    const store = new LightStore("device");
    const reloaded = client(store, storage(), server.fetchImpl);
    await reloaded.start();

    expect(store.get("project", staged.result.id)?.name).toBe("Pending");
  });

  it("bootstraps a store that came up empty even though the saved cursor is not zero", async () => {
    // The queue persists; the store does not. Trusting the cursor would pull
    // only what is new since it and leave the account looking empty.
    const backing = new Map<string, string>();
    await new WebQueueStorage("q", () => workingArea(backing)).save({ ops: [], cursor: 99 });

    const existing = new LightStore("elsewhere");
    const project = new Operations(existing).createProject({ name: "From the server" }).result;
    const server = fakeServer({
      online: true,
      cursor: 120,
      entities: { project: [project as unknown as Record<string, unknown>] },
    });

    const store = new LightStore("device");
    await client(store, new WebQueueStorage("q", () => workingArea(backing)), server.fetchImpl).start();

    expect(store.get("project", project.id)?.name).toBe("From the server");
  });
});
