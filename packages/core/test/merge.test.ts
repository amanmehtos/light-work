import { describe, expect, it } from "vitest";
import { Clock, encodeHLC } from "../src/hlc.js";
import { applyOp, applyOps, isLive, type Record_ } from "../src/merge.js";
import type { Op } from "../src/protocol.js";

interface Doc {
  content?: string;
  priority?: number;
  projectId?: string;
  createdAt?: string;
}

let counter = 0;
function op(partial: Partial<Op> & { clock: string }): Op {
  return {
    id: `op-${counter++}`,
    kind: "task",
    entityId: "t1",
    type: "upsert",
    node: "a",
    ...partial,
  };
}

/** Two devices whose wall clocks are frozen at different times. */
function clocks() {
  return {
    phone: new Clock("phone", () => 1_000),
    laptop: new Clock("laptop", () => 1_000),
  };
}

describe("applyOp", () => {
  it("creates a record from nothing", () => {
    const clock = new Clock("a", () => 1000);
    const result = applyOp<Doc>(null, op({
      clock: encodeHLC(clock.next()),
      fields: { content: "Write the pitch deck", priority: 1 },
    }));
    expect(result.record.value).toEqual({ content: "Write the pitch deck", priority: 1 });
    expect(result.applied.sort()).toEqual(["content", "priority"]);
    expect(isLive(result.record)).toBe(true);
  });

  it("keeps both edits when two devices change different fields", () => {
    const { phone, laptop } = clocks();
    const created = phone.next();
    let record = applyOp<Doc>(null, op({
      node: "phone",
      clock: encodeHLC(created),
      fields: { content: "Draft", priority: 4 },
    })).record;

    // The laptop has synced, so its clock has absorbed the creation.
    laptop.observe(created);

    // Phone reschedules, laptop renames, both offline. Neither should lose.
    const phoneEdit = op({
      node: "phone",
      clock: encodeHLC(phone.next()),
      fields: { priority: 1 },
    });
    const laptopEdit = op({
      node: "laptop",
      clock: encodeHLC(laptop.next()),
      fields: { content: "Ready publisher pitch deck" },
    });

    record = applyOps<Doc>(record, [phoneEdit, laptopEdit]);
    expect(record.value).toEqual({ content: "Ready publisher pitch deck", priority: 1 });

    // And the reverse delivery order must agree.
    const other = applyOps<Doc>(
      applyOp<Doc>(null, op({
        node: "phone",
        clock: encodeHLC(created),
        fields: { content: "Draft", priority: 4 },
      })).record,
      [laptopEdit, phoneEdit],
    );
    expect(other.value).toEqual(record.value);
  });

  it("lets the later write win on the same field", () => {
    const clock = new Clock("a", () => 1000);
    const first = encodeHLC(clock.next());
    const second = encodeHLC(clock.next());

    const forward = applyOps<Doc>(null, [
      op({ clock: first, fields: { content: "old" } }),
      op({ clock: second, fields: { content: "new" } }),
    ]);
    expect(forward.value.content).toBe("new");

    // Delivered the other way round, the result must be identical.
    const reversed = applyOps<Doc>(null, [
      op({ clock: second, fields: { content: "new" } }),
      op({ clock: first, fields: { content: "old" } }),
    ]);
    expect(reversed.value.content).toBe("new");
  });

  it("reports which fields lost", () => {
    const clock = new Clock("a", () => 1000);
    const early = encodeHLC(clock.next());
    const late = encodeHLC(clock.next());
    const record = applyOp<Doc>(null, op({ clock: late, fields: { content: "new" } })).record;
    const result = applyOp<Doc>(record, op({ clock: early, fields: { content: "old", priority: 2 } }));
    expect(result.applied).toEqual(["priority"]);
    expect(result.rejected).toEqual(["content"]);
    expect(result.record.value.content).toBe("new");
  });

  it("refuses to let a client rewrite server-owned fields", () => {
    const clock = new Clock("a", () => 1000);
    const record = applyOp<Doc>(null, op({
      clock: encodeHLC(clock.next()),
      fields: { createdAt: "2026-01-01T00:00:00Z", content: "x" },
    })).record;
    const result = applyOp<Doc>(record, op({
      clock: encodeHLC(clock.next()),
      fields: { createdAt: "1999-01-01T00:00:00Z" },
    }));
    expect(result.rejected).toContain("createdAt");
    expect(result.record.value.createdAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("deletes", () => {
  it("tombstones a record", () => {
    const clock = new Clock("a", () => 1000);
    let record = applyOp<Doc>(null, op({
      clock: encodeHLC(clock.next()),
      fields: { content: "x" },
    })).record;
    record = applyOp<Doc>(record, op({ type: "delete", clock: encodeHLC(clock.next()) })).record;
    expect(isLive(record)).toBe(false);
  });

  it("revives a record when a later edit arrives, so undo crosses devices", () => {
    const clock = new Clock("a", () => 1000);
    let record = applyOp<Doc>(null, op({
      clock: encodeHLC(clock.next()),
      fields: { content: "x" },
    })).record;
    record = applyOp<Doc>(record, op({ type: "delete", clock: encodeHLC(clock.next()) })).record;
    expect(isLive(record)).toBe(false);

    const result = applyOp<Doc>(record, op({
      clock: encodeHLC(clock.next()),
      fields: { content: "back" },
    }));
    expect(result.liveBefore).toBe(false);
    expect(result.liveAfter).toBe(true);
    expect(result.record.value.content).toBe("back");
  });

  it("ignores a delete that lost to a later edit, whichever order it arrives in", () => {
    const clock = new Clock("a", () => 1000);
    const deleteClock = encodeHLC(clock.next());
    const editClock = encodeHLC(clock.next());

    const editThenDelete = applyOps<Doc>(null, [
      op({ clock: editClock, fields: { content: "edited" } }),
      op({ type: "delete", clock: deleteClock }),
    ]);
    const deleteThenEdit = applyOps<Doc>(null, [
      op({ type: "delete", clock: deleteClock }),
      op({ clock: editClock, fields: { content: "edited" } }),
    ]);

    // The delete is older than the edit, so the row survives either way.
    expect(isLive(editThenDelete)).toBe(true);
    expect(isLive(deleteThenEdit)).toBe(true);
    expect(editThenDelete).toEqual(deleteThenEdit);
  });

  it("stays deleted when the delete is the latest event", () => {
    const clock = new Clock("a", () => 1000);
    const editClock = encodeHLC(clock.next());
    const deleteClock = encodeHLC(clock.next());

    for (const ops of [
      [op({ clock: editClock, fields: { content: "x" } }), op({ type: "delete", clock: deleteClock })],
      [op({ type: "delete", clock: deleteClock }), op({ clock: editClock, fields: { content: "x" } })],
    ]) {
      expect(isLive(applyOps<Doc>(null, ops))).toBe(false);
    }
  });
});

describe("convergence", () => {
  /**
   * The property that matters: replicas that receive the same ops in different
   * orders must end up byte-identical. Without this, sync silently diverges and
   * the bug surfaces days later as a task that is wrong on one device only.
   */
  it("converges across every delivery order of a shuffled log", () => {
    const phone = new Clock("phone", () => 1_000);
    const laptop = new Clock("laptop", () => 1_000);
    const web = new Clock("web", () => 1_000);

    const log: Op[] = [];
    for (let i = 0; i < 40; i++) {
      const clock = [phone, laptop, web][i % 3]!;
      const stamp = encodeHLC(clock.next());
      if (i % 11 === 10) {
        log.push(op({ type: "delete", clock: stamp, node: clock.node }));
      } else {
        const field = (["content", "priority", "projectId"] as const)[i % 3]!;
        log.push(op({
          clock: stamp,
          node: clock.node,
          fields: { [field]: `${field}-${i}` },
        }));
      }
    }

    const canonical = applyOps<Doc>(null, log);

    const seeded = (seed: number) => {
      // Deterministic shuffle so a failure is reproducible.
      const shuffled = [...log];
      let state = seed;
      for (let i = shuffled.length - 1; i > 0; i--) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const j = state % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      return applyOps<Doc>(null, shuffled);
    };

    for (let seed = 1; seed <= 50; seed++) {
      const replica = seeded(seed);
      expect(replica.value, `seed ${seed}`).toEqual(canonical.value);
      expect(replica.deletedAt, `seed ${seed}`).toEqual(canonical.deletedAt);
      expect(replica.clocks, `seed ${seed}`).toEqual(canonical.clocks);
      expect(isLive(replica), `seed ${seed}`).toEqual(isLive(canonical));
    }
  });

  it("is idempotent, so a replayed push changes nothing", () => {
    const clock = new Clock("a", () => 1000);
    const ops = [
      op({ clock: encodeHLC(clock.next()), fields: { content: "a" } }),
      op({ clock: encodeHLC(clock.next()), fields: { priority: 2 } }),
    ];
    const once = applyOps<Doc>(null, ops);
    const twice = applyOps<Doc>(null, [...ops, ...ops]);
    expect(twice).toEqual(once);
  });
});
