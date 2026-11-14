import { describe, expect, it } from "vitest";
import type { Task } from "@light/core";
import { planReorder, sideOf } from "../src/reorder.js";

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
