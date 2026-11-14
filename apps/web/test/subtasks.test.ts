import { describe, expect, it } from "vitest";
import type { Task } from "@light/core";
import { arrangeSubtasks, descendantIds, flatRows, indexTasks } from "../src/subtasks.js";

function task(id: string, content: string, fields: Partial<Task> = {}): Task {
  return { id, content, parentId: null, isCollapsed: false, isCompleted: false, ...fields } as Task;
}

const ids = (rows: { task: Task }[]) => rows.map((row) => row.task.id);

describe("arrangeSubtasks", () => {
  it("leaves a list with no subtasks exactly as it was", () => {
    const all = [task("a", "one"), task("b", "two")];
    const rows = arrangeSubtasks(all, indexTasks(all));

    expect(ids(rows)).toEqual(["a", "b"]);
    expect(rows.every((row) => row.depth === 0 && row.parentTitle === null && row.subtasks === null)).toBe(true);
  });

  it("draws a subtask beneath its parent, one step in, instead of dropping it", () => {
    const parent = task("p", "Plan the trip");
    const child = task("c", "Book flights", { parentId: "p" });
    const rows = arrangeSubtasks([parent, child], indexTasks([parent, child]));

    expect(ids(rows)).toEqual(["p", "c"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1]);
    // It is beside its parent, so it does not need to say whose it is.
    expect(rows[1]!.parentTitle).toBeNull();
  });

  it("brings a child up under its parent even when the list had it first or apart", () => {
    const a = task("a", "A");
    const b = task("b", "B");
    const a1 = task("a1", "A's", { parentId: "a" });
    const rows = arrangeSubtasks([a1, a, b], indexTasks([a, b, a1]));

    expect(ids(rows)).toEqual(["a", "a1", "b"]);
  });

  it("keeps a subtask whose parent is elsewhere as a root, and says whose it is", () => {
    const parent = task("p", "Plan the trip");
    const child = task("c", "Book flights", { parentId: "p" });
    // The parent exists, but is not in this view's list.
    const rows = arrangeSubtasks([child], indexTasks([parent, child]));

    expect(ids(rows)).toEqual(["c"]);
    expect(rows[0]).toMatchObject({ depth: 0, parentTitle: "Plan the trip" });
  });

  it("keeps an orphan without inventing a hint when the parent cannot be found", () => {
    const child = task("c", "Book flights", { parentId: "gone" });
    const rows = arrangeSubtasks([child], indexTasks([child]));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.parentTitle).toBeNull();
  });

  it("applies the rule per level, so a grandchild follows its own parent", () => {
    const a = task("a", "Trip");
    const b = task("b", "Flights", { parentId: "a" });
    const c = task("c", "Window seat", { parentId: "b" });
    const all = [a, b, c];

    expect(arrangeSubtasks(all, indexTasks(all)).map((row) => row.depth)).toEqual([0, 1, 2]);

    // The middle one is absent: the grandchild is an orphan of it, not a child of the root.
    const rows = arrangeSubtasks([a, c], indexTasks(all));
    expect(rows.map((row) => [row.task.id, row.depth])).toEqual([["a", 0], ["c", 0]]);
    expect(rows[1]!.parentTitle).toBe("Flights");
  });

  it("preserves the order it was given, among roots and among siblings", () => {
    const all = [
      task("z", "last alphabetically"),
      task("a", "first"),
      task("m1", "second child", { parentId: "z" }),
      task("m0", "first child", { parentId: "z" }),
    ];
    expect(ids(arrangeSubtasks(all, indexTasks(all)))).toEqual(["z", "m1", "m0", "a"]);
  });

  describe("what the sidebar counts rest on", () => {
    // The badge is `arrangeSubtasks(list).length`; the rows are what it returns.
    // These are the properties that make the two the same number.
    const lists: [string, Task[]][] = [
      ["flat", [task("a", "a"), task("b", "b")]],
      ["a tree", [task("p", "p"), task("c1", "c1", { parentId: "p" }), task("c2", "c2", { parentId: "p" })]],
      ["an orphan beside a tree", [task("p", "p"), task("c", "c", { parentId: "p" }), task("o", "o", { parentId: "elsewhere" })]],
      ["a folded parent", [task("p", "p", { isCollapsed: true }), task("c", "c", { parentId: "p" })]],
      ["a parent cycle", [task("x", "x", { parentId: "y" }), task("y", "y", { parentId: "x" })]],
      ["a task its own parent", [task("s", "s", { parentId: "s" })]],
    ];

    it.each(lists)("drops nothing and repeats nothing: %s", (_name, list) => {
      const rows = arrangeSubtasks(list, indexTasks(list));
      expect(rows).toHaveLength(list.length);
      expect(new Set(ids(rows)).size).toBe(list.length);
      expect(ids(rows).sort()).toEqual(list.map((t) => t.id).sort());
    });

    it("is the same number whether or not anything is folded", () => {
      const open = [task("p", "p"), task("c1", "c1", { parentId: "p" }), task("c2", "c2", { parentId: "p" })];
      const folded = [{ ...open[0]!, isCollapsed: true }, open[1]!, open[2]!];

      expect(arrangeSubtasks(open, indexTasks(open))).toHaveLength(3);
      expect(arrangeSubtasks(folded, indexTasks(folded))).toHaveLength(3);
    });
  });

  describe("folding", () => {
    const parent = task("p", "p", { isCollapsed: true });
    const kid = task("k", "k", { parentId: "p" });
    const grand = task("g", "g", { parentId: "k" });
    const after = task("n", "n");
    const all = [parent, kid, grand, after];

    it("hides every descendant of a folded parent and nothing else", () => {
      const rows = arrangeSubtasks(all, indexTasks(all));
      expect(rows.map((row) => [row.task.id, row.hidden])).toEqual([
        ["p", false],
        ["k", true],
        ["g", true],
        ["n", false],
      ]);
      expect(rows[0]).toMatchObject({ hasChildren: true, collapsed: true });
    });

    it("hides what is under a folded child even when the parent is open", () => {
      const open = [{ ...parent, isCollapsed: false }, { ...kid, isCollapsed: true }, grand];
      const rows = arrangeSubtasks(open, indexTasks(open));
      expect(rows.map((row) => row.hidden)).toEqual([false, false, true]);
    });

    it("does not call a task folded when there is nothing under it to fold", () => {
      // The flag is synced and can be set on a task whose subtasks are all
      // elsewhere; a chevron with nothing behind it would be a lie.
      const lone = task("l", "l", { isCollapsed: true });
      const rows = arrangeSubtasks([lone], indexTasks([lone]));
      expect(rows[0]).toMatchObject({ hasChildren: false, collapsed: false, hidden: false });
    });
  });

  describe("the 2/5", () => {
    it("counts finished subtasks over all of them, including ones not in the list", () => {
      const parent = task("p", "p");
      const open1 = task("c1", "c1", { parentId: "p" });
      const done1 = task("c2", "c2", { parentId: "p", isCompleted: true });
      const done2 = task("c3", "c3", { parentId: "p", isCompleted: true });
      const all = [parent, open1, done1, done2];

      // Only the parent and the one open child are in the list; the chip still
      // says where the task as a whole stands.
      const rows = arrangeSubtasks([parent, open1], indexTasks(all));
      expect(rows[0]!.subtasks).toEqual({ done: 2, total: 3 });
      expect(rows[0]!.hasChildren).toBe(true);
      expect(rows[1]!.subtasks).toBeNull();
    });

    it("has a chip but nothing to fold when no subtask is in this list", () => {
      const parent = task("p", "p");
      const child = task("c", "c", { parentId: "p" });
      const rows = arrangeSubtasks([parent], indexTasks([parent, child]));
      expect(rows[0]).toMatchObject({ subtasks: { done: 0, total: 1 }, hasChildren: false });
    });
  });
});

describe("flatRows", () => {
  it("does not nest, and says whose a subtask is", () => {
    const parent = task("p", "Plan the trip");
    const child = task("c", "Book flights", { parentId: "p" });
    const rows = flatRows([child, parent], indexTasks([parent, child]));

    expect(ids(rows)).toEqual(["c", "p"]);
    expect(rows.every((row) => row.depth === 0 && !row.hidden)).toBe(true);
    expect(rows[0]!.parentTitle).toBe("Plan the trip");
    expect(rows[1]!.parentTitle).toBeNull();
  });
});

describe("descendantIds", () => {
  it("is everything beneath a row, down to the next row at its own depth", () => {
    const all = [task("a", "a"), task("a1", "a1", { parentId: "a" }), task("a2", "a2", { parentId: "a1" }), task("b", "b")];
    const rows = arrangeSubtasks(all, indexTasks(all));
    expect([...descendantIds(rows, "a")]).toEqual(["a1", "a2"]);
    expect([...descendantIds(rows, "b")]).toEqual([]);
    expect([...descendantIds(rows, "ghost")]).toEqual([]);
  });
});
