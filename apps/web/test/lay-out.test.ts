import { describe, expect, it } from "vitest";
import { layOut } from "../src/components/Day.js";

/**
 * The overlap sweep.
 *
 * The rule being tested is that a *run* of overlaps shares its width: two
 * tasks at nine o'clock each get half, and a third at ten on its own gets all
 * of it back. Getting that wrong is what makes a calendar either hide a task
 * or leave a day looking half empty.
 */
const at = (id: string, start: number, length: number) => ({ id, start, end: start + length });

describe("layOut", () => {
  it("gives a task on its own the full width", () => {
    expect(layOut([at("a", 540, 60)]).get("a")).toEqual({ column: 0, columns: 1 });
  });

  it("splits the width between two that overlap", () => {
    const placed = layOut([at("a", 540, 60), at("b", 570, 60)]);
    expect(placed.get("a")).toEqual({ column: 0, columns: 2 });
    expect(placed.get("b")).toEqual({ column: 1, columns: 2 });
  });

  it("gives the width back once the overlap is over", () => {
    const placed = layOut([at("a", 540, 60), at("b", 570, 60), at("c", 720, 30)]);
    expect(placed.get("c")).toEqual({ column: 0, columns: 1 });
  });

  it("reuses a column that has finished", () => {
    // b overlaps a; c starts after a ends but while b is still running, so it
    // belongs in a's column rather than a third one.
    const placed = layOut([at("a", 540, 30), at("b", 550, 120), at("c", 580, 30)]);
    expect(placed.get("c")?.column).toBe(0);
    expect(placed.get("c")?.columns).toBe(2);
  });

  it("treats touching blocks as not overlapping", () => {
    // 09:00–10:00 and 10:00–11:00 are back to back, not on top of each other.
    const placed = layOut([at("a", 540, 60), at("b", 600, 60)]);
    expect(placed.get("a")).toEqual({ column: 0, columns: 1 });
    expect(placed.get("b")).toEqual({ column: 0, columns: 1 });
  });

  it("does not depend on the order it is given them in", () => {
    const forwards = layOut([at("a", 540, 60), at("b", 570, 60)]);
    const backwards = layOut([at("b", 570, 60), at("a", 540, 60)]);
    expect(backwards).toEqual(forwards);
  });

  it("handles three at once", () => {
    const placed = layOut([at("a", 540, 90), at("b", 550, 90), at("c", 560, 90)]);
    expect([...placed.values()].map((p) => p.columns)).toEqual([3, 3, 3]);
    expect([...placed.values()].map((p) => p.column).sort()).toEqual([0, 1, 2]);
  });
});
