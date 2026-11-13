import { describe, expect, it } from "vitest";
import type { Task } from "@light/core";
import { foldSubtasks } from "../src/subtasks.js";

function task(id: string, content: string, parentId: string | null = null): Task {
  return { id, content, parentId } as Task;
}

const lookup = (all: Task[]) => (id: string) => all.find((t) => t.id === id) ?? null;

describe("foldSubtasks", () => {
  it("leaves a list with no subtasks exactly as it was", () => {
    const all = [task("a", "one"), task("b", "two")];
    const folded = foldSubtasks(all, lookup(all));

    expect(folded.tasks).toEqual(all);
    expect(folded.parentTitles.size).toBe(0);
  });

  it("drops a subtask whose parent is in the same list", () => {
    const parent = task("p", "Plan the trip");
    const child = task("c", "Book flights", "p");
    const folded = foldSubtasks([parent, child], lookup([parent, child]));

    expect(folded.tasks.map((t) => t.id)).toEqual(["p"]);
    expect(folded.parentTitles.size).toBe(0);
  });

  it("keeps a subtask whose parent is elsewhere, and says whose it is", () => {
    const parent = task("p", "Plan the trip");
    const child = task("c", "Book flights", "p");
    // The parent exists, but is not in this view's list.
    const folded = foldSubtasks([child], lookup([parent, child]));

    expect(folded.tasks.map((t) => t.id)).toEqual(["c"]);
    expect(folded.parentTitles.get("c")).toBe("Plan the trip");
  });

  it("keeps an orphan without inventing a hint when the parent cannot be found", () => {
    const child = task("c", "Book flights", "gone");
    const folded = foldSubtasks([child], lookup([child]));

    expect(folded.tasks).toHaveLength(1);
    expect(folded.parentTitles.has("c")).toBe(false);
  });

  it("applies the rule per level, so a grandchild follows its own parent", () => {
    const a = task("a", "Trip");
    const b = task("b", "Flights", "a");
    const c = task("c", "Window seat", "b");
    const all = [a, b, c];

    // Everything present: only the root is a row.
    expect(foldSubtasks(all, lookup(all)).tasks.map((t) => t.id)).toEqual(["a"]);

    // The middle one is absent: the grandchild is an orphan of it, not of the root.
    const folded = foldSubtasks([a, c], lookup(all));
    expect(folded.tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(folded.parentTitles.get("c")).toBe("Flights");
  });

  it("never lists a task twice", () => {
    const parent = task("p", "Plan");
    const kids = [task("c1", "x", "p"), task("c2", "y", "p")];
    const all = [parent, ...kids];
    const ids = foldSubtasks(all, lookup(all)).tasks.map((t) => t.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves the order it was given", () => {
    const all = [task("z", "last alphabetically"), task("a", "first"), task("m", "middle")];
    expect(foldSubtasks(all, lookup(all)).tasks.map((t) => t.id)).toEqual(["z", "a", "m"]);
  });
});
