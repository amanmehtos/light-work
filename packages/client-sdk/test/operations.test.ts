import { beforeEach, describe, expect, it } from "vitest";
import { compareOrder, type Due } from "@light/core";
import { Operations, QuickAddRefusal, rescheduleDay, type RescheduleTarget } from "../src/operations.js";
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

describe("rewards", () => {
  /** The trophies, newest first by nothing in particular — just their contents. */
  function trophies(): string[] {
    const cabinet = store.all("project").find((candidate) => candidate.isRewards);
    if (cabinet === undefined) return [];
    return store
      .all("task")
      .filter((task) => task.projectId === cabinet.id)
      .map((task) => task.content);
  }

  it("files the reward, making the Rewards project the first time", () => {
    const p = project();
    const task = ops.createTask({
      projectId: p.id,
      content: "Ready the deck",
      reward: "An hour in the sun",
    }).result;

    expect(store.all("project").some((candidate) => candidate.isRewards)).toBe(false);
    ops.completeTask(task.id);

    const cabinet = store.all("project").find((candidate) => candidate.isRewards);
    expect(cabinet?.name).toBe("Rewards");
    expect(trophies()).toEqual(["An hour in the sun"]);

    // Second time around it files into the same project rather than a new one.
    const another = ops.createTask({ projectId: p.id, content: "Again", reward: "A long walk" }).result;
    ops.completeTask(another.id);
    expect(store.all("project").filter((candidate) => candidate.isRewards)).toHaveLength(1);
    expect(trophies().sort()).toEqual(["A long walk", "An hour in the sun"]);
  });

  it("files nothing when the task carries no reward", () => {
    const p = project();
    const task = ops.createTask({ projectId: p.id, content: "Unrewarded" }).result;
    ops.completeTask(task.id);

    expect(store.all("project").some((candidate) => candidate.isRewards)).toBe(false);
    expect(trophies()).toEqual([]);
  });

  it("files nothing when rewards are switched off", () => {
    const p = project();
    ops.setRewardsEnabled(false);
    const task = ops.createTask({
      projectId: p.id,
      content: "Ready the deck",
      reward: "An hour in the sun",
    }).result;
    ops.completeTask(task.id);

    expect(trophies()).toEqual([]);

    // Switching it back on earns the next one; the reward was never lost.
    ops.setRewardsEnabled(true);
    const another = ops.createTask({ projectId: p.id, content: "Again", reward: "A long walk" }).result;
    ops.completeTask(another.id);
    expect(trophies()).toEqual(["A long walk"]);
  });

  it("earns a repeating task its reward on every completion", () => {
    const p = project();
    const task = ops.createTask({
      projectId: p.id,
      content: "Log wishlists",
      reward: "A good coffee",
      due: {
        date: "2026-10-24",
        hasTime: false,
        text: "every saturday",
        timezone: null,
        isRecurring: true,
      },
    }).result;

    expect(ops.completeTask(task.id, "2026-10-24").result.rescheduled).toBe(true);
    expect(ops.completeTask(task.id, "2026-10-31").result.rescheduled).toBe(true);

    // Two completions, two trophies — the reward is for doing the thing, not
    // for being finished with it.
    expect(trophies()).toEqual(["A good coffee", "A good coffee"]);
  });

  it("refuses to delete the Rewards project", () => {
    const p = project();
    const task = ops.createTask({ projectId: p.id, content: "x", reward: "y" }).result;
    ops.completeTask(task.id);

    const cabinet = store.all("project").find((candidate) => candidate.isRewards);
    expect(() => ops.deleteProject(cabinet!.id)).toThrow(/rewards/i);
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

describe("deleteProject", () => {
  it("takes the project's sections and tasks with it", () => {
    const p = project();
    const section = ops.createSection({ projectId: p.id, name: "Phase one" }).result;
    const parent = ops.createTask({ projectId: p.id, content: "parent", sectionId: section.id })
      .result;
    ops.createTask({ projectId: p.id, content: "child", parentId: parent.id });

    const result = ops.deleteProject(p.id).result;

    expect(result.projects).toEqual([p.id]);
    expect(result.sections).toEqual([section.id]);
    expect(result.tasks).toHaveLength(2);
    expect(store.count("project")).toBe(0);
    expect(store.count("section")).toBe(0);
    expect(store.count("task")).toBe(0);
  });

  it("leaves child projects alone by default", () => {
    const parent = project("parent");
    const child = ops.createProject({ name: "child", parentId: parent.id }).result;

    const result = ops.deleteProject(parent.id).result;

    expect(result.projects).toEqual([parent.id]);
    expect(store.get("project", child.id)).not.toBeNull();
  });

  it("takes the subtree when asked, depth first", () => {
    const parent = project("parent");
    const child = ops.createProject({ name: "child", parentId: parent.id }).result;
    const grandchild = ops.createProject({ name: "grandchild", parentId: child.id }).result;
    ops.createTask({ projectId: grandchild.id, content: "buried" });

    const result = ops.deleteProject(parent.id, { recursive: true }).result;

    expect(result.tasks).toHaveLength(1);
    // Depth first, so replaying the ops never leaves a project whose parent
    // has already gone.
    expect(result.projects).toEqual([grandchild.id, child.id, parent.id]);
    expect(store.count("project")).toBe(0);
  });

  it("refuses to delete the inbox", () => {
    const p = project();
    // The inbox is an invariant of the account, not a flag a caller may clear.
    store.mutate("project", p.id, { isInbox: true });

    expect(() => ops.deleteProject(p.id)).toThrow(/inbox/);
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

describe("ensureInbox", () => {
  it("creates an inbox when the account has none", () => {
    const staged = ops.ensureInbox();

    expect(staged.result.name).toBe("Inbox");
    expect(staged.result.isInbox).toBe(true);
    expect(staged.result.parentId).toBeNull();
    expect(staged.ops.length).toBeGreaterThan(0);
    // Already applied locally, like every other operation.
    expect(store.get("project", staged.result.id)?.isInbox).toBe(true);
  });

  it("returns the existing inbox, staging nothing, when there is one", () => {
    const first = ops.ensureInbox().result;
    const again = ops.ensureInbox();

    expect(again.result.id).toBe(first.id);
    expect(again.ops).toEqual([]);
  });

  it("never creates a second, however often it is called", () => {
    for (let i = 0; i < 5; i++) ops.ensureInbox();

    expect(store.all("project").filter((p) => p.isInbox)).toHaveLength(1);
    expect(store.all("project")).toHaveLength(1);
  });

  it("leaves other projects alone and does not mistake them for the inbox", () => {
    const work = project("Work");
    const inbox = ops.ensureInbox().result;

    expect(inbox.id).not.toBe(work.id);
    expect(store.get("project", work.id)?.isInbox).toBe(false);
  });

  it("adopts an unflagged top-level project called Inbox instead of adding a twin", () => {
    // What the web app used to create for a brand-new account.
    const legacy = ops.createProject({ name: "Inbox" }).result;
    expect(legacy.isInbox).toBe(false);

    const staged = ops.ensureInbox();

    expect(staged.result.id).toBe(legacy.id);
    expect(staged.result.isInbox).toBe(true);
    expect(staged.ops).toHaveLength(1);
    expect(store.all("project")).toHaveLength(1);
  });

  it("does not adopt a nested project that happens to be called Inbox", () => {
    const parent = project("Work");
    ops.createProject({ name: "Inbox", parentId: parent.id });

    const inbox = ops.ensureInbox().result;

    expect(inbox.parentId).toBeNull();
    expect(store.all("project")).toHaveLength(3);
  });

  it("agrees on one inbox when two were created on different devices", () => {
    // Two devices open a new account before either has synced. Nothing can
    // stop both creating one, but both must then choose the same.
    const other = new LightStore("other-device");
    const theirs = new Operations(other).ensureInbox();
    const mine = ops.ensureInbox();
    store.applyRemote(theirs.ops);
    other.applyRemote(mine.ops);

    const chosenHere = ops.ensureInbox().result.id;
    const chosenThere = new Operations(other).ensureInbox().result.id;
    expect(chosenHere).toBe(chosenThere);
  });

  it("is what makes the inbox undeletable", () => {
    const inbox = ops.ensureInbox().result;
    expect(() => ops.deleteProject(inbox.id)).toThrow(/inbox/);
  });
});

describe("createProject with isInbox", () => {
  it("flags the project it creates", () => {
    expect(ops.createProject({ name: "Inbox", isInbox: true }).result.isInbox).toBe(true);
  });

  it("refuses to make a second inbox", () => {
    ops.createProject({ name: "Inbox", isInbox: true });
    expect(() => ops.createProject({ name: "Another", isInbox: true })).toThrow(/already has an inbox/);
    expect(store.all("project")).toHaveLength(1);
  });

  it("does not flag projects unless asked", () => {
    expect(ops.createProject({ name: "Work" }).result.isInbox).toBe(false);
  });
});

describe("createTaskFromText", () => {
  const TODAY = "2026-11-11"; // a Wednesday
  const quick = (text: string, extra: Partial<Parameters<Operations["createTaskFromText"]>[1]> = {}) =>
    ops.createTaskFromText(text, { today: TODAY, timezone: "UTC", ...extra });

  it("makes the task the plan describes, from one line", () => {
    const home = ops.createProject({ name: "Home" }).result;
    const { task, parse } = quick("pay rent tomorrow 9am p1 @errand #Home").result;

    expect(task).toMatchObject({
      content: "pay rent",
      projectId: home.id,
      priority: 1,
      due: { date: "2026-11-12T09:00:00.000Z", hasTime: true, isRecurring: false, text: null },
    });
    expect(task.labelIds).toHaveLength(1);
    expect(store.get("label", task.labelIds[0]!)?.name).toBe("errand");
    expect(parse.tokens).toHaveLength(5);
  });

  it("reads a time in the zone it is given", () => {
    ops.createProject({ name: "Home" });
    const due = quick("call mum tomorrow 9am", { timezone: "America/New_York" }).result.task.due;
    expect(due).toMatchObject({ date: "2026-11-12T14:00:00.000Z", hasTime: true, timezone: "America/New_York" });
  });

  it("leaves a date with no time all-day", () => {
    const due = quick("call mum tomorrow").result.task.due;
    expect(due).toEqual({ date: "2026-11-12", hasTime: false, text: null, timezone: null, isRecurring: false });
  });

  it("is the same task create_task would have made, field for field", () => {
    const home = ops.createProject({ name: "Home" }).result;
    const text = quick("pay rent tomorrow 9am p1 @errand #Home // landlord").result.task;
    const fields = ops.createTask({
      projectId: home.id,
      content: "pay rent",
      description: "landlord",
      priority: 1,
      labelNames: ["errand"],
      due: { date: "2026-11-12T09:00:00.000Z", hasTime: true, text: null, timezone: "UTC", isRecurring: false },
    }).result;

    const { id: _a, createdAt: _b, order: _c, ...fromText } = text;
    const { id: _d, createdAt: _e, order: _f, ...fromFields } = fields;
    expect(fromText).toEqual(fromFields);
  });

  describe("where the task goes", () => {
    it("files it in the inbox, making one in the same batch when there is none", () => {
      const staged = quick("buy milk");
      const inbox = store.all("project").filter((project) => project.isInbox);
      expect(inbox).toHaveLength(1);
      expect(staged.result.task.projectId).toBe(inbox[0]!.id);
      // Both the inbox and the task have to be in what gets pushed, or the
      // server is handed a task pointing at a project it has never heard of.
      expect(staged.ops.map((op) => op.kind)).toEqual(["project", "task"]);
    });

    it("reuses the inbox it already has", () => {
      const inbox = ops.ensureInbox().result;
      const staged = quick("buy milk");
      expect(staged.result.task.projectId).toBe(inbox.id);
      expect(staged.ops.map((op) => op.kind)).toEqual(["task"]);
    });

    it("uses the default project when the text names none", () => {
      const work = ops.createProject({ name: "Work" }).result;
      expect(quick("write report", { defaultProjectId: work.id }).result.task.projectId).toBe(work.id);
      expect(store.all("project").some((project) => project.isInbox)).toBe(false);
    });

    it("lets #Project beat the default", () => {
      const work = ops.createProject({ name: "Work" }).result;
      const home = ops.createProject({ name: "Home" }).result;
      expect(quick("fix tap #home", { defaultProjectId: work.id }).result.task.projectId).toBe(home.id);
    });

    it("does not file anything under a project that does not exist", () => {
      expect(() => quick("fix tap", { defaultProjectId: "nope" })).toThrow(/no project/);
    });

    it("does not treat the archived or the trophy cabinet as places to file", () => {
      const old = ops.createProject({ name: "Old" }).result;
      store.mutate("project", old.id, { isArchived: true });
      const task = quick("fix tap #Old").result;
      expect(task.task.projectId).not.toBe(old.id);
      expect(task.task.content).toBe("fix tap #Old");
    });
  });

  describe("labels", () => {
    it("reuses an existing label whatever the case", () => {
      ops.createLabel({ name: "errand" });
      const task = quick("buy stamps @Errand").result.task;
      expect(store.all("label")).toHaveLength(1);
      expect(task.labelIds).toEqual([store.all("label")[0]!.id]);
    });

    it("does not make two of a label given twice", () => {
      const task = quick("buy stamps @errand @Errand").result.task;
      expect(task.labelIds).toHaveLength(1);
      expect(store.all("label")).toHaveLength(1);
    });
  });

  describe("repeats", () => {
    it("makes a task that completing reschedules rather than finishes", () => {
      const created = quick("standup every weekday 9am").result.task;
      expect(created.due).toMatchObject({
        date: "2026-11-11T09:00:00.000Z",
        hasTime: true,
        isRecurring: true,
        text: "every weekday",
      });

      const done = ops.completeTask(created.id, TODAY).result;
      expect(done.rescheduled).toBe(true);
      expect(done.recurrenceUnderstood).toBe(true);
      expect(done.task?.isCompleted).toBe(false);
      expect(done.task?.due?.date).toBe("2026-11-12T09:00:00.000Z");
    });

    it("keeps the phrase exactly as typed, so the next occurrence can be read from it", () => {
      const created = quick("floss every! 3 days").result.task;
      expect(created.due?.text).toBe("every! 3 days");
      const done = ops.completeTask(created.id, TODAY).result;
      expect(done.rescheduled).toBe(true);
      expect(done.task?.due?.date).toBe("2026-11-14");
    });
  });

  describe("rewards still fire for a task made this way", () => {
    it("files the reward when it is completed", () => {
      const created = quick("ship the build").result.task;
      ops.updateTask(created.id, { reward: "An hour in the sun" });
      const done = ops.completeTask(created.id);

      const cabinet = store.all("project").find((project) => project.isRewards);
      expect(cabinet).toBeDefined();
      expect(store.all("task").filter((task) => task.projectId === cabinet!.id).map((task) => task.content)).toEqual([
        "An hour in the sun",
      ]);
      expect(done.ops.length).toBeGreaterThan(1);
    });
  });

  describe("a repeat whose first time has already gone", () => {
    it("starts at the next occurrence, the day completing it now would have produced", () => {
      const early = quick("standup every weekday 9am", { now: "08:00" }).result.task;
      expect(early.due?.date).toBe("2026-11-11T09:00:00.000Z");

      const late = quick("standup every weekday 9am", { now: "14:00" }).result.task;
      expect(late.due?.date).toBe("2026-11-12T09:00:00.000Z");
    });

    it("is refused when strict, because moving it is a call", () => {
      expect(() => quick("standup every weekday 9am", { now: "14:00", strict: true })).toThrow(/already passed/);
    });
  });

  describe("the date field overriding the text", () => {
    it("replaces the date and the time and the repeat, all of them", () => {
      const due = quick("standup every weekday 9am", { dueDate: "2026-12-01" }).result.task.due;
      expect(due).toEqual({ date: "2026-12-01", hasTime: false, text: null, timezone: null, isRecurring: false });
    });

    it("still takes the shorthand out of the title", () => {
      expect(quick("call mum tomorrow", { dueDate: "2026-12-01" }).result.task.content).toBe("call mum");
    });
  });

  describe("taking a token back", () => {
    it("leaves it in the title", () => {
      const task = quick("book tomorrow flights", { ignore: ["tomorrow"] }).result.task;
      expect(task.content).toBe("book tomorrow flights");
      expect(task.due).toBeNull();
    });
  });

  describe("when there is nothing to make a task from", () => {
    it("refuses a line of only shorthand", () => {
      expect(() => quick("p1 @focus")).toThrow(/title/);
      expect(store.all("task")).toHaveLength(0);
    });
  });

  describe("strict", () => {
    it("proceeds on a line it read completely", () => {
      expect(quick("pay rent tomorrow 9am p1", { strict: true }).result.task.content).toBe("pay rent");
    });

    it("throws, naming the text, on what a chip would have shown", () => {
      expect.assertions(4);
      try {
        quick("plan the quarter next week", { strict: true });
      } catch (error) {
        expect(error).toBeInstanceOf(QuickAddRefusal);
        expect((error as QuickAddRefusal).problems.map((problem) => problem.text)).toEqual(["next week"]);
        expect((error as Error).message).toContain('"next week"');
      }
      // And the same line, lenient, is a task due next Monday.
      expect(quick("plan the quarter next week").result.task.due?.date).toBe("2026-11-16");
    });

    it("stages nothing when it refuses: no task, no label, no inbox", () => {
      expect(() => quick("ship it next friday @launch", { strict: true })).toThrow(QuickAddRefusal);
      expect(store.all("task")).toHaveLength(0);
      expect(store.all("label")).toHaveLength(0);
      expect(store.all("project")).toHaveLength(0);
    });

    it("refuses a project it does not have, instead of filing under the inbox", () => {
      expect(() => quick("fix tap #Garage", { strict: true })).toThrow(/#Garage/);
    });
  });

  it("returns ops the store has already applied", () => {
    const staged = quick("buy milk");
    expect(store.get("task", staged.result.task.id)?.content).toBe("buy milk");
    expect(staged.ops.length).toBeGreaterThan(0);
  });
});

describe("reschedule", () => {
  /**
   * One row per day of a week, and the answers every client must give.
   *
   * This table is copied, row for row, into `RescheduleTests` in
   * `apps/ios/LightKit/Tests/LightKitTests/OperationsTests.swift`. It is the
   * thing that stops "next week" meaning a different Monday on the phone: change
   * a row here and the Swift test fails until it is changed there too.
   *
   * 2026-11-09 is a Monday.
   */
  const week: [name: string, today: string, tomorrow: string, nextWeek: string, weekend: string][] = [
    ["Monday", "2026-11-09", "2026-11-10", "2026-11-16", "2026-11-14"],
    ["Tuesday", "2026-11-10", "2026-11-11", "2026-11-16", "2026-11-14"],
    ["Wednesday", "2026-11-11", "2026-11-12", "2026-11-16", "2026-11-14"],
    ["Thursday", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-14"],
    ["Friday", "2026-11-13", "2026-11-14", "2026-11-16", "2026-11-14"],
    // The weekend is already here, so it means today.
    ["Saturday", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-14"],
    ["Sunday", "2026-11-15", "2026-11-16", "2026-11-16", "2026-11-15"],
    // Across a year end, and across 29 February.
    ["Thursday, New Year's Eve", "2026-12-31", "2027-01-01", "2027-01-04", "2027-01-02"],
    ["Monday, the day before a leap day", "2028-02-28", "2028-02-29", "2028-03-06", "2028-03-04"],
  ];

  it.each(week)("%s: the days each word means", (_name, today, tomorrow, nextWeek, weekend) => {
    expect(rescheduleDay("today", today)).toBe(today);
    expect(rescheduleDay("tomorrow", today)).toBe(tomorrow);
    expect(rescheduleDay("next-week", today)).toBe(nextWeek);
    expect(rescheduleDay("weekend", today)).toBe(weekend);
    expect(rescheduleDay(null, today)).toBeNull();
  });

  it("never reads next week as today, even on a Monday", () => {
    expect(rescheduleDay("next-week", "2026-11-09")).toBe("2026-11-16");
  });

  it("agrees with what the Quick Add parser reads next week as", () => {
    // Typing "next week" and picking it from the menu must land on one day.
    for (const [, today, , nextWeek] of week) {
      const parsed = ops.createTaskFromText("water the plants next week", {
        today,
        defaultProjectId: project().id,
      }).result.task;
      expect(parsed.due?.date).toBe(nextWeek);
    }
  });

  function taskDue(due: Due | null) {
    return ops.createTask({ projectId: project().id, content: "ring the vet", due }).result;
  }

  it.each<[RescheduleTarget, string | null]>([
    ["today", "2026-11-13"],
    ["tomorrow", "2026-11-14"],
    ["next-week", "2026-11-16"],
    ["weekend", "2026-11-14"],
    [null, null],
  ])("writes %s to the task as an all-day date", (target, day) => {
    const task = taskDue({
      date: "2026-12-01",
      hasTime: false,
      text: null,
      timezone: null,
      isRecurring: false,
    });
    const staged = ops.reschedule(task.id, target, "2026-11-13");

    expect(staged.ops).toHaveLength(1);
    if (day === null) {
      expect(staged.result?.due).toBeNull();
    } else {
      expect(staged.result?.due).toMatchObject({ date: day, hasTime: false });
    }
    expect(store.get("task", task.id)?.due?.date ?? null).toBe(day);
  });

  it("schedules a task that had no date", () => {
    const task = taskDue(null);
    expect(ops.reschedule(task.id, "tomorrow", "2026-11-13").result?.due?.date).toBe("2026-11-14");
  });

  it("drops the time of day and says so by being all-day", () => {
    const task = taskDue({
      date: "2026-11-13T09:30:00.000Z",
      hasTime: true,
      text: null,
      timezone: "Europe/London",
      isRecurring: false,
    });
    const due = ops.reschedule(task.id, "tomorrow", "2026-11-13").result?.due;
    expect(due?.hasTime).toBe(false);
    expect(due?.date).toBe("2026-11-14");
  });

  it("keeps a repeat repeating, and 'no date' ends it", () => {
    const task = taskDue({
      date: "2026-11-09",
      hasTime: false,
      text: "every monday",
      timezone: null,
      isRecurring: true,
    });
    const moved = ops.reschedule(task.id, "next-week", "2026-11-13").result?.due;
    expect(moved).toMatchObject({ date: "2026-11-16", text: "every monday", isRecurring: true });

    expect(ops.reschedule(task.id, null, "2026-11-13").result?.due).toBeNull();
  });

  it("changes nothing else about the task", () => {
    const task = ops.createTask({
      projectId: project().id,
      content: "ring the vet",
      priority: 2,
      reward: "a long walk",
    }).result;
    const after = ops.reschedule(task.id, "today", "2026-11-13").result;
    expect(after).toMatchObject({ content: "ring the vet", priority: 2, reward: "a long walk" });
  });

  it("says nothing for a task that is not there", () => {
    expect(ops.reschedule("missing", "today", "2026-11-13")).toEqual({ result: null, ops: [] });
  });
});
