import { beforeEach, describe, expect, it } from "vitest";
import { compareOrder, type Task } from "@light/core";
import { compareForDay, dayKey, placeInDay, tasksOnDay } from "../src/day-order.js";
import { Operations } from "../src/operations.js";
import { LightStore } from "../src/store.js";

const TODAY = "2026-11-14";
const scope = (day: string) => ({ day, today: TODAY });

let store: LightStore;
let ops: Operations;

beforeEach(() => {
  store = new LightStore("test-device");
  ops = new Operations(store);
});

function due(date: string) {
  return { date, hasTime: false, text: null, timezone: null, isRecurring: false };
}

/** A task on the account, due `date`. */
function make(projectId: string, content: string, date: string | null = TODAY): Task {
  return ops.createTask({ projectId, content, due: date === null ? null : due(date) }).result;
}

const names = (tasks: Task[]) => tasks.map((task) => task.content);
const today = () => tasksOnDay(store.all("task"), scope(TODAY));

/** A task with only what the ordering reads. */
function bare(id: string, order: string, dayOrder: string | null = null): Task {
  return { id, order, dayOrder, content: id, isCompleted: false, due: due(TODAY) } as unknown as Task;
}

describe("what a day's list sorts by", () => {
  it("is dayOrder when the task has one, and order otherwise", () => {
    expect(dayKey({ order: "b", dayOrder: null })).toBe("b");
    expect(dayKey({ order: "b", dayOrder: "z" })).toBe("z");
  });

  it("breaks a tie by id, so the same list reads the same on every device", () => {
    const a = bare("a", "V");
    const b = bare("b", "V");
    expect([b, a].sort(compareForDay).map((task) => task.id)).toEqual(["a", "b"]);
    expect([a, b].sort(compareForDay).map((task) => task.id)).toEqual(["a", "b"]);
  });

  it("puts a reordered task among the others by its dayOrder, not at an end", () => {
    const tasks = [bare("a", "a"), bare("b", "c"), bare("c", "e", "b")];
    // `c` sorts by "b": between a ("a") and b ("c"), though its own order says last.
    expect([...tasks].sort(compareForDay).map((task) => task.id)).toEqual(["a", "c", "b"]);
  });
});

describe("tasksOnDay", () => {
  it("holds overdue work on today's list and on no other", () => {
    const inbox = ops.createProject({ name: "Inbox" }).result;
    make(inbox.id, "late", "2026-11-10");
    make(inbox.id, "now", TODAY);
    make(inbox.id, "later", "2026-11-16");
    make(inbox.id, "never", null);

    expect(names(tasksOnDay(store.all("task"), scope(TODAY)))).toEqual(["late", "now"]);
    expect(names(tasksOnDay(store.all("task"), scope("2026-11-16")))).toEqual(["later"]);
    // The 15th is empty: yesterday's overdue is not carried onto it.
    expect(tasksOnDay(store.all("task"), scope("2026-11-15"))).toEqual([]);
  });

  it("leaves out finished tasks", () => {
    const inbox = ops.createProject({ name: "Inbox" }).result;
    const done = make(inbox.id, "done");
    make(inbox.id, "open");
    ops.completeTask(done.id, TODAY);
    expect(names(tasksOnDay(store.all("task"), scope(TODAY)))).toEqual(["open"]);
  });

  it("reads the day through the caller's own rule when it has one", () => {
    const inbox = ops.createProject({ name: "Inbox" }).result;
    make(inbox.id, "late evening", "2026-11-14T23:30:00.000Z");
    // A zone east of UTC: that instant is already the 15th there.
    const eastern = (d: { date: string } | null) => (d === null ? null : d.date.startsWith("2026-11-14T23") ? "2026-11-15" : d.date.slice(0, 10));
    expect(tasksOnDay(store.all("task"), { ...scope(TODAY), dayOf: eastern })).toEqual([]);
    expect(names(tasksOnDay(store.all("task"), { ...scope("2026-11-15"), dayOf: eastern }))).toEqual(["late evening"]);
  });
});

describe("reorderInDay", () => {
  it("writes dayOrder and leaves every project's order exactly as it was", () => {
    const work = ops.createProject({ name: "Work" }).result;
    const home = ops.createProject({ name: "Home" }).result;
    make(work.id, "w1");
    make(work.id, "w2");
    make(home.id, "h1");
    make(home.id, "h2");

    const before = new Map(store.all("task").map((task) => [task.id, task.order]));
    const projectListBefore = (id: string) =>
      store.all("task").filter((task) => task.projectId === id).sort((a, b) => compareOrder(a.order, b.order)).map((task) => task.content);
    const workBefore = projectListBefore(work.id);
    const homeBefore = projectListBefore(home.id);

    const list = today();
    const last = list[list.length - 1]!;
    const moved = list[0]!;
    const staged = ops.reorderInDay(moved.id, last.id, scope(TODAY));

    // The ops themselves: every one is a dayOrder write, and none names `order`.
    expect(staged.ops.length).toBeGreaterThan(0);
    for (const op of staged.ops) {
      expect(op.kind).toBe("task");
      expect(Object.keys(op.fields ?? {})).toEqual(["dayOrder"]);
    }
    // The tasks themselves: no order moved.
    for (const task of store.all("task")) expect(task.order).toBe(before.get(task.id));
    expect(projectListBefore(work.id)).toEqual(workBefore);
    expect(projectListBefore(home.id)).toEqual(homeBefore);

    // And the day did change.
    expect(today().map((task) => task.id)[today().length - 1]).toBe(moved.id);
    expect(store.get("task", moved.id)?.dayOrder).not.toBeNull();
  });

  it("writes one task when the neighbours' keys differ", () => {
    const work = ops.createProject({ name: "Work" }).result;
    make(work.id, "a");
    make(work.id, "b");
    const c = make(work.id, "c");
    const staged = ops.reorderInDay(c.id, null, scope(TODAY));
    expect(staged.ops).toHaveLength(1);
    expect(names(today())).toEqual(["c", "a", "b"]);
  });

  it("makes room among equal keys, which is every project's first task", () => {
    const projects = ["P1", "P2", "P3"].map((name) => ops.createProject({ name }).result);
    const firsts = projects.map((project) => make(project.id, `first of ${project.name}`));
    // The first task of each project has the same order: nothing can be minted between.
    expect(new Set(firsts.map((task) => task.order)).size).toBe(1);

    const before = names(today());
    const last = today()[2]!;
    const staged = ops.reorderInDay(today()[0]!.id, today()[1]!.id, scope(TODAY));
    expect(names(today())).toEqual([before[1], before[0], before[2]]);
    // Rewritten: the run it landed in, and nothing else — still never `order`.
    for (const op of staged.ops) expect(Object.keys(op.fields ?? {})).toEqual(["dayOrder"]);
    expect(store.get("task", last.id)?.order).toBe(last.order);
    for (const task of firsts) expect(store.get("task", task.id)?.order).toBe(task.order);
  });

  it("holds against every way of dropping a task onto a list of ties", () => {
    // Exhaustive for four tied tasks: every task, dropped after every other and at the head.
    for (let moved = 0; moved < 4; moved++) {
      for (let after = -1; after < 4; after++) {
        const fresh = new LightStore("n");
        const freshOps = new Operations(fresh);
        const tasks = Array.from({ length: 4 }, (_unused, index) => {
          const project = freshOps.createProject({ name: `P${index}` }).result;
          return freshOps.createTask({ projectId: project.id, content: `t${index}`, due: due(TODAY) }).result;
        });
        const list = tasksOnDay(fresh.all("task"), scope(TODAY));
        const mover = list[moved]!;
        const afterId = after === -1 ? null : list[after]!.id;
        if (afterId === mover.id) continue;

        const expected = list.filter((task) => task.id !== mover.id).map((task) => task.id);
        expected.splice(after === -1 ? 0 : expected.indexOf(afterId!) + 1, 0, mover.id);

        freshOps.reorderInDay(mover.id, afterId, scope(TODAY));
        expect(tasksOnDay(fresh.all("task"), scope(TODAY)).map((task) => task.id)).toEqual(expected);
        expect(tasks.length).toBe(4);
      }
    }
  });

  it("reads the same on another device that only has the ops", () => {
    const work = ops.createProject({ name: "Work" });
    const home = ops.createProject({ name: "Home" });
    const sent = [...work.ops, ...home.ops];
    sent.push(...ops.createTask({ projectId: work.result.id, content: "w", due: due(TODAY) }).ops);
    sent.push(...ops.createTask({ projectId: home.result.id, content: "h", due: due(TODAY) }).ops);
    sent.push(...ops.reorderInDay(today()[1]!.id, null, scope(TODAY)).ops);

    const phone = new LightStore("phone");
    phone.applyRemote(sent);
    expect(names(tasksOnDay(phone.all("task"), scope(TODAY)))).toEqual(names(today()));
    // Not only the same sequence: the same keys, so a third device agrees too.
    for (const task of today()) expect(phone.get("task", task.id)?.dayOrder).toBe(task.dayOrder);
  });

  it("throws, and stages nothing, for a task or a neighbour that is not on the list", () => {
    const inbox = ops.createProject({ name: "Inbox" }).result;
    const here = make(inbox.id, "here");
    const elsewhere = make(inbox.id, "elsewhere", "2026-11-20");
    const dated = JSON.stringify(store.all("task"));

    expect(() => ops.reorderInDay(elsewhere.id, null, scope(TODAY))).toThrow(/not on the list/);
    expect(() => ops.reorderInDay(here.id, elsewhere.id, scope(TODAY))).toThrow(/not on the same day list/);
    expect(JSON.stringify(store.all("task"))).toBe(dated);
  });

  it("returns nothing for a task that does not exist", () => {
    expect(ops.reorderInDay("nope", null, scope(TODAY))).toEqual({ result: null, ops: [] });
  });

  it("reorders within a later day without moving anything on another", () => {
    const inbox = ops.createProject({ name: "Inbox" }).result;
    make(inbox.id, "today", TODAY);
    const a = make(inbox.id, "fri a", "2026-11-20");
    const b = make(inbox.id, "fri b", "2026-11-20");
    ops.reorderInDay(b.id, null, scope("2026-11-20"));
    expect(names(tasksOnDay(store.all("task"), scope("2026-11-20")))).toEqual(["fri b", "fri a"]);
    expect(names(today())).toEqual(["today"]);
    expect(store.get("task", a.id)?.dayOrder).toBeNull();
  });
});

describe("placeInDay", () => {
  // A small deterministic generator, so a failure is reproducible.
  function lcg(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  it("always yields the order that was asked for, whatever mix of keys and ties it starts from", () => {
    const random = lcg(7);
    const alphabet = ["V", "V", "V", "a", "a", "k", "t"];
    for (let round = 0; round < 300; round++) {
      const size = 2 + Math.floor(random() * 7);
      const list = Array.from({ length: size }, (_unused, i) =>
        bare(`t${i}`, alphabet[Math.floor(random() * alphabet.length)]!, random() < 0.3 ? "m" : null),
      ).sort(compareForDay);
      const moved = list[Math.floor(random() * size)]!;
      const rest = list.filter((task) => task.id !== moved.id);
      const slot = Math.floor(random() * (rest.length + 1));
      const afterId = slot === 0 ? null : rest[slot - 1]!.id;

      const written = new Map(placeInDay(list, moved.id, afterId).map((w) => [w.id, w.dayOrder]));
      const applied = list.map((task) => ({ ...task, dayOrder: written.get(task.id) ?? task.dayOrder }));
      const expected = [...rest.slice(0, slot).map((t) => t.id), moved.id, ...rest.slice(slot).map((t) => t.id)];
      expect(applied.sort(compareForDay).map((task) => task.id)).toEqual(expected);
    }
  });
});
