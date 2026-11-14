/**
 * Upcoming and Today, as days.
 *
 * A second way to group a list, beside `sections.ts`. The two are the same kind
 * of thing — rows (already arranged around their subtasks by `arrangeSubtasks`)
 * dealt into runs under a heading — and they are deliberately *not* composed
 * with each other. A section is one project's own structure, and a day's list
 * mixes every project, so there is no section to put a row under; and a project
 * view is not a day, so it has no days. Each view has one grouping axis, chosen
 * by the view, and both axes read the same `Row[]` and filter it the same way
 * (`hidden`, which is what `j`/`k` and the page both skip). What is shared is the
 * arrangement, not a second grouping on top of it.
 *
 * **The count is the rows.** Every count in the sidebar is the length of what is
 * rendered, taken from the same call, so a badge and its list cannot drift:
 * `arrangeSubtasks` never drops a task, a day group is `arrangeSubtasks` of that
 * day's list, and every upcoming task is on exactly one day, so the groups'
 * lengths add up to the length of the whole. `countRows` is that sum, and the
 * view and the sidebar both call it.
 *
 * A day's tasks are in the order `tasksOnDay` gives — `dayOrder` where it is set,
 * `order` otherwise — which is the order `Operations.reorderInDay` rearranges, so
 * what is drawn and what a drop writes to cannot disagree about the list.
 */

import type { Due, Task } from "@light/core";
import { tasksOnDay } from "@light/client-sdk";
import { shiftDay } from "./schedule.js";
import { arrangeSubtasks, type Row, type TaskIndex } from "./subtasks.js";
import type { Side } from "./reorder.js";

export interface DayGroup {
  /** `YYYY-MM-DD`, the local calendar day. */
  day: string;
  rows: Row[];
}

/**
 * How many days ahead are always on the page, even with nothing due.
 *
 * A heading for a day with nothing on it is the point of drag-between-days: the
 * day you want to push a task to is more often empty than not, and a list that
 * only has headings for days that already have work has nowhere to drop it.
 * A week is what fits a screen and what "move it to Friday" reaches.
 */
export const LOOKAHEAD_DAYS = 7;

interface DayContext {
  today: string;
  /** The calendar day of a due in the reader's zone; see `dueDay`. */
  dayOf: (due: Due | null) => string | null;
}

/** Today's list, arranged: everything due on or before today, overdue included. */
export function todayRows(
  open: readonly Task[],
  index: TaskIndex,
  { today, dayOf }: DayContext,
): Row[] {
  return arrangeSubtasks(tasksOnDay(open, { day: today, today, dayOf }), index);
}

/**
 * Upcoming, a heading per day: the next `LOOKAHEAD_DAYS` days whether or not
 * anything is due on them, then each later day that has work.
 *
 * `open` is every open task; those on or before today are not Upcoming's and are
 * left to `todayRows`, which is where overdue work lives.
 */
export function groupByDay(
  open: readonly Task[],
  index: TaskIndex,
  { today, dayOf }: DayContext,
): DayGroup[] {
  const days = new Set<string>();
  for (let step = 1; step <= LOOKAHEAD_DAYS; step++) days.add(shiftDay(today, step));
  for (const task of open) {
    const day = dayOf(task.due);
    if (day !== null && day > today) days.add(day);
  }

  return [...days]
    .sort()
    .map((day) => ({
      day,
      rows: arrangeSubtasks(tasksOnDay(open, { day, today, dayOf }), index),
    }));
}

/** Every row the groups hold, hidden ones included: what a count is the length of. */
export function countRows(groups: readonly DayGroup[]): number {
  return groups.reduce((total, group) => total + group.rows.length, 0);
}

/** The rows on the page, in the order they are drawn across all the days. */
export function onPageDays(groups: readonly DayGroup[]): Row[] {
  return groups.flatMap((group) => group.rows.filter((row) => !row.hidden));
}

/** The rows a row can be placed among: its siblings as they are drawn, folded ones left out. */
function siblingsAsDrawn(rows: readonly Row[], moved: Row): Row[] {
  return rows.filter(
    (row) =>
      !row.hidden &&
      row.depth === moved.depth &&
      (moved.depth === 0 || row.task.parentId === moved.task.parentId),
  );
}

/**
 * Where a dragged row goes within its day, in terms `Operations.reorderInDay`
 * understands, or null when the drop means nothing.
 *
 * `rows` is one day's list as drawn. The rows that compete are the moved row's
 * siblings *as drawn*: the roots among the roots, and a subtask among the
 * subtasks of its own parent. That is not the same list `planReorder` uses, and
 * for a reason: there the siblings are the tasks that share a project, because
 * that is what an `order` key means; here a key means a place in a day, so any
 * task on the day is a neighbour, and the only restriction left is the one the
 * drawing imposes — a subtask is drawn beneath its parent whatever its key says,
 * so it can be placed only among its brothers, and a root among roots.
 *
 * Folded rows are stepped over, as in `planReorder`: the row lands where the
 * person put it on the screen.
 */
export function planDayReorder(
  rows: readonly Row[],
  movedId: string,
  targetId: string,
  side: Side,
): { afterId: string | null } | null {
  if (movedId === targetId) return null;
  const moved = rows.find((row) => row.task.id === movedId);
  if (moved === undefined || moved.hidden) return null;

  const siblings = siblingsAsDrawn(rows, moved);
  const target = siblings.findIndex((row) => row.task.id === targetId);
  if (target === -1) return null;

  const afterId = side === "after" ? siblings[target]!.task.id : (siblings[target - 1]?.task.id ?? null);
  if (afterId === movedId) return null;
  const movedAt = siblings.findIndex((row) => row.task.id === movedId);
  if (afterId === (siblings[movedAt - 1]?.task.id ?? null)) return null;
  return { afterId };
}

/** The sibling beside a row, for the ↑/↓ buttons, or null at the edge of its list. */
export function siblingBeside(rows: readonly Row[], movedId: string, direction: -1 | 1): string | null {
  const moved = rows.find((row) => row.task.id === movedId);
  if (moved === undefined) return null;
  const siblings = siblingsAsDrawn(rows, moved);
  const at = siblings.findIndex((row) => row.task.id === movedId);
  return siblings[at + direction]?.task.id ?? null;
}

/**
 * A day's heading: "Tomorrow", or the weekday and date.
 *
 * Read as a plain calendar date in UTC — it has no time in it, so the reader's
 * zone has nothing to add, and `new Date("2026-11-20")` read as local time would
 * be the day before for anyone west of Greenwich.
 */
export function dayLabel(day: string, today: string): { name: string; date: string } {
  const date = new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  if (day === shiftDay(today, 1)) return { name: "Tomorrow", date };
  return { name: date, date: "" };
}
