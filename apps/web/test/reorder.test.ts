import { describe, expect, it } from "vitest";
import type { Task } from "@light/core";
import { headingUnder, neighbour, planReorder, planSectionMove, sideOf } from "../src/reorder.js";

function task(id: string, fields: Partial<Task> = {}): Task {
  return {
    id,
    projectId: "p1",
    sectionId: null,
    parentId: null,
    content: id,
    description: "",
    priority: 4,
    order: id,
    dayOrder: null,
    due: null,
    deadline: null,
    duration: null,
    reward: null,
    labelIds: [],
    isCompleted: false,
    completedAt: null,
    isCollapsed: false,
    assigneeId: null,
    addedById: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...fields,
  };
}

const list = [task("a"), task("b"), task("c"), task("d")];

describe("planReorder", () => {
  it("drops after a row by naming it", () => {
    expect(planReorder(list, "a", "c", "after")).toEqual({ afterId: "c" });
  });

  it("drops before a row by naming the one above it", () => {
    expect(planReorder(list, "d", "c", "before")).toEqual({ afterId: "b" });
  });

  it("drops before the first row at the head", () => {
    expect(planReorder(list, "c", "a", "before")).toEqual({ afterId: null });
  });

  it("drops after the last row", () => {
    expect(planReorder(list, "a", "d", "after")).toEqual({ afterId: "d" });
  });

  it("does nothing when the row is put back where it was", () => {
    expect(planReorder(list, "b", "b", "after")).toBeNull();
    expect(planReorder(list, "b", "a", "after")).toBeNull(); // already straight after a
    expect(planReorder(list, "b", "c", "before")).toBeNull(); // already straight before c
    expect(planReorder(list, "a", "b", "before")).toBeNull(); // already at the head
  });

  it("ignores neighbours from another list: they have no position to share", () => {
    const mixed = [task("a"), task("x", { projectId: "p2" }), task("b"), task("c")];
    // Dropped on the other project's row: nothing.
    expect(planReorder(mixed, "a", "x", "after")).toBeNull();
    // Dropped before b: x is stepped over, so a is already straight before b.
    expect(planReorder(mixed, "a", "b", "before")).toBeNull();
    // Dropped after c from the head of the mixed list.
    expect(planReorder(mixed, "a", "c", "after")).toEqual({ afterId: "c" });
    // Before c is after b, whatever sits on screen between them.
    expect(planReorder(mixed, "a", "c", "before")).toEqual({ afterId: "b" });
  });

  it("keeps a subtask among its own siblings", () => {
    const withChildren = [
      task("a"),
      task("a1", { parentId: "a" }),
      task("a2", { parentId: "a" }),
      task("b"),
    ];
    expect(planReorder(withChildren, "a2", "a1", "before")).toEqual({ afterId: null });
    expect(planReorder(withChildren, "a2", "b", "after")).toBeNull();
  });

  it("does nothing for ids it cannot find", () => {
    expect(planReorder(list, "zzz", "a", "after")).toBeNull();
    expect(planReorder(list, "a", "zzz", "after")).toBeNull();
  });
});

describe("sideOf", () => {
  it("splits a row at its middle", () => {
    expect(sideOf(100, 100, 40)).toBe("before");
    expect(sideOf(119, 100, 40)).toBe("before");
    expect(sideOf(120, 100, 40)).toBe("after");
    expect(sideOf(139, 100, 40)).toBe("after");
  });
});

describe("neighbour", () => {
  it("steps over rows that are not in the same list", () => {
    // a has a child between it and its next sibling, as the indented list draws it.
    const drawn = [task("a"), task("a1", { parentId: "a" }), task("b")];
    expect(neighbour(drawn, "a", 1)).toBe("b");
    expect(neighbour(drawn, "b", -1)).toBe("a");
  });

  it("does not cross a section heading", () => {
    const drawn = [task("a", { sectionId: "s1" }), task("b", { sectionId: "s2" })];
    expect(neighbour(drawn, "a", 1)).toBeNull();
    expect(neighbour(drawn, "b", -1)).toBeNull();
  });

  it("is null at the ends and for a row that is not shown", () => {
    expect(neighbour(list, "a", -1)).toBeNull();
    expect(neighbour(list, "d", 1)).toBeNull();
    expect(neighbour(list, "ghost", 1)).toBeNull();
  });
});

describe("planSectionMove", () => {
  const known = new Set(["s1", "s2"]);
  const drawn = [
    task("loose"),
    task("a", { sectionId: "s1" }),
    task("b", { sectionId: "s1" }),
    task("c", { sectionId: "s2" }),
    task("d", { sectionId: "s2" }),
  ];

  it("files a row in the other section, after the row it was dropped on", () => {
    expect(planSectionMove(drawn, "a", "c", "after", known)).toEqual({ sectionId: "s2", afterId: "c" });
  });

  it("before a row means after whatever precedes it in that section, or first", () => {
    expect(planSectionMove(drawn, "a", "d", "before", known)).toEqual({ sectionId: "s2", afterId: "c" });
    expect(planSectionMove(drawn, "a", "c", "before", known)).toEqual({ sectionId: "s2", afterId: null });
  });

  it("can take a row out of a section to the root", () => {
    expect(planSectionMove(drawn, "a", "loose", "after", known)).toEqual({ sectionId: null, afterId: "loose" });
  });

  it("is nothing within one section, which is planReorder's job", () => {
    expect(planSectionMove(drawn, "a", "b", "after", known)).toBeNull();
    expect(planSectionMove(drawn, "a", "a", "after", known)).toBeNull();
  });

  it("never moves a subtask on its own, or onto one", () => {
    const withChild = [...drawn, task("a1", { parentId: "a", sectionId: "s1" })];
    expect(planSectionMove(withChild, "a1", "c", "after", known)).toBeNull();
    expect(planSectionMove(withChild, "a", "a1", "after", known)).toBeNull();
  });

  it("is nothing across projects", () => {
    const mixed = [task("a", { sectionId: "s1" }), task("x", { projectId: "p2", sectionId: "s2" })];
    expect(planSectionMove(mixed, "a", "x", "after", known)).toBeNull();
  });

  it("treats a task naming a section that is gone as unsectioned, as the page does", () => {
    const dangling = [task("a", { sectionId: "s1" }), task("z", { sectionId: "deleted" })];
    expect(planSectionMove(dangling, "a", "z", "after", known)).toEqual({ sectionId: null, afterId: "z" });
    // Already at the root as far as anyone can see: nothing to do.
    const both = [task("z", { sectionId: "deleted" }), task("y")];
    expect(planSectionMove(both, "z", "y", "after", known)).toBeNull();
  });
});

describe("headingUnder", () => {
  it("reads the section id off the heading the point is over", () => {
    const heading = { dataset: { sectionId: "s1" } };
    const inside = { closest: (selector: string) => (selector === "[data-section-id]" ? heading : null) };
    expect(headingUnder(1, 1, { elementFromPoint: () => inside as unknown as Element })).toBe("s1");
  });

  it("is null over anything else, and over nothing", () => {
    expect(headingUnder(1, 1, { elementFromPoint: () => null })).toBeNull();
    const elsewhere = { closest: () => null };
    expect(headingUnder(1, 1, { elementFromPoint: () => elsewhere as unknown as Element })).toBeNull();
  });
});
