import { beforeEach, describe, expect, it } from "vitest";
import { Clock, encodeHLC, newId, type Op } from "@light/core";
import { MemoryAccountStore } from "../src/adapters/memory.js";
import { NodeSqliteDriver } from "../src/adapters/node-sqlite.js";
import { SqlAccountStore } from "../src/sql.js";
import type { AccountStore } from "../src/ports.js";

/**
 * One suite, run against every implementation of the account store.
 *
 * This is the point of having a port at all. Two backends that agree on the
 * HTTP surface but disagree about, say, whether a replayed op is accepted
 * would produce a sync bug that only appears after a migration, by which time
 * it is somebody's lost data. Running the same assertions against both is the
 * only way to keep them honest — and it is what makes adding a third backend a
 * matter of making this file pass rather than of reading the Cloudflare one
 * and hoping.
 */

const backends: { name: string; create: () => Promise<AccountStore> }[] = [
  {
    name: "in-memory",
    create: async () => new MemoryAccountStore(),
  },
  {
    name: "SQL on node:sqlite",
    create: async () => {
      const store = new SqlAccountStore(new NodeSqliteDriver());
      await store.migrate();
      return store;
    },
  },
];

describe.each(backends)("$name", ({ create }) => {
  let store: AccountStore;
  let clock: Clock;

  beforeEach(async () => {
    store = await create();
    clock = new Clock("device-a");
  });

  function op(partial: Partial<Op> & { entityId: string }): Op {
    return {
      id: newId(),
      kind: "task",
      type: "upsert",
      clock: encodeHLC(clock.next()),
      node: clock.node,
      ...partial,
    };
  }

  function deleteOp(entityId: string): Op {
    return {
      id: newId(),
      kind: "task",
      entityId,
      type: "delete",
      clock: encodeHLC(clock.next()),
      node: clock.node,
    };
  }

  it("starts empty", async () => {
    const snapshot = await store.snapshot();
    expect(snapshot.cursor).toBe(0);
    expect(snapshot.entities.task ?? []).toHaveLength(0);
  });

  it("stores a pushed entity", async () => {
    const result = await store.push(0, [
      op({ entityId: "t1", fields: { id: "t1", content: "Ship it", priority: 1 } }),
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);

    const snapshot = await store.snapshot();
    expect(snapshot.cursor).toBe(1);
    expect(snapshot.entities.task?.[0]).toMatchObject({ content: "Ship it", priority: 1 });
  });

  it("is idempotent when a push is retried", async () => {
    const single = op({ entityId: "t1", fields: { id: "t1", content: "once" } });
    await store.push(0, [single]);
    const second = await store.push(0, [single]);

    expect(second.accepted).toEqual([single.id]);
    const snapshot = await store.snapshot();
    expect(snapshot.entities.task).toHaveLength(1);
    expect(snapshot.cursor).toBe(1);
  });

  it("merges two devices editing different fields", async () => {
    const phone = new Clock("phone");
    const laptop = new Clock("laptop");

    const created = phone.next();
    await store.push(0, [
      {
        id: newId(),
        kind: "task",
        entityId: "t1",
        type: "upsert",
        fields: { id: "t1", content: "Draft", priority: 4 },
        clock: encodeHLC(created),
        node: "phone",
      },
    ]);
    laptop.observe(created);

    await store.push(1, [
      {
        id: newId(),
        kind: "task",
        entityId: "t1",
        type: "upsert",
        fields: { priority: 1 },
        clock: encodeHLC(phone.next()),
        node: "phone",
      },
    ]);
    await store.push(2, [
      {
        id: newId(),
        kind: "task",
        entityId: "t1",
        type: "upsert",
        fields: { content: "Ready pitch deck" },
        clock: encodeHLC(laptop.next()),
        node: "laptop",
      },
    ]);

    const snapshot = await store.snapshot();
    expect(snapshot.entities.task?.[0]).toMatchObject({
      content: "Ready pitch deck",
      priority: 1,
    });
  });

  it("pulls incrementally from a cursor", async () => {
    await store.push(0, [
      op({ entityId: "t1", fields: { id: "t1", content: "one" } }),
      op({ entityId: "t2", fields: { id: "t2", content: "two" } }),
    ]);

    const page = await store.pull(1);
    expect(page.ops).toHaveLength(1);
    expect(page.ops[0]!.entityId).toBe("t2");
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(2);
  });

  it("returns what the pushing client has not seen", async () => {
    await store.push(0, [op({ entityId: "t1", fields: { id: "t1", content: "from elsewhere" } })]);
    const result = await store.push(0, [
      op({ entityId: "t2", fields: { id: "t2", content: "mine" } }),
    ]);
    expect(result.ops.map((each) => each.entityId)).toContain("t1");
  });

  it("removes a deleted entity from the snapshot", async () => {
    await store.push(0, [op({ entityId: "t1", fields: { id: "t1", content: "doomed" } })]);
    await store.push(1, [deleteOp("t1")]);
    expect((await store.snapshot()).entities.task ?? []).toHaveLength(0);
  });

  it("revives an entity when an edit lands after the delete", async () => {
    await store.push(0, [op({ entityId: "t1", fields: { id: "t1", content: "doomed" } })]);
    await store.push(1, [deleteOp("t1")]);
    await store.push(2, [op({ entityId: "t1", fields: { content: "back" } })]);

    const snapshot = await store.snapshot();
    expect(snapshot.entities.task).toHaveLength(1);
    expect(snapshot.entities.task?.[0]).toMatchObject({ content: "back" });
  });

  it("rejects an unknown kind without failing the rest of the push", async () => {
    const result = await store.push(0, [
      { ...op({ entityId: "x1" }), kind: "wormhole" as never },
      op({ entityId: "t1", fields: { id: "t1", content: "fine" } }),
    ]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("wormhole");
    expect(result.accepted).toHaveLength(1);
  });

  it("rejects an op with no clock", async () => {
    const result = await store.push(0, [{ ...op({ entityId: "t1" }), clock: "" }]);
    expect(result.rejected[0]!.reason).toContain("clock");
  });

  it("refuses a push larger than the limit", async () => {
    const ops = Array.from({ length: 1001 }, (_unused, index) =>
      op({ entityId: `t${index}`, fields: { id: `t${index}` } }),
    );
    await expect(store.push(0, ops)).rejects.toThrow(/exceeds/);
  });

  it("pages a pull beyond the page size", async () => {
    const ops = Array.from({ length: 600 }, (_unused, index) =>
      op({ entityId: `t${index}`, fields: { id: `t${index}`, content: `t${index}` } }),
    );
    await store.push(0, ops);

    const first = await store.pull(0);
    expect(first.ops).toHaveLength(500);
    expect(first.hasMore).toBe(true);

    const second = await store.pull(first.cursor);
    expect(second.ops).toHaveLength(100);
    expect(second.hasMore).toBe(false);
  });

  it("survives an import-sized batch", async () => {
    const ops = Array.from({ length: 400 }, (_unused, index) =>
      op({ entityId: `t${index}`, fields: { id: `t${index}`, content: `task ${index}` } }),
    );
    const result = await store.push(0, ops);
    expect(result.accepted).toHaveLength(400);
    expect((await store.snapshot()).entities.task).toHaveLength(400);
  });

  it("prunes history past retention but keeps live state", async () => {
    await store.push(0, [op({ entityId: "t1", fields: { id: "t1", content: "keep me" } })]);
    const result = await store.compact(Date.now() + 365 * 86_400_000);
    expect(result.prunedOps).toBe(1);
    expect((await store.snapshot()).entities.task).toHaveLength(1);
  });

  it("drops tombstones once no op refers to them", async () => {
    await store.push(0, [op({ entityId: "t1", fields: { id: "t1", content: "temporary" } })]);
    await store.push(1, [deleteOp("t1")]);

    expect((await store.stats()).tombstones).toBe(1);
    const result = await store.compact(Date.now() + 365 * 86_400_000);
    expect(result.prunedTombstones).toBe(1);
    expect((await store.stats()).tombstones).toBe(0);
  });

  it("tells a client whose cursor predates retained history to re-snapshot", async () => {
    for (let i = 0; i < 5; i++) {
      await store.push(0, [op({ entityId: `t${i}`, fields: { id: `t${i}` } })]);
    }
    await store.compact(Date.now() + 365 * 86_400_000);

    // Everything the client knew about has been pruned away.
    const result = await store.push(3, [op({ entityId: "new", fields: { id: "new" } })]);
    expect(result.stale).toBe(true);
    expect(result.ops).toHaveLength(0);
  });

  it("never reissues a sequence number, even after history is pruned", async () => {
    // The regression this exists for: deriving the cursor from the log meant
    // that compaction reset it, and the next op reused a sequence a client had
    // already seen and would therefore ignore.
    await store.push(0, [op({ entityId: "t1", fields: { id: "t1" } })]);
    await store.push(1, [op({ entityId: "t2", fields: { id: "t2" } })]);
    const before = (await store.stats()).cursor as number;
    expect(before).toBe(2);

    await store.compact(Date.now() + 365 * 86_400_000);
    expect((await store.stats()).cursor).toBe(before);

    await store.push(before, [op({ entityId: "t3", fields: { id: "t3" } })]);
    const after = await store.pull(before);
    expect(after.ops).toHaveLength(1);
    expect(after.ops[0]!.seq).toBeGreaterThan(before);
  });

  it("keeps the cursor it advertises after compaction", async () => {
    await store.push(0, [op({ entityId: "t1", fields: { id: "t1" } })]);
    const cursor = (await store.snapshot()).cursor;
    await store.compact(Date.now() + 365 * 86_400_000);
    // A snapshot that advertised a lower cursor would send clients backwards.
    expect((await store.snapshot()).cursor).toBe(cursor);
  });

  it("reports statistics", async () => {
    await store.push(0, [op({ entityId: "t1", fields: { id: "t1", content: "counted" } })]);
    const stats = await store.stats();
    expect(stats.cursor).toBe(1);
    expect(stats.liveEntities).toBe(1);
    expect(stats.ops).toBe(1);
  });
});
