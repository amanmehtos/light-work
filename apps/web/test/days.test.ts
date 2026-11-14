import { describe, expect, it } from "vitest";
import type { Due, Task } from "@light/core";
import {
  LOOKAHEAD_DAYS,
  countRows,
  dayLabel,
  groupByDay,
  onPageDays,
  planDayReorder,
  siblingBeside,
  todayRows,
} from "../src/days.js";
import { dayUnder } from "../src/reorder.js";
import { dueDay } from "../src/schedule.js";
import { moveSelection } from "../src/shortcuts.js";
import { arrangeSubtasks, indexTasks } from "../src/subtasks.js";

const TODAY = "2026-11-14"; // a Saturday
const day = { today: TODAY, dayOf: dueDay };

function due(date: string | null): Due | null {
  return date === null
    ? null
    : { date, hasTime: false, text: null, timezone: null, isRecurring: false };
}

function task(id: string, date: string | null, fields: Partial<Task> = {}): Task {
  return {
    id,
    content: id,
    projectId: "p",
    sectionId: null,
    parentId: null,
    order: id,
    dayOrder: null,
    due: due(date),
    isCollapsed: false,
    isCompleted: false,
    ...fields,
  } as Task;
}

const ids = (rows: { task: Task }[]) => rows.map((row) => row.task.id);
const shape = (groups: ReturnType<typeof groupByDay>) =>
  groups.filter((group) => group.rows.length > 0).map((group) => [group.day, ids(group.rows)] as const);

describe("groupByDay", () => {
  it("has a heading for each of the next week's days, even with nothing due on them", () => {
    const groups = groupByDay([], indexTasks([]), day);
    expect(groups.map((group) => group.day)).toEqual([
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
    ]);
    expect(groups).toHaveLength(LOOKAHEAD_DAYS);
    expect(countRows(groups)).toBe(0);
  });

  it("adds a heading for a later day that has work, in date order, after the week", () => {
    const all = [task("far", "2027-01-05"), task("near", "2026-11-16"), task("mid", "2026-12-01")];
    const groups = groupByDay(all, indexTasks(all), day);
    expect(groups.map((group) => group.day).slice(-2)).toEqual(["2026-12-01", "2027-01-05"]);
    expect(shape(groups)).toEqual([
      ["2026-11-16", ["near"]],
      ["2026-12-01", ["mid"]],
      ["2027-01-05", ["far"]],
    ]);
  });

  it("leaves today, overdue and undated work to Today and Upcoming alone", () => {
    const all = [task("late", "2026-11-01"), task("now", TODAY), task("never", null), task("soon", "2026-11-15")];
    expect(shape(groupByDay(all, indexTasks(all), day))).toEqual([["2026-11-15", ["soon"]]]);
  });

  it("orders a day by dayOrder where set and order otherwise", () => {
    const all = [
      task("a", "2026-11-16", { order: "a" }),
      task("b", "2026-11-16", { order: "c" }),
      // Filed last, but arranged to sit between the other two.
      task("c", "2026-11-16", { order: "e", dayOrder: "b" }),
    ];
    expect(shape(groupByDay(all, indexTasks(all), day))).toEqual([["2026-11-16", ["a", "c", "b"]]]);
  });

  it("does not fold one day's order into another's", () => {
    const all = [task("fri", "2026-11-20", { order: "a" }), task("sun", "2026-11-15", { order: "z" })];
    expect(shape(groupByDay(all, indexTasks(all), day)).map(([d]) => d)).toEqual(["2026-11-15", "2026-11-20"]);
  });
});

describe("a day's rows are arranged like every other list", () => {
  it("nests a subtask under its parent when both are due that day", () => {
    const all = [task("p", "2026-11-16"), task("c", "2026-11-16", { parentId: "p" })];
    const [group] = groupByDay(all, indexTasks(all), day).filter((g) => g.rows.length > 0);
    expect(group!.rows.map((row) => [row.task.id, row.depth])).toEqual([["p", 0], ["c", 1]]);
  });

  it("leaves a subtask standing alone, naming its parent, when the parent is due another day", () => {
    const parent = task("p", "2026-11-16", { content: "Plan the trip" });
    const child = task("c", "2026-11-18", { parentId: "p" });
    const all = [parent, child];
    const groups = groupByDay(all, indexTasks(all), day);
    const wednesday = groups.find((group) => group.day === "2026-11-18")!;
    expect(wednesday.rows).toHaveLength(1);
    expect(wednesday.rows[0]!.depth).toBe(0);
    expect(wednesday.rows[0]!.parentTitle).toBe("Plan the trip");
  });
});

describe("the count is the rows", () => {
  // A messy week: nesting within a day, a subtask across days, a folded parent,
  // a parent cycle, a deleted parent, overdue, undated, and a task far out.
  const all = [
    task("p", "2026-11-16", { isCollapsed: true }),
    task("c1", "2026-11-16", { parentId: "p" }),
    task("c2", "2026-11-16", { parentId: "p" }),
    task("gc", "2026-11-16", { parentId: "c1" }),
    task("x", "2026-11-17"),
    task("sub-elsewhere", "2026-11-19", { parentId: "x" }),
    task("orphan", "2026-11-19", { parentId: "deleted" }),
    task("cycle-a", "2026-11-20", { parentId: "cycle-b" }),
    task("cycle-b", "2026-11-20", { parentId: "cycle-a" }),
    task("late", "2026-11-01"),
    task("undated", null),
    task("far", "2027-03-03"),
  ];
  const index = indexTasks(all);

  it("equals the arrangement of every upcoming task, folded rows included", () => {
    const groups = groupByDay(all, index, day);
    const upcoming = all.filter((t) => (dueDay(t.due) ?? "") > TODAY);
    // Not "the length of the groups' visible rows": a fold hides rows, it does not remove them.
    expect(countRows(groups)).toBe(arrangeSubtasks(upcoming, index).length);
    expect(countRows(groups)).toBe(upcoming.length);
  });

  it("is more than what the page shows when a parent is folded, and the page is a subset of it", () => {
    const groups = groupByDay(all, index, day);
    const shown = onPageDays(groups);
    expect(shown.length).toBeLessThan(countRows(groups));
    expect(shown.some((row) => row.hidden)).toBe(false);
    // c1, c2 and gc are inside the folded p.
    const everyId = groups.flatMap((group) => ids(group.rows));
    for (const hidden of ["c1", "c2", "gc"]) {
      expect(everyId).toContain(hidden);
      expect(ids(shown)).not.toContain(hidden);
    }
  });

  it("does not move when a chevron does", () => {
    const open = all.map((t) => (t.id === "p" ? { ...t, isCollapsed: false } : t));
    expect(countRows(groupByDay(open, indexTasks(open), day))).toBe(countRows(groupByDay(all, index, day)));
  });

  it("puts every upcoming task on exactly one day", () => {
    const groups = groupByDay(all, index, day);
    const seen = groups.flatMap((group) => ids(group.rows));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("makes Today's count its rows, overdue and all", () => {
    const rows = todayRows(all, index, day);
    expect(ids(rows).sort()).toEqual(["late"]);
    expect(rows.length).toBe(arrangeSubtasks(all.filter((t) => (dueDay(t.due) ?? "9") <= TODAY), index).length);
  });
});

describe("j and k in a day-grouped list", () => {
  const all = [
    task("fri", "2026-11-20"),
    task("sun-parent", "2026-11-15", { isCollapsed: true }),
    task("sun-child", "2026-11-15", { parentId: "sun-parent" }),
    task("sun-after", "2026-11-15", { order: "z" }),
    task("tue", "2026-11-17"),
  ];
  const groups = groupByDay(all, indexTasks(all), day);
  const walk = ids(onPageDays(groups));

  it("walks down through the days in the order they are drawn", () => {
    expect(walk).toEqual(["sun-parent", "sun-after", "tue", "fri"]);
    let at: string | null = null;
    const visited: string[] = [];
    for (let step = 0; step < 4; step++) {
      at = moveSelection(walk, at, 1);
      visited.push(at!);
    }
    expect(visited).toEqual(walk);
  });

  it("steps over a row folded under its parent and over a day with nothing on it", () => {
    expect(walk).not.toContain("sun-child");
    // Monday the 16th is a heading with no rows; the walk goes from Sunday to Tuesday.
    expect(moveSelection(walk, "sun-after", 1)).toBe("tue");
  });

  it("stays put at either end rather than wrapping", () => {
    expect(moveSelection(walk, "fri", 1)).toBe("fri");
    expect(moveSelection(walk, "sun-parent", -1)).toBe("sun-parent");
  });
});

describe("planDayReorder", () => {
  const rowsOf = (tasks: Task[]) => arrangeSubtasks(tasks, indexTasks(tasks));

  it("places a row among any tasks of the day, whatever project they are in", () => {
    const rows = rowsOf([
      task("a", TODAY, { projectId: "work" }),
      task("b", TODAY, { projectId: "home" }),
      task("c", TODAY, { projectId: "gym" }),
    ]);
    // `planReorder` would refuse every one of these: they share no project.
    expect(planDayReorder(rows, "a", "c", "after")).toEqual({ afterId: "c" });
    expect(planDayReorder(rows, "c", "b", "before")).toEqual({ afterId: "a" });
    expect(planDayReorder(rows, "c", "a", "before")).toEqual({ afterId: null });
  });

  it("means nothing when dropped where it already is, or on itself", () => {
    const rows = rowsOf([task("a", TODAY), task("b", TODAY), task("c", TODAY)]);
    expect(planDayReorder(rows, "b", "b", "after")).toBeNull();
    expect(planDayReorder(rows, "b", "a", "after")).toBeNull();
    expect(planDayReorder(rows, "b", "c", "before")).toBeNull();
  });

  it("keeps a subtask among its brothers and a root among the roots", () => {
    const rows = rowsOf([
      task("p", TODAY),
      task("c1", TODAY, { parentId: "p" }),
      task("c2", TODAY, { parentId: "p" }),
      task("q", TODAY),
    ]);
    expect(planDayReorder(rows, "c2", "c1", "before")).toEqual({ afterId: null });
    // A subtask is not carried out from under its parent onto another root...
    expect(planDayReorder(rows, "c1", "q", "after")).toBeNull();
    // ...and a root is not dropped among someone's subtasks.
    expect(planDayReorder(rows, "q", "c1", "before")).toBeNull();
    // Dropping after a root with children goes beneath all of them.
    expect(planDayReorder(rows, "q", "p", "before")).toEqual({ afterId: null });
  });

  it("steps over rows folded away, as the person sees the list", () => {
    const rows = rowsOf([
      task("a", TODAY),
      task("p", TODAY, { isCollapsed: true }),
      task("hidden", TODAY, { parentId: "p" }),
      task("z", TODAY),
    ]);
    expect(planDayReorder(rows, "a", "hidden", "after")).toBeNull();
    expect(siblingBeside(rows, "p", 1)).toBe("z");
    expect(siblingBeside(rows, "a", -1)).toBeNull();
  });
});

describe("dayUnder", () => {
  const doc = (dataset: Record<string, string> | null) => ({
    elementFromPoint: () =>
      dataset === null
        ? null
        : ({ closest: (selector: string) => (selector === "[data-day]" ? { dataset } : null) } as unknown as Element),
  });

  it("reads the day off the group the pointer is over", () => {
    expect(dayUnder(1, 1, doc({ day: "2026-11-20" }))).toBe("2026-11-20");
  });

  it("is null off the list, or over something that is not a day", () => {
    expect(dayUnder(1, 1, doc(null))).toBeNull();
    expect(
      dayUnder(1, 1, { elementFromPoint: () => ({ closest: () => null }) as unknown as Element }),
    ).toBeNull();
  });
});

describe("dayLabel", () => {
  it("calls the day after today Tomorrow, and keeps its date beside it", () => {
    const label = dayLabel("2026-11-15", TODAY);
    expect(label.name).toBe("Tomorrow");
    expect(label.date).not.toBe("");
  });

  it("names any other day by its weekday and date alone", () => {
    const label = dayLabel("2026-11-20", TODAY);
    expect(label.name).toMatch(/20/);
    expect(label.date).toBe("");
  });
});
