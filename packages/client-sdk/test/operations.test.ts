import { beforeEach, describe, expect, it } from "vitest";
import { compareOrder } from "@light/core";
import { Operations } from "../src/operations.js";
import { LightStore } from "../src/store.js";

let store: LightStore;
let ops: Operations;

beforeEach(() => {
  store = new LightStore("test-device");
  ops = new Operations(store);
});

function project(name = "Light Week") {
  return ops.createProject({ name }).result;
}

describe("createTask", () => {
  it("places new tasks at the end of the list", () => {
    const p = project();
    const first = ops.createTask({ projectId: p.id, content: "first" }).result;
    const second = ops.createTask({ projectId: p.id, content: "second" }).result;
    const third = ops.createTask({ projectId: p.id, content: "third" }).result;

    expect(compareOrder(first.order, second.order)).toBe(-1);
    expect(compareOrder(second.order, third.order)).toBe(-1);
  });

  it("creates labels it has not seen and reuses ones it has", () => {
    const p = project();
    ops.createTask({ projectId: p.id, content: "a", labelNames: ["focus"] });
    ops.createTask({ projectId: p.id, content: "b", labelNames: ["focus", "deep"] });

    const names = store.all("label").map((l) => l.name).sort();
    expect(names).toEqual(["deep", "focus"]);
  });

  it("defaults to the lowest priority", () => {
    const p = project();
    expect(ops.createTask({ projectId: p.id, content: "x" }).result.priority).toBe(4);
  });

  it("returns ops that the store has already applied", () => {
    const p = project();
    const staged = ops.createTask({ projectId: p.id, content: "optimistic" });
    expect(staged.ops.length).toBeGreaterThan(0);
    // The read is already correct before anything is synced.
    expect(store.get("task", staged.result.id)?.content).toBe("optimistic");
  });
});

describe("completeTask", () => {
  it("marks a one-off task complete", () => {
    const p = project();
    const task = ops.createTask({ projectId: p.id, content: "once" }).result;
    const result = ops.completeTask(task.id).result;

    expect(result.task?.isCompleted).toBe(true);
    expect(result.task?.completedAt).not.toBeNull();
    expect(result.rescheduled).toBe(false);
  });

  it("reschedules a recurring task instead of completing it", () => {
    const p = project();
    const task = ops.createTask({
      projectId: p.id,
      content: "Log wishlists",
      due: {
        date: "2026-10-24",
        hasTime: false,
        text: "every saturday",
        timezone: null,
        isRecurring: true,
      },
    }).result;

    const result = ops.completeTask(task.id, "2026-10-24").result;
    expect(result.rescheduled).toBe(true);
    expect(result.task?.isCompleted).toBe(false);
    expect(result.task?.due?.date).toBe("2026-10-31");
  });

  it("completes a recurring task but reports it when the phrase is unparsable", () => {
    const p = project();
    const task = ops.createTask({
      projectId: p.id,
      content: "odd schedule",
      due: {
        date: "2026-10-24",
        hasTime: false,
        text: "every 3rd thursday of the month",
        timezone: null,
        isRecurring: true,
      },
    }).result;

    const result = ops.completeTask(task.id, "2026-10-24").result;
    expect(result.recurrenceUnderstood).toBe(false);
    expect(result.rescheduled).toBe(false);
    expect(result.task?.isCompleted).toBe(true);
  });

  it("is a no-op on a task that does not exist", () => {
    const result = ops.completeTask("nope");
    expect(result.result.task).toBeNull();
    expect(result.ops).toHaveLength(0);
  });
});

describe("reorderTask", () => {
  it("moves a task after another, writing only the task that moved", () => {
    const p = project();
    const a = ops.createTask({ projectId: p.id, content: "a" }).result;
    const b = ops.createTask({ projectId: p.id, content: "b" }).result;
    const c = ops.createTask({ projectId: p.id, content: "c" }).result;

    const staged = ops.reorderTask(c.id, a.id);
    expect(staged.ops).toHaveLength(1);
    expect(staged.ops[0]!.entityId).toBe(c.id);

    const order = store
      .all("task")
      .sort((x, y) => compareOrder(x.order, y.order))
      .map((t) => t.content);
    expect(order).toEqual(["a", "c", "b"]);
  });

  it("moves a task to the head when given null", () => {
    const p = project();
    ops.createTask({ projectId: p.id, content: "a" });
    ops.createTask({ projectId: p.id, content: "b" });
    const c = ops.createTask({ projectId: p.id, content: "c" }).result;

    ops.reorderTask(c.id, null);
    const order = store
      .all("task")
      .sort((x, y) => compareOrder(x.order, y.order))
      .map((t) => t.content);
    expect(order).toEqual(["c", "a", "b"]);
  });

  it("refuses a target that is not a sibling", () => {
    const p1 = project("one");
    const p2 = project("two");
    const a = ops.createTask({ projectId: p1.id, content: "a" }).result;
    const b = ops.createTask({ projectId: p2.id, content: "b" }).result;
    expect(() => ops.reorderTask(a.id, b.id)).toThrow(/not a sibling/);
  });
});

describe("moveTask", () => {
  it("moves a task to another project", () => {
    const from = project("from");
    const to = project("to");
    const task = ops.createTask({ projectId: from.id, content: "x" }).result;

    ops.moveTask(task.id, { projectId: to.id });
    expect(store.get("task", task.id)?.projectId).toBe(to.id);
  });

  it("refuses to move a task beneath its own subtask", () => {
    const p = project();
    const parent = ops.createTask({ projectId: p.id, content: "parent" }).result;
    const child = ops.createTask({ projectId: p.id, content: "child", parentId: parent.id }).result;

    expect(() => ops.moveTask(parent.id, { parentId: child.id })).toThrow(/own subtasks/);
  });
});

describe("deleteTask", () => {
  it("deletes subtasks with their parent, depth first", () => {
    const p = project();
    const parent = ops.createTask({ projectId: p.id, content: "parent" }).result;
    const child = ops.createTask({ projectId: p.id, content: "child", parentId: parent.id }).result;
    const grandchild = ops.createTask({
      projectId: p.id,
      content: "grandchild",
      parentId: child.id,
    }).result;

    const result = ops.deleteTask(parent.id).result;
    expect(result.deleted).toHaveLength(3);
    // Depth first, so a replay never leaves an orphan mid-way.
    expect(result.deleted.indexOf(grandchild.id)).toBeLessThan(result.deleted.indexOf(child.id));
    expect(result.deleted.indexOf(child.id)).toBeLessThan(result.deleted.indexOf(parent.id));

    expect(store.count("task")).toBe(0);
  });
});

describe("labels", () => {
  it("adds and removes a label on a task", () => {
    const p = project();
    const task = ops.createTask({ projectId: p.id, content: "x" }).result;

    ops.addLabel(task.id, "focus");
    const labelId = store.all("label").find((l) => l.name === "focus")!.id;
    expect(store.get("task", task.id)?.labelIds).toEqual([labelId]);

    ops.removeLabel(task.id, "focus");
    expect(store.get("task", task.id)?.labelIds).toEqual([]);
  });

  it("does not add the same label twice", () => {
    const p = project();
    const task = ops.createTask({ projectId: p.id, content: "x" }).result;
    ops.addLabel(task.id, "focus");
    ops.addLabel(task.id, "focus");
    expect(store.get("task", task.id)?.labelIds).toHaveLength(1);
  });
});

describe("focus sessions", () => {
  it("accumulates focused time against a task", () => {
    const p = project();
    const task = ops.createTask({ projectId: p.id, content: "deep work" }).result;

    ops.logFocusSession({
      taskId: task.id,
      startedAt: "2026-10-24T09:00:00Z",
      endedAt: "2026-10-24T09:25:00Z",
      plannedSeconds: 1500,
      focusedSeconds: 1500,
      source: "light-minute-ios",
    });
    ops.logFocusSession({
      taskId: task.id,
      startedAt: "2026-10-24T10:00:00Z",
      endedAt: "2026-10-24T10:20:00Z",
      plannedSeconds: 1500,
      focusedSeconds: 1200,
      interruptions: 2,
      outcome: "abandoned",
      source: "light-minute-ios",
    });

    const stats = ops.focusStatsForTask(task.id);
    expect(stats.sessions).toBe(2);
    expect(stats.focusedSeconds).toBe(2700);
    expect(stats.interruptions).toBe(2);
    expect(stats.lastSessionAt).toBe("2026-10-24T10:00:00Z");
  });

  it("ignores breaks when totalling focus", () => {
    const p = project();
    const task = ops.createTask({ projectId: p.id, content: "x" }).result;
    ops.logFocusSession({
      taskId: task.id,
      startedAt: "2026-10-24T09:25:00Z",
      plannedSeconds: 300,
      focusedSeconds: 300,
      kind: "short_break",
      source: "light-minute-ios",
    });
    expect(ops.focusStatsForTask(task.id).focusedSeconds).toBe(0);
  });
});
