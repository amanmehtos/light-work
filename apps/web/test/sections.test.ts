import { describe, expect, it } from "vitest";
import type { Section, Task } from "@light/core";
import { moveSelection } from "../src/shortcuts.js";
import { groupBySection, onPage } from "../src/sections.js";
import { arrangeSubtasks, indexTasks } from "../src/subtasks.js";

function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, content: id, parentId: null, sectionId: null, order: id, isCollapsed: false, isCompleted: false, ...fields } as Task;
}
function section(id: string, fields: Partial<Section> = {}): Section {
  return { id, projectId: "p", name: id, description: "", order: id, isArchived: false, isCollapsed: false, ...fields };
}

function groups(tasks: Task[], sections: Section[]) {
  return groupBySection(arrangeSubtasks(tasks, indexTasks(tasks)), sections);
}
const shape = (gs: ReturnType<typeof groups>) =>
  gs.map((g) => [g.section?.id ?? null, g.rows.map((r) => r.task.id)] as const);

describe("groupBySection", () => {
  it("puts unsectioned tasks above the first heading, then each section in its order", () => {
    const tasks = [task("a", { sectionId: "s2" }), task("loose"), task("b", { sectionId: "s1" })];
    // Sections handed over out of order: `order` decides, not arrival.
    expect(shape(groups(tasks, [section("s2"), section("s1")]))).toEqual([
      [null, ["loose"]],
      ["s1", ["b"]],
      ["s2", ["a"]],
    ]);
  });

  it("keeps an empty section, so there is somewhere to drop a task", () => {
    expect(shape(groups([task("loose")], [section("s1")]))).toEqual([
      [null, ["loose"]],
      ["s1", []],
    ]);
  });

  it("files a subtask with its parent, whatever its own sectionId says", () => {
    const tasks = [
      task("p", { sectionId: "s1" }),
      task("c", { parentId: "p", sectionId: "s2" }),
      task("q", { sectionId: "s2" }),
    ];
    expect(shape(groups(tasks, [section("s1"), section("s2")]))).toEqual([
      [null, []],
      ["s1", ["p", "c"]],
      ["s2", ["q"]],
    ]);
  });

  it("does not lose a task whose section is gone: it is drawn with the unsectioned rows", () => {
    const tasks = [task("a", { sectionId: "deleted-elsewhere" }), task("b")];
    expect(shape(groups(tasks, [section("s1")]))[0]).toEqual([null, ["a", "b"]]);
  });

  it("hides an empty archived section but never one that still holds work", () => {
    const sections = [section("old", { isArchived: true }), section("live", { isArchived: true })];
    const found = shape(groups([task("a", { sectionId: "live" })], sections));
    expect(found.map(([id]) => id)).toEqual([null, "live"]);
  });

  it("accounts for every row exactly once", () => {
    const tasks = [
      task("a", { sectionId: "s1" }),
      task("a1", { parentId: "a", sectionId: "s1" }),
      task("b", { sectionId: "gone" }),
      task("c"),
      task("d", { sectionId: "s2" }),
    ];
    const all = groups(tasks, [section("s1"), section("s2")]).flatMap((g) => g.rows.map((r) => r.task.id));
    expect(all.sort()).toEqual(tasks.map((t) => t.id).sort());
  });
});

describe("onPage", () => {
  const tasks = [
    task("loose"),
    task("p", { sectionId: "s1", isCollapsed: true }),
    task("k", { parentId: "p", sectionId: "s1" }),
    task("q", { sectionId: "s1" }),
    task("hidden", { sectionId: "s2" }),
    task("shown", { sectionId: "s3" }),
  ];
  const sections = [section("s1"), section("s2", { isCollapsed: true }), section("s3")];
  const page = () => onPage(groups(tasks, sections)).map((row) => row.task.id);

  it("leaves out rows folded under a parent and rows inside a folded section", () => {
    expect(page()).toEqual(["loose", "p", "q", "shown"]);
  });

  it("is what j and k walk, so a folded row is never selected", () => {
    const walk = page();
    // Down from the folded parent skips its hidden child.
    expect(moveSelection(walk, "p", 1)).toBe("q");
    // Down from the last row of the section before a folded one skips it whole.
    expect(moveSelection(walk, "q", 1)).toBe("shown");
    // And back up.
    expect(moveSelection(walk, "shown", -1)).toBe("q");
    expect(moveSelection(walk, "q", -1)).toBe("p");
  });

  it("agrees with the count: nothing folded means every task is on the page", () => {
    const unfolded = tasks.map((t) => ({ ...t, isCollapsed: false }));
    const open = sections.map((s) => ({ ...s, isCollapsed: false }));
    const shown = onPage(groups(unfolded, open));
    expect(shown).toHaveLength(tasks.length);
    // The badge for this list is the arrangement's length, folded or not.
    expect(arrangeSubtasks(tasks, indexTasks(tasks))).toHaveLength(tasks.length);
  });
});
