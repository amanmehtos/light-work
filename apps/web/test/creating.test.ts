import { beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@light/core";
import { LightStore, Operations } from "@light/client-sdk";
import { parentChoices, projectTree } from "../src/projects.js";
import { groupBySection, onPage } from "../src/sections.js";
import { arrangeSubtasks, indexTasks } from "../src/subtasks.js";

/**
 * What a person can now make — a project under a project, a subtask under a
 * task — and that the rest of the app, which was written against the imported
 * account, reads what they make the way it reads that.
 *
 * These run the real `Operations` against a real store, not hand-built rows:
 * the point is that the thing the UI calls and the thing the sidebar and the
 * list read agree with each other.
 */

let store: LightStore;
let ops: Operations;

beforeEach(() => {
  store = new LightStore("test-device");
  ops = new Operations(store);
});

const names = (projects: readonly { project: Project }[]) => projects.map((entry) => entry.project.name);

describe("the sidebar tree and the parents on offer", () => {
  it("offers every project the sidebar draws, in the order it draws them, with its depth", () => {
    ops.ensureInbox();
    const work = ops.createProject({ name: "Work" }).result;
    const kyc = ops.createProject({ name: "KYC", parentId: work.id }).result;
    ops.createProject({ name: "Pitch deck", parentId: kyc.id });
    ops.createProject({ name: "Admin", parentId: work.id });
    ops.createProject({ name: "Home" });

    const choices = parentChoices(projectTree(store.all("project"), true));

    expect(choices.map((c) => [c.project.name, c.depth])).toEqual([
      ["Work", 0],
      ["KYC", 1],
      ["Pitch deck", 2],
      ["Admin", 1],
      ["Home", 0],
    ]);
  });

  it("offers a project made under a parent, three levels down, on the next opening", () => {
    const a = ops.createProject({ name: "A" }).result;
    const b = ops.createProject({ name: "B", parentId: a.id }).result;
    expect(names(parentChoices(projectTree(store.all("project"), true)))).toEqual(["A", "B"]);

    ops.createProject({ name: "C", parentId: b.id });
    const choices = parentChoices(projectTree(store.all("project"), true));
    expect(choices.map((c) => c.depth)).toEqual([0, 1, 2]);
  });

  it("never offers what the operation would refuse: the inbox, the trophies", () => {
    const inbox = ops.ensureInbox().result;
    const cabinet = ops.createProject({ name: "Rewards" }).result;
    store.mutate("project", cabinet.id, { isRewards: true });
    ops.createProject({ name: "Work" });

    const tree = projectTree(store.all("project"), true);
    expect(names(parentChoices(tree))).toEqual(["Work"]);
    for (const { project } of parentChoices(tree)) {
      expect(() => ops.createProject({ name: "x", parentId: project.id })).not.toThrow();
    }
    expect(() => ops.createProject({ name: "x", parentId: inbox.id })).toThrow();
    expect(() => ops.createProject({ name: "x", parentId: cabinet.id })).toThrow();
  });

  it("leaves out archived projects, and what is under them, which the sidebar cannot reach", () => {
    const old = ops.createProject({ name: "Old" }).result;
    ops.createProject({ name: "Under old", parentId: old.id });
    store.mutate("project", old.id, { isArchived: true });

    expect(parentChoices(projectTree(store.all("project"), true))).toEqual([]);
  });

  it("lifts a project filed under the inbox to the top level, as it always did", () => {
    const inbox = ops.ensureInbox().result;
    // Not possible through the operation any more, but an older client or the
    // importer could have written one.
    const stray = ops.createProject({ name: "Stray" }).result;
    store.mutate("project", stray.id, { parentId: inbox.id });

    const tree = projectTree(store.all("project"), true);
    expect(tree.inbox?.id).toBe(inbox.id);
    expect(tree.byParent.get(null)?.map((p) => p.name)).toEqual(["Stray"]);
  });
});

describe("a subtask made by a person", () => {
  function setup() {
    const project = ops.createProject({ name: "Work" }).result;
    const section = ops.createSection({ projectId: project.id, name: "Phase one" }).result;
    const parent = ops.createTask({ projectId: project.id, content: "Plan the trip", sectionId: section.id }).result;
    const sibling = ops.createTask({ projectId: project.id, content: "Pay rent" }).result;
    return { project, section, parent, sibling };
  }

  const openIn = (projectId: string) =>
    store.all("task").filter((t) => t.projectId === projectId && !t.isCompleted);

  it("is drawn directly beneath its parent, one step in, in the parent's section", () => {
    const { project, section, parent, sibling } = setup();
    const child = ops.createTask({ projectId: project.id, parentId: parent.id, content: "Book flights" }).result;

    const list = openIn(project.id).sort((a, b) => (a.order < b.order ? -1 : 1));
    const rows = arrangeSubtasks(list, indexTasks(store.all("task")));
    const under = rows.find((row) => row.task.id === child.id)!;

    expect(under.depth).toBe(1);
    expect(rows.findIndex((row) => row.task.id === child.id)).toBe(
      rows.findIndex((row) => row.task.id === parent.id) + 1,
    );
    // Beside its parent, so it does not need to name it.
    expect(under.parentTitle).toBeNull();

    const groups = groupBySection(rows, store.all("section"));
    expect(groups.find((g) => g.section?.id === section.id)!.rows.map((r) => r.task.id)).toEqual([
      parent.id,
      child.id,
    ]);
    expect(groups[0]!.rows.map((r) => r.task.id)).toEqual([sibling.id]);
  });

  it("is counted exactly as often as it is drawn, however deep and whether or not folded", () => {
    const { project, parent } = setup();
    const a = ops.createTask({ projectId: project.id, parentId: parent.id, content: "a" }).result;
    ops.createTask({ projectId: project.id, parentId: a.id, content: "a1" });
    ops.createTask({ projectId: project.id, parentId: parent.id, content: "b" });

    const index = () => indexTasks(store.all("task"));
    const rows = arrangeSubtasks(openIn(project.id), index());
    // The sidebar's number for the project is this length, and the page draws
    // these rows: the same call.
    expect(rows).toHaveLength(openIn(project.id).length);
    expect(onPage([{ section: null, rows }])).toHaveLength(rows.length);

    ops.setCollapsed("task", parent.id, true);
    const folded = arrangeSubtasks(openIn(project.id), index());
    expect(folded).toHaveLength(rows.length);
    expect(folded.filter((row) => !row.hidden)).toHaveLength(2);
  });

  it("moves its parent's chip, and the chip counts finished ones too", () => {
    const { project, parent } = setup();
    const first = ops.createTask({ projectId: project.id, parentId: parent.id, content: "a" }).result;
    ops.createTask({ projectId: project.id, parentId: parent.id, content: "b" });
    ops.completeTask(first.id, "2026-11-13");

    const rows = arrangeSubtasks(openIn(project.id), indexTasks(store.all("task")));
    expect(rows.find((row) => row.task.id === parent.id)!.subtasks).toEqual({ done: 1, total: 2 });
  });

  it("stands alone, naming its parent, in a list its parent is not in", () => {
    const { project, parent } = setup();
    const child = ops.createTask({ projectId: project.id, parentId: parent.id, content: "Book flights" }).result;

    // Like Today, where only the subtask is due.
    const rows = arrangeSubtasks([child], indexTasks(store.all("task")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ depth: 0, parentTitle: "Plan the trip" });
  });

  it("unfolds nothing by itself: a folded parent stays folded until the caller says otherwise", () => {
    const { project, parent } = setup();
    ops.setCollapsed("task", parent.id, true);
    ops.createTask({ projectId: project.id, parentId: parent.id, content: "Book flights" });

    expect(store.get("task", parent.id)!.isCollapsed).toBe(true);
    // And the caller's way to say it is one sparse op, and none when already open.
    expect(ops.setCollapsed("task", parent.id, false).ops).toHaveLength(1);
    expect(ops.setCollapsed("task", parent.id, false).ops).toHaveLength(0);
  });
});
