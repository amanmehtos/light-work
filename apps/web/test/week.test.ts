import { describe, expect, it } from "vitest";
import type { Task } from "@light/core";
import { atDay, atTime } from "../src/schedule.js";
import { bucketWeek, layOut, previewDay, slotAt, weekDays, weekStart, weekTitle } from "../src/week.js";

/**
 * Light Week's arithmetic: which days are on the page, which tasks go on each,
 * and where blocks sit while one is being carried.
 *
 * The bucketing tests are the owner's complaint written down: an undated task
 * appeared in Waiting, and Waiting is only for a task with a date and no time.
 */

const task = (id: string, due: Task["due"], extra: Partial<Task> = {}): Task =>
  ({
    id,
    content: id,
    due,
    duration: null,
    isCompleted: false,
    ...extra,
  }) as Task;

describe("weekStart", () => {
  it("is the Monday on or before the day", () => {
    // 2026-11-26 is a Thursday.
    expect(weekStart("2026-11-26")).toBe("2026-11-23");
    expect(weekStart("2026-11-23")).toBe("2026-11-23");
  });

  it("puts a Sunday at the end of its week, not the start of the next", () => {
    expect(weekStart("2026-11-29")).toBe("2026-11-23");
  });

  it("crosses a month and a year", () => {
    expect(weekStart("2027-01-01")).toBe("2026-12-28");
  });

  it("can start on Sunday when asked", () => {
    expect(weekStart("2026-11-26", 0)).toBe("2026-11-22");
  });
});

describe("weekDays", () => {
  it("is seven consecutive days", () => {
    expect(weekDays("2026-12-28")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });
});

describe("weekTitle", () => {
  it("names the month once when the week is inside one", () => {
    const title = weekTitle("2026-11-23");
    expect(title).toMatch(/23/);
    expect(title).toMatch(/29/);
    expect(title.match(/Nov/g)).toHaveLength(1);
    expect(title.match(/2026/g)).toHaveLength(1);
  });
});

describe("bucketWeek", () => {
  const days = weekDays("2026-11-23");

  it("keeps an undated task out of the week altogether", () => {
    const byDay = bucketWeek([task("undated", null)], days);
    for (const day of days) {
      expect(byDay.get(day)?.waiting).toEqual([]);
      expect(byDay.get(day)?.timed).toEqual([]);
    }
  });

  it("puts a task with a date and no time in its day's Waiting", () => {
    const byDay = bucketWeek([task("a", atDay("2026-11-25"))], days);
    expect(byDay.get("2026-11-25")?.waiting.map((t) => t.id)).toEqual(["a"]);
    expect(byDay.get("2026-11-25")?.timed).toEqual([]);
    expect(byDay.get("2026-11-24")?.waiting).toEqual([]);
  });

  it("puts a timed task in the hours, earliest first", () => {
    const byDay = bucketWeek(
      [task("late", atTime("2026-11-24", 15 * 60)), task("early", atTime("2026-11-24", 9 * 60))],
      days,
    );
    expect(byDay.get("2026-11-24")?.timed.map((t) => t.id)).toEqual(["early", "late"]);
    expect(byDay.get("2026-11-24")?.waiting).toEqual([]);
  });

  it("leaves out what is done and what is in another week", () => {
    const byDay = bucketWeek(
      [task("done", atDay("2026-11-24"), { isCompleted: true }), task("next", atDay("2026-11-30"))],
      days,
    );
    expect([...byDay.values()].flatMap((d) => [...d.waiting, ...d.timed])).toEqual([]);
  });
});

describe("slotAt", () => {
  it("snaps to the quarter hour", () => {
    expect(slotAt(9 * 60 + 7, 0, 30)).toBe(9 * 60);
    expect(slotAt(9 * 60 + 8, 0, 30)).toBe(9 * 60 + 15);
  });

  it("keeps the place the block was taken hold of under the pointer", () => {
    // Held twenty minutes below its top, at 10:20: the top is at 10:00.
    expect(slotAt(10 * 60 + 20, 20, 60)).toBe(10 * 60);
  });

  it("keeps the whole block inside the day", () => {
    expect(slotAt(23 * 60 + 50, 0, 60)).toBe(23 * 60);
    expect(slotAt(23 * 60 + 50, 0, 50)).toBe(23 * 60);
    expect(slotAt(-30, 0, 30)).toBe(0);
  });
});

describe("previewDay, laid out", () => {
  const at = (id: string, start: number, length: number) => ({ id, start, end: start + length });
  const day = "2026-11-24";

  it("makes room beside a block for one hovering over it", () => {
    const spans = [at("a", 540, 60)];
    const live = layOut(previewDay(spans, day, { id: "m", length: 60 }, { kind: "slot", day, minutes: 570 }));
    expect(live.get("a")).toEqual({ column: 0, columns: 2 });
    expect(live.get("m")).toEqual({ column: 1, columns: 2 });
  });

  it("gives a day its width back when the block in hand leaves it", () => {
    const spans = [at("a", 540, 60), at("m", 540, 60)];
    const elsewhere = previewDay(spans, day, { id: "m", length: 60 }, { kind: "slot", day: "2026-11-25", minutes: 540 });
    expect(layOut(elsewhere).get("a")).toEqual({ column: 0, columns: 1 });
    expect(elsewhere.map((s) => s.id)).toEqual(["a"]);
  });

  it("moves a block within its own day rather than counting it twice", () => {
    const spans = [at("a", 540, 60), at("m", 540, 60)];
    const moved = previewDay(spans, day, { id: "m", length: 60 }, { kind: "slot", day, minutes: 720 });
    expect(moved).toEqual([at("a", 540, 60), at("m", 720, 60)]);
    expect(layOut(moved).get("a")).toEqual({ column: 0, columns: 1 });
  });

  it("takes the block off the hours when it is over a strip", () => {
    const spans = [at("a", 540, 60), at("m", 540, 60)];
    expect(previewDay(spans, day, { id: "m", length: 60 }, { kind: "strip", day })).toEqual([at("a", 540, 60)]);
  });

  it("leaves the day as it is when nothing is in hand, or it is outside the week", () => {
    const spans = [at("a", 540, 60), at("m", 540, 60)];
    expect(previewDay(spans, day, null, null)).toEqual(spans);
    expect(previewDay(spans, day, { id: "m", length: 60 }, null)).toEqual(spans);
  });
});
