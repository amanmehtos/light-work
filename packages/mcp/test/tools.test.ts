import { beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/session.js";
import { buildTools, type ToolDefinition } from "../src/tools.js";
import { FakeServer } from "./fake-server.js";

let server: FakeServer;
let session: Session;
let tools: Map<string, ToolDefinition>;

const TODAY = "2026-10-24";

async function call(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  // `now` pinned too: it decides whether a repeat's first time has gone, and a
  // test that depended on the real hour would fail every afternoon.
  const context = { ...session.context, today: () => TODAY, now: () => "08:00" };
  const response = await tool.handler(args, context);
  return response as { structuredContent?: any; isError?: boolean; content: { text: string }[] };
}

beforeEach(async () => {
  server = new FakeServer();
  session = new Session({ transport: server });
  await session.refresh();
  tools = new Map(buildTools().map((tool) => [tool.name, tool]));
});

async function seed() {
  const project = (await call("create_project", { name: "Develop KYC" })).structuredContent.project;
  const task = (
    await call("create_task", {
      projectId: project.id,
      content: "Ready publisher pitch deck",
      priority: 1,
      due: { date: "2026-10-24" },
      deadlineDate: "2026-11-15",
      labels: ["focus"],
    })
  ).structuredContent.task;
  return { project, task };
}

describe("the tool set", () => {
  it("marks read-only tools as such, so hosts can skip confirmation", () => {
    const readOnly = buildTools().filter((tool) => tool.readOnly).map((tool) => tool.name);
    expect(readOnly).toContain("list_tasks");
    expect(readOnly).toContain("get_week_plan");
    expect(readOnly).not.toContain("create_task");
    expect(readOnly).not.toContain("delete_task");
  });

  it("gives every tool a description an agent can act on", () => {
    for (const tool of buildTools()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
    }
  });
});

describe("create_task", () => {
  it("creates a task and persists it to the server", async () => {
    const { task } = await seed();
    expect(task.content).toBe("Ready publisher pitch deck");
    expect(task.priorityLabel).toBe("p1");
    expect(server.liveCount("task")).toBe(1);
  });

  it("keeps due and deadline apart", async () => {
    const { task } = await seed();
    expect(task.due.date).toBe("2026-10-24");
    expect(task.deadline).toBe("2026-11-15");
  });

  it("refuses an unknown project rather than creating an orphan", async () => {
    const response = await call("create_task", { projectId: "nope", content: "x" });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("No project");
    expect(server.liveCount("task")).toBe(0);
  });

  it("refuses a recurrence it cannot read, and says what it supports", async () => {
    const { project } = await seed();
    const response = await call("create_task", {
      projectId: project.id,
      content: "x",
      due: { date: "2026-10-24", recurring: true, phrase: "every 3rd thursday of the month" },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("every monday");
  });

  it("accepts a recurrence it can read", async () => {
    const { project } = await seed();
    const response = await call("create_task", {
      projectId: project.id,
      content: "Log wishlists",
      due: { date: "2026-10-24", recurring: true, phrase: "every saturday" },
    });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent.task.due.recurring).toBe(true);
  });
});

describe("create_task_from_text", () => {
  // 2026-10-24 is a Saturday, so "tomorrow" is Sunday the 25th.
  const LINE = "pay rent tomorrow 9am p1 @errand #Home";

  async function withHome() {
    return (await call("create_project", { name: "Home" })).structuredContent.project;
  }

  it("is a writing tool, and takes only text and a fallback project", () => {
    const tool = tools.get("create_task_from_text")!;
    expect(tool.readOnly).toBe(false);
    // No `strict` switch: an argument an agent could turn off would undo the
    // reason this tool is separate from the UI's parser.
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["projectId", "text"]);
  });

  it("creates the same task create_task would, from one line", async () => {
    const home = await withHome();
    const fromText = (await call("create_task_from_text", { text: LINE })).structuredContent.task;
    const fromFields = (
      await call("create_task", {
        projectId: home.id,
        content: "pay rent",
        priority: 1,
        due: { date: "2026-10-25T09:00:00.000Z" },
        labels: ["errand"],
      })
    ).structuredContent.task;

    const { id: _a, ...a } = fromText;
    const { id: _b, ...b } = fromFields;
    expect(a).toEqual(b);
    expect(fromText.project.path).toBe("Home");
    expect(fromText.priorityLabel).toBe("p1");
    expect(server.liveCount("task")).toBe(2);
  });

  it("says what it read, so the agent can check it against what it meant", async () => {
    await withHome();
    const response = await call("create_task_from_text", { text: LINE });
    expect(response.structuredContent.read).toEqual(
      expect.arrayContaining([
        { text: "tomorrow", as: "due 2026-10-25" },
        { text: "9am", as: "at 09:00" },
        { text: "p1", as: "priority p1" },
        { text: "@errand", as: "label errand" },
        { text: "#Home", as: "project Home" },
      ]),
    );
  });

  it("reads a time in the account's zone", async () => {
    const zoned = new Session({ transport: server, timezone: "America/New_York" });
    await zoned.refresh();
    const response = await tools
      .get("create_task_from_text")!
      .handler({ text: "call mum 2099-06-15 9am" }, zoned.context);
    // A date given outright, and far enough off that the real "today" cannot pass it.
    // New York is on summer time in June: UTC-4.
    expect((response as any).structuredContent.task.due.date).toBe("2099-06-15T13:00:00.000Z");
  });

  it("files into the inbox when told nowhere, making it on the server too", async () => {
    const response = await call("create_task_from_text", { text: "buy milk" });
    expect(response.structuredContent.task.project.path).toBe("Inbox");
    expect(server.liveCount("project")).toBe(1);
    expect((await call("list_projects")).structuredContent.projects[0].isInbox).toBe(true);
  });

  it("files into projectId when the text names no project", async () => {
    const work = (await call("create_project", { name: "Work" })).structuredContent.project;
    const response = await call("create_task_from_text", { text: "write report", projectId: work.id });
    expect(response.structuredContent.task.project.id).toBe(work.id);
  });

  it("makes a repeat that completing reschedules", async () => {
    const created = (await call("create_task_from_text", { text: "standup every weekday 9am" }))
      .structuredContent.task;
    // The 24th is a Saturday, so the first weekday is Monday the 26th.
    expect(created.due.date).toBe("2026-10-26T09:00:00.000Z");
    expect(created.due.recurring).toBe(true);

    const done = await call("complete_task", { taskId: created.id });
    expect(done.structuredContent.rescheduled).toBe(true);
    expect(done.structuredContent.task.due.date).toBe("2026-10-27T09:00:00.000Z");
  });

  it("starts a repeat on its next occurrence when the first has already gone, and refuses to guess that", async () => {
    // Saturday the 24th. At 08:00 the 9am one is ahead; at 10:00 it is not.
    const early = await call("create_task_from_text", { text: "water plants every saturday 9am" });
    expect(early.structuredContent.task.due.date).toBe("2026-10-24T09:00:00.000Z");

    const context = { ...session.context, today: () => TODAY, now: () => "10:00" };
    const late = (await tools
      .get("create_task_from_text")!
      .handler({ text: "water plants every saturday 9am" }, context)) as { isError?: boolean; content: { text: string }[] };
    expect(late.isError).toBe(true);
    expect(late.content[0]!.text).toContain("has already passed today");
  });

  describe("refusing", () => {
    async function refused(text: string, named: string[]) {
      const before = server.pushCalls;
      const response = await call("create_task_from_text", { text });
      expect(response.isError, text).toBe(true);
      const message = response.content[0]!.text;
      for (const piece of named) expect(message, text).toContain(`"${piece}"`);
      // Nothing was written, to the store or to the server.
      expect(server.liveCount("task"), text).toBe(0);
      expect(server.pushCalls, text).toBe(before);
      return message;
    }

    it("a date that could mean two things, naming it", async () => {
      const message = await refused("ship it next friday", ["next friday"]);
      expect(message).toMatch(/nothing was created/i);
      expect(message).toContain("create_task");
    });

    it("a day it would have had to assume", async () => {
      await refused("plan the quarter next week", ["next week"]);
    });

    it("a time with no day", async () => {
      await refused("call mum 5pm", ["5pm"]);
    });

    it("a time with no am or pm", async () => {
      await refused("call mum tomorrow at 5", ["at 5"]);
    });

    it("a deadline, which is not a due date", async () => {
      await refused("report by friday", ["by friday"]);
    });

    it("a repeat it cannot read", async () => {
      await refused("clean every other tuesday", ["every other tuesday"]);
    });

    it("a project that does not exist", async () => {
      await refused("fix tap #Garage", ["#Garage"]);
    });

    it("every problem in one go, not just the first", async () => {
      await refused("ship it next friday at 5 #Garage", ["next friday", "at 5", "#Garage"]);
    });

    it("does not create the inbox, or a label, on the way to refusing", async () => {
      await refused("ship it next friday @launch", ["next friday"]);
      expect(server.liveCount("project")).toBe(0);
      expect(server.liveCount("label")).toBe(0);
    });

    it("an unknown fallback project", async () => {
      const response = await call("create_task_from_text", { text: "buy milk", projectId: "nope" });
      expect(response.isError).toBe(true);
      expect(response.content[0]!.text).toContain("No project");
    });
  });

  it("leaves create_task's structured form alone, so a parser-free path remains", () => {
    expect(Object.keys(tools.get("create_task")!.inputSchema)).toEqual([
      "projectId", "content", "description", "sectionId", "parentId", "priority", "due",
      "deadlineDate", "durationMinutes", "labels", "reward",
    ]);
  });
});

describe("complete_task", () => {
  it("completes a one-off task", async () => {
    const { task } = await seed();
    const response = await call("complete_task", { taskId: task.id });
    expect(response.structuredContent.rescheduled).toBe(false);
    expect(response.structuredContent.task.completed).toBe(true);
  });

  it("reschedules a recurring task and says so", async () => {
    const { project } = await seed();
    const created = (
      await call("create_task", {
        projectId: project.id,
        content: "Log wishlists",
        due: { date: "2026-10-24", recurring: true, phrase: "every saturday" },
      })
    ).structuredContent.task;

    const response = await call("complete_task", { taskId: created.id });
    expect(response.structuredContent.rescheduled).toBe(true);
    expect(response.structuredContent.task.completed).toBe(false);
    expect(response.structuredContent.task.due.date).toBe("2026-10-31");
  });
});

describe("reschedule_task", () => {
  // TODAY is a Saturday, so the weekend is today and next week is the 26th.
  it.each([
    ["today", "2026-10-24"],
    ["tomorrow", "2026-10-25"],
    ["next-week", "2026-10-26"],
    ["weekend", "2026-10-24"],
  ])("moves a task to %s", async (when, date) => {
    const { task } = await seed();
    const response = await call("reschedule_task", { taskId: task.id, when });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent.task.due.date).toBe(date);
  });

  it("clears the date with none", async () => {
    const { task } = await seed();
    const response = await call("reschedule_task", { taskId: task.id, when: "none" });
    // `formatTask` leaves the field out when there is no date.
    expect(response.structuredContent.task.due).toBeUndefined();
  });

  it("says when there is no such task", async () => {
    const response = await call("reschedule_task", { taskId: "missing", when: "today" });
    expect(response.isError).toBe(true);
  });
});

describe("list_tasks", () => {
  it("filters by project, label and priority", async () => {
    const { project, task } = await seed();
    await call("create_task", { projectId: project.id, content: "low priority", priority: 4 });

    expect((await call("list_tasks", { projectId: project.id })).structuredContent.total).toBe(2);
    expect((await call("list_tasks", { priority: 1 })).structuredContent.total).toBe(1);
    expect((await call("list_tasks", { label: "focus" })).structuredContent.tasks[0].id).toBe(task.id);
  });

  it("reports an unknown label instead of returning nothing", async () => {
    await seed();
    const response = await call("list_tasks", { label: "nonexistent" });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("No label");
  });

  it("excludes completed tasks unless asked", async () => {
    const { task } = await seed();
    await call("complete_task", { taskId: task.id });
    expect((await call("list_tasks", {})).structuredContent.total).toBe(0);
    expect((await call("list_tasks", { includeCompleted: true })).structuredContent.total).toBe(1);
  });

  it("finds overdue work", async () => {
    const { project } = await seed();
    await call("create_task", {
      projectId: project.id,
      content: "late",
      due: { date: "2026-10-01" },
    });
    const response = await call("list_tasks", { overdueOnly: true });
    expect(response.structuredContent.total).toBe(1);
    expect(response.structuredContent.tasks[0].content).toBe("late");
  });

  it("searches titles case-insensitively", async () => {
    await seed();
    expect((await call("list_tasks", { search: "PITCH" })).structuredContent.total).toBe(1);
  });

  // These three pin that the tool and the app's search box mean the same thing;
  // the rules themselves are tested beside `searchTasks`.
  it("also searches notes and label names, best match first", async () => {
    const { project } = await seed();
    await call("create_task", { projectId: project.id, content: "plain", description: "mentions the zebra" });
    await call("create_task", { projectId: project.id, content: "tagged", labels: ["zebra"] });
    await call("create_task", { projectId: project.id, content: "Zebra crossing" });

    const found = (await call("list_tasks", { search: "zebra" })).structuredContent.tasks;
    expect(found.map((task: { content: string }) => task.content)).toEqual([
      "Zebra crossing",
      "tagged",
      "plain",
    ]);
  });

  it("treats a blank search as no search", async () => {
    await seed();
    const all = (await call("list_tasks", {})).structuredContent.total;
    expect((await call("list_tasks", { search: "  " })).structuredContent.total).toBe(all);
  });

  it("still applies its other filters to what a search finds", async () => {
    const { project } = await seed();
    await call("create_task", { projectId: project.id, content: "pitch again", priority: 3 });
    // The seeded pitch is p1, the new one p3; both match the search, one the priority.
    const found = (await call("list_tasks", { search: "pitch", priority: 3 })).structuredContent.tasks;
    expect(found.map((task: { content: string }) => task.content)).toEqual(["pitch again"]);
  });
});

describe("get_week_plan", () => {
  it("assembles overdue, scheduled, deadlines and unscheduled important work", async () => {
    const { project } = await seed();
    await call("create_task", {
      projectId: project.id,
      content: "overdue thing",
      due: { date: "2026-10-01" },
      priority: 2,
    });
    await call("create_task", {
      projectId: project.id,
      content: "later this week",
      due: { date: "2026-10-27" },
    });
    await call("create_task", { projectId: project.id, content: "important, unscheduled", priority: 1 });

    const plan = (await call("get_week_plan", {})).structuredContent;
    expect(plan.window.start).toBe(TODAY);
    expect(plan.window.end).toBe("2026-10-30");
    expect(plan.counts.overdue).toBe(1);
    expect(plan.counts.unscheduledImportant).toBe(1);
    expect(plan.schedule).toHaveLength(7);
    expect(plan.schedule[0].tasks[0].content).toBe("Ready publisher pitch deck");
    expect(plan.schedule[3].tasks[0].content).toBe("later this week");
  });

  it("includes a deadline inside the window", async () => {
    const { project } = await seed();
    await call("create_task", {
      projectId: project.id,
      content: "owed soon",
      deadlineDate: "2026-10-26",
    });
    const plan = (await call("get_week_plan", {})).structuredContent;
    expect(plan.counts.deadlines).toBe(1);
  });
});

describe("reorder_tasks", () => {
  it("puts siblings into the given order", async () => {
    const { project } = await seed();
    const a = (await call("create_task", { projectId: project.id, content: "a" })).structuredContent.task;
    const b = (await call("create_task", { projectId: project.id, content: "b" })).structuredContent.task;
    const c = (await call("create_task", { projectId: project.id, content: "c" })).structuredContent.task;

    const response = await call("reorder_tasks", { taskIds: [c.id, a.id, b.id] });
    const list = response.structuredContent.list.map((item: { content: string }) => item.content);
    // The listed tasks move to the top in the order given; the seeded task was
    // not listed, so it keeps its position after them.
    expect(list).toEqual(["c", "a", "b", "Ready publisher pitch deck"]);
  });

  it("writes only the tasks that move", async () => {
    const { project } = await seed();
    const a = (await call("create_task", { projectId: project.id, content: "a" })).structuredContent.task;
    const b = (await call("create_task", { projectId: project.id, content: "b" })).structuredContent.task;

    const before = server.pushCalls;
    const response = await call("reorder_tasks", { taskIds: [a.id, b.id] });
    expect(response.structuredContent.reordered).toBe(2);
    expect(server.pushCalls).toBe(before + 1);
  });

  it("refuses tasks from different lists, and suggests the fix", async () => {
    const one = (await call("create_project", { name: "one" })).structuredContent.project;
    const two = (await call("create_project", { name: "two" })).structuredContent.project;
    const a = (await call("create_task", { projectId: one.id, content: "a" })).structuredContent.task;
    const b = (await call("create_task", { projectId: two.id, content: "b" })).structuredContent.task;

    const response = await call("reorder_tasks", { taskIds: [a.id, b.id] });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("move_task");
  });

  it("reports unknown ids", async () => {
    const response = await call("reorder_tasks", { taskIds: ["ghost"] });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("Unknown task ids");
  });

  describe("with a day", () => {
    async function twoProjectsDueToday() {
      const work = (await call("create_project", { name: "Work" })).structuredContent.project;
      const home = (await call("create_project", { name: "Home" })).structuredContent.project;
      const make = async (projectId: string, content: string) =>
        (await call("create_task", { projectId, content, due: { date: TODAY } })).structuredContent.task;
      return { work, home, w: await make(work.id, "w"), h: await make(home.id, "h") };
    }

    it("arranges the day across projects, and says where each task now sorts", async () => {
      const { w, h } = await twoProjectsDueToday();
      const response = await call("reorder_tasks", { taskIds: [h.id, w.id], day: TODAY });
      expect(response.isError).toBeUndefined();
      expect(response.structuredContent.list.map((item: { content: string }) => item.content)).toEqual(["h", "w"]);

      // The agent can read the result back: dayOrder is on the task now.
      const listed = await call("list_tasks", {});
      const byContent = Object.fromEntries(listed.structuredContent.tasks.map((t: any) => [t.content, t]));
      expect(typeof byContent.h.dayOrder).toBe("string");
    });

    it("leaves every project's own order alone", async () => {
      const { work, home, w, h } = await twoProjectsDueToday();
      const order = async (projectId: string) =>
        (await call("list_tasks", { projectId })).structuredContent.tasks.map((t: { content: string }) => t.content);
      const [workBefore, homeBefore] = [await order(work.id), await order(home.id)];
      const tasksBefore = session.context.store.all("task").map((t) => [t.id, t.order]);

      await call("reorder_tasks", { taskIds: [h.id, w.id], day: TODAY });

      expect(await order(work.id)).toEqual(workBefore);
      expect(await order(home.id)).toEqual(homeBefore);
      expect(session.context.store.all("task").map((t) => [t.id, t.order])).toEqual(tasksBefore);
    });

    it("does not insist the tasks are siblings, but does insist they are on that day", async () => {
      const { w, h } = await twoProjectsDueToday();
      const later = (
        await call("create_task", { projectId: (await call("create_project", { name: "X" })).structuredContent.project.id, content: "later", due: { date: "2026-11-02" } })
      ).structuredContent.task;
      const response = await call("reorder_tasks", { taskIds: [w.id, later.id, h.id], day: TODAY });
      expect(response.isError).toBe(true);
      expect(response.content[0]!.text).toContain(later.id);
    });

    it("leaves dayOrder off a task that has none", async () => {
      const { task } = await seed();
      expect("dayOrder" in task && task.dayOrder !== undefined).toBe(false);
    });
  });
});

describe("move_task", () => {
  it("moves a task between projects", async () => {
    const { project, task } = await seed();
    const other = (await call("create_project", { name: "elsewhere" })).structuredContent.project;
    const response = await call("move_task", { taskId: task.id, projectId: other.id });
    expect(response.structuredContent.task.project.id).toBe(other.id);
    expect(project.id).not.toBe(other.id);
  });

  it("refuses to nest a task under its own subtask", async () => {
    const { project } = await seed();
    const parent = (await call("create_task", { projectId: project.id, content: "parent" }))
      .structuredContent.task;
    const child = (
      await call("create_task", { projectId: project.id, content: "child", parentId: parent.id })
    ).structuredContent.task;

    const response = await call("move_task", { taskId: parent.id, parentId: child.id });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("own subtasks");
  });
});

describe("create_task, as a subtask", () => {
  it("files the subtask with its parent, and shows it as one", async () => {
    const { project } = await seed();
    const section = (await call("create_section", { projectId: project.id, name: "Phase one" }))
      .structuredContent.section;
    const parent = (
      await call("create_task", { projectId: project.id, content: "parent", sectionId: section.id })
    ).structuredContent.task;

    const child = (
      await call("create_task", { projectId: project.id, content: "child", parentId: parent.id })
    ).structuredContent.task;

    expect(child.parentId).toBe(parent.id);
    expect(session.context.store.get("task", child.id)).toMatchObject({
      projectId: project.id,
      sectionId: section.id,
    });
    expect(server.liveCount("task")).toBe(3);
  });

  it("refuses a parent that does not exist, or one in another project", async () => {
    const { project, task } = await seed();
    const elsewhere = (await call("create_project", { name: "elsewhere" })).structuredContent.project;

    const ghost = await call("create_task", { projectId: project.id, content: "x", parentId: "ghost" });
    expect(ghost.isError).toBe(true);

    const crossed = await call("create_task", {
      projectId: elsewhere.id,
      content: "x",
      parentId: task.id,
    });
    expect(crossed.isError).toBe(true);
    expect(crossed.content[0]!.text).toContain("same project");
    // Nothing was written for either.
    expect(server.liveCount("task")).toBe(1);
  });
});

describe("delete_task", () => {
  it("deletes a task with its subtasks", async () => {
    const { project } = await seed();
    const parent = (await call("create_task", { projectId: project.id, content: "parent" }))
      .structuredContent.task;
    await call("create_task", { projectId: project.id, content: "child", parentId: parent.id });

    const response = await call("delete_task", { taskId: parent.id });
    expect(response.structuredContent.count).toBe(2);
  });
});

describe("focus", () => {
  it("logs a session and surfaces it on the task", async () => {
    const { task } = await seed();
    await call("log_focus_session", {
      taskId: task.id,
      startedAt: "2026-10-24T09:00:00Z",
      endedAt: "2026-10-24T09:25:00Z",
      plannedMinutes: 25,
      focusedMinutes: 25,
    });

    const fetched = (await call("get_task", { taskId: task.id })).structuredContent;
    expect(fetched.task.focus.sessions).toBe(1);
    expect(fetched.task.focus.focused).toBe("25m");
  });

  it("ranks tasks by where attention actually went", async () => {
    const { project, task } = await seed();
    const other = (await call("create_task", { projectId: project.id, content: "neglected" }))
      .structuredContent.task;

    await call("log_focus_session", {
      taskId: task.id,
      startedAt: "2026-10-24T09:00:00Z",
      plannedMinutes: 25,
      focusedMinutes: 25,
    });
    await call("log_focus_session", {
      taskId: task.id,
      startedAt: "2026-10-24T10:00:00Z",
      plannedMinutes: 50,
      focusedMinutes: 50,
    });
    await call("log_focus_session", {
      taskId: other.id,
      startedAt: "2026-10-24T11:00:00Z",
      plannedMinutes: 25,
      focusedMinutes: 5,
      interruptions: 3,
      outcome: "abandoned",
    });

    const stats = (await call("get_focus_stats", {})).structuredContent;
    expect(stats.focused).toBe("1h 20m");
    expect(stats.abandonedSessions).toBe(1);
    expect(stats.topTasks[0].content).toBe("Ready publisher pitch deck");
    expect(stats.topTasks[0].focused).toBe("1h 15m");
  });

  it("refuses to log against a task that does not exist", async () => {
    const response = await call("log_focus_session", {
      taskId: "ghost",
      startedAt: "2026-10-24T09:00:00Z",
      plannedMinutes: 25,
      focusedMinutes: 25,
    });
    expect(response.isError).toBe(true);
  });
});

describe("staying in step with other devices", () => {
  it("sees a change another device made after the session loaded", async () => {
    const { project } = await seed();

    // Another device creates a task directly on the server.
    await server.applyExternal([
      {
        id: "external-op-1",
        kind: "task",
        entityId: "external-task",
        type: "upsert",
        fields: {
          id: "external-task",
          projectId: project.id,
          sectionId: null,
          parentId: null,
          content: "added on the phone",
          description: "",
          priority: 4,
          order: "V",
          dayOrder: null,
          due: null,
          deadline: null,
          duration: null,
          labelIds: [],
          isCompleted: false,
          completedAt: null,
          isCollapsed: false,
          assigneeId: null,
          addedById: null,
          createdAt: "2026-10-24T00:00:00Z",
        },
        clock: "00000000zzz:00001:phone",
        node: "phone",
      },
    ]);

    await session.refresh();
    const tasks = (await call("list_tasks", {})).structuredContent.tasks;
    expect(tasks.map((t: { content: string }) => t.content)).toContain("added on the phone");
  });
});

describe("projects", () => {
  it("reports a nested project's full path", async () => {
    const parent = (await call("create_project", { name: "3WM" })).structuredContent.project;
    const child = (await call("create_project", { name: "BISNO", parentId: parent.id }))
      .structuredContent.project;
    const grandchild = (await call("create_project", { name: "Light Week", parentId: child.id }))
      .structuredContent.project;

    expect(grandchild.path).toBe("3WM / BISNO / Light Week");
  });

  it("refuses an unknown parent", async () => {
    const response = await call("create_project", { name: "orphan", parentId: "ghost" });
    expect(response.isError).toBe(true);
  });

  it("will not file a project under the inbox", async () => {
    const inbox = session.context.ops.ensureInbox();
    await session.context.flush(inbox.ops);
    const response = await call("create_project", { name: "x", parentId: inbox.result.id });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("inbox");
  });

  it("counts open tasks per project", async () => {
    const { project, task } = await seed();
    await call("complete_task", { taskId: task.id });
    const projects = (await call("list_projects", {})).structuredContent.projects;
    expect(projects.find((p: { id: string }) => p.id === project.id).openTasks).toBe(0);
  });
});

describe("sections", () => {
  async function sectioned() {
    const { project, task } = await seed();
    const section = (
      await call("create_section", { projectId: project.id, name: "Phase one", description: "the plan" })
    ).structuredContent.section;
    return { project, task, section };
  }

  it("lists sections with their notes, project and open-task counts", async () => {
    const { project, task, section } = await sectioned();
    await call("move_task", { taskId: task.id, sectionId: section.id });

    const listed = (await call("list_sections", {})).structuredContent;
    expect(listed.total).toBe(1);
    expect(listed.sections[0]).toMatchObject({
      id: section.id,
      name: "Phase one",
      description: "the plan",
      project: { id: project.id, path: "Develop KYC" },
      openTasks: 1,
    });
  });

  it("narrows to one project and hides archived sections unless asked", async () => {
    const { project, section } = await sectioned();
    const other = (await call("create_project", { name: "elsewhere" })).structuredContent.project;
    await call("create_section", { projectId: other.id, name: "Else" });
    await call("update_section", { sectionId: section.id, isArchived: true });

    expect((await call("list_sections", { projectId: project.id })).structuredContent.total).toBe(0);
    expect(
      (await call("list_sections", { projectId: project.id, includeArchived: true })).structuredContent.total,
    ).toBe(1);
    expect((await call("list_sections", { projectId: other.id })).structuredContent.total).toBe(1);
  });

  it("list_sections then move_task with a sectionId is how an agent files a task", async () => {
    const { task, section } = await sectioned();
    const moved = await call("move_task", { taskId: task.id, sectionId: section.id });
    expect(moved.structuredContent.task.section).toEqual({ id: section.id, name: "Phase one" });
    expect(server.liveCount("section")).toBe(1);
  });

  it("move_task refuses a section from another project, and says why", async () => {
    const { task } = await sectioned();
    const other = (await call("create_project", { name: "elsewhere" })).structuredContent.project;
    const foreign = (await call("create_section", { projectId: other.id, name: "Else" })).structuredContent
      .section;

    const response = await call("move_task", { taskId: task.id, sectionId: foreign.id });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("different project");
  });

  it("renames, and leaves what it was not given alone", async () => {
    const { section } = await sectioned();
    const response = await call("update_section", { sectionId: section.id, name: "Phase 1" });
    expect(response.structuredContent.section).toMatchObject({ name: "Phase 1", description: "the plan" });
  });

  it("reports an unknown section on update and on delete", async () => {
    const update = await call("update_section", { sectionId: "ghost", name: "x" });
    expect(update.isError).toBe(true);
    expect(update.content[0]!.text).toContain("No section");

    const remove = await call("delete_section", { sectionId: "ghost" });
    expect(remove.isError).toBe(true);
    expect(remove.content[0]!.text).toContain("No section");
  });

  it("delete_section keeps the tasks, and says where they went", async () => {
    const { task, section } = await sectioned();
    await call("move_task", { taskId: task.id, sectionId: section.id });

    const response = await call("delete_section", { sectionId: section.id });

    expect(response.structuredContent).toMatchObject({ deleted: section.id, movedTasks: 1 });
    expect(server.liveCount("section")).toBe(0);
    expect(server.liveCount("task")).toBe(1);
    const kept = (await call("get_task", { taskId: task.id })).structuredContent.task;
    expect(kept.section).toBeUndefined();
  });
});

describe("comments", () => {
  it("add_comment writes to the task and list_comments reads both back", async () => {
    const { task } = await seed();
    const first = (await call("add_comment", { taskId: task.id, content: "  Lead with economics. " }))
      .structuredContent.comment;
    expect(first.content).toBe("Lead with economics.");
    await call("add_comment", { taskId: task.id, content: "Second thought." });

    const listed = (await call("list_comments", { taskId: task.id })).structuredContent;
    expect(listed.total).toBe(2);
    // Deliberately a set, not a sequence. Two comments added in the same
    // millisecond carry the same `postedAt`, and the tiebreak is the id —
    // which is a millisecond prefix plus sixteen random characters, so their
    // relative order is a coin flip. Asserting creation order here failed
    // about half the time. Ordering is tested below, where the times differ.
    expect(listed.comments.map((c: { content: string }) => c.content).sort()).toEqual([
      "Lead with economics.",
      "Second thought.",
    ]);
    expect(server.liveCount("comment")).toBe(2);
  });

  it("lists a thread oldest first when the comments were posted at different times", async () => {
    const { task } = await seed();
    const { store, flush } = session.context;
    // Explicit timestamps, because that is the promise: oldest first by when
    // it was posted. The id tiebreak only decides comments posted in the same
    // millisecond, and it decides them the same way on every device, which is
    // what a replicated thread needs more than it needs local creation order.
    await flush([
      store.mutate("comment", "late", {
        id: "late", taskId: task.id, projectId: null, content: "Afterthought",
        postedAt: "2026-11-14T12:00:00.000Z", postedById: null, attachment: null,
      }),
      store.mutate("comment", "early", {
        id: "early", taskId: task.id, projectId: null, content: "First word",
        postedAt: "2026-11-14T09:00:00.000Z", postedById: null, attachment: null,
      }),
    ]);

    const listed = (await call("list_comments", { taskId: task.id })).structuredContent;
    expect(listed.comments.map((c: { content: string }) => c.content)).toEqual([
      "First word",
      "Afterthought",
    ]);
  });

  it("reads one the import wrote, without its epoch date or its file URL", async () => {
    const { task } = await seed();
    const { store, flush } = session.context;
    await flush([
      store.mutate("comment", "c1", {
        id: "c1",
        taskId: task.id,
        projectId: null,
        content: "Deck v3",
        attachment: { fileName: "deck.pdf", fileType: "application/pdf", fileUrl: "https://example.com/deck.pdf", fileSize: 2048 },
        postedById: "todoist-uid-1234",
        postedAt: new Date(0).toISOString(),
      }),
    ]);

    const [comment] = (await call("list_comments", { taskId: task.id })).structuredContent.comments;
    expect(comment).toEqual({ id: "c1", content: "Deck v3", attachment: "deck.pdf" });
  });

  it("is read-only to list and refuses a task that is not there, or an empty comment", async () => {
    expect(tools.get("list_comments")!.readOnly).toBe(true);
    expect(tools.get("add_comment")!.readOnly).toBe(false);

    const missing = await call("add_comment", { taskId: "ghost", content: "x" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("No task");
    expect((await call("list_comments", { taskId: "ghost" })).isError).toBe(true);

    const { task } = await seed();
    const blank = await call("add_comment", { taskId: task.id, content: "   " });
    expect(blank.isError).toBe(true);
    expect(server.liveCount("comment")).toBe(0);
  });

  it("delete_task takes the comments with it", async () => {
    const { task } = await seed();
    await call("add_comment", { taskId: task.id, content: "gone with it" });
    await call("delete_task", { taskId: task.id });
    expect(server.liveCount("comment")).toBe(0);
  });
});
