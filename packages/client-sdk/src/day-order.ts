/**
 * The order of a day's list, which is not the order of any project.
 *
 * Today and each day of Upcoming mix tasks from every project, and a person
 * arranges them differently from how they are filed: "this one first thing" is a
 * fact about the day, not about the project it belongs to. Todoist keeps the two
 * apart with a second number on the task (`day_order`), and `Task.dayOrder` is
 * that. Rearranging a day writes it and nothing else — a project's `order` is not
 * touched, so the project's own list reads the same afterwards.
 *
 * **The rule for what a task sorts by**: `dayOrder` when it has one, `order`
 * otherwise, ties broken by id. Both are fractional-index strings from the same
 * alphabet, so they compare with each other; that they mean different things
 * across projects is true of `order` already, and the Today list has always been
 * sorted by it. Two alternatives were rejected:
 *
 * - *Tasks with a `dayOrder` first, the rest after.* A first reorder would then
 *   write one key and send that task to the top whichever row it was dropped on.
 * - *Writing a `dayOrder` to every task on the day at the first reorder.* Right
 *   answer, wrong cost: it makes every first drag a many-task write that two
 *   devices would then fight over.
 *
 * Mixing the two means a fresh list sorts as it always did, and one drop writes
 * one key, minted between the neighbours' keys as they are sorted. The ties are
 * the exception, and they are common rather than rare: every project's first task
 * has the same `order`, so a Today list drawn from five projects starts with a run
 * of equal keys that no key can be minted between. `placeInDay` rewrites exactly
 * that run, and only that run.
 *
 * The tie-break by id is what makes the list the same on every device. Without it
 * equal keys sorted in whatever order the store happened to hold them.
 */

import { compareOrder, keyBetween, keysBetween, type Due, type Task } from "@light/core";

/** What a task sorts by in a day's list. */
export function dayKey(task: Pick<Task, "dayOrder" | "order">): string {
  return task.dayOrder ?? task.order;
}

export function compareForDay(a: Pick<Task, "id" | "dayOrder" | "order">, b: typeof a): number {
  return compareOrder(dayKey(a), dayKey(b)) || compareOrder(a.id, b.id);
}

/**
 * The day a due falls on. This default reads the date off the front of the
 * string, which is right for an all-day task and for an agent that has no zone;
 * a caller that has one (the browser, which has the machine's) passes its own.
 */
function sliceDay(due: Due | null): string | null {
  return due === null ? null : due.date.slice(0, 10);
}

export interface DayScope {
  /** The day the list is for, `YYYY-MM-DD`. */
  day: string;
  /** The caller's local today. Only decides whether overdue work belongs. */
  today: string;
  /** The calendar day of a due, in the caller's zone. */
  dayOf?: (due: Due | null) => string | null;
}

/**
 * Whether an open task is on this day's list.
 *
 * Today's list also holds everything overdue, because that is what Today means
 * everywhere it is drawn: a task that slipped is still something to do today. No
 * other day gathers the days before it.
 */
export function onDayList(task: Task, scope: DayScope): boolean {
  if (task.isCompleted) return false;
  const day = (scope.dayOf ?? sliceDay)(task.due);
  if (day === null) return false;
  return scope.day === scope.today ? day <= scope.day : day === scope.day;
}

/** The day's list, in the order it is drawn. */
export function tasksOnDay(tasks: readonly Task[], scope: DayScope): Task[] {
  return tasks.filter((task) => onDayList(task, scope)).sort(compareForDay);
}

/**
 * What to write to put `movedId` directly after `afterId` (or first, for null) in
 * a day's list.
 *
 * `list` is the day's list as `tasksOnDay` returns it. The result is the
 * `dayOrder` to give each task named: one task in the usual case, and the whole
 * run of equal keys around the drop when the neighbours cannot have a key
 * between them. Never an `order`.
 */
export function placeInDay(
  list: readonly Task[],
  movedId: string,
  afterId: string | null,
): { id: string; dayOrder: string }[] {
  const others = list.filter((task) => task.id !== movedId);
  let at = 0;
  if (afterId !== null) {
    const index = others.findIndex((task) => task.id === afterId);
    if (index === -1) throw new Error(`${afterId} is not on the same day list as ${movedId}`);
    at = index + 1;
  }

  const before = others[at - 1];
  const after = others[at];
  const lower = before === undefined ? null : dayKey(before);
  const upper = after === undefined ? null : dayKey(after);
  if (lower === null || upper === null || lower < upper) {
    return [{ id: movedId, dayOrder: keyBetween(lower, upper) }];
  }

  // Equal keys on both sides of the drop. The run is every neighbour with that
  // same key; it is re-keyed, in the order it is meant to read, between the keys
  // just outside it — which are strictly either side, or the ends of the list.
  let start = at - 1;
  while (start > 0 && dayKey(others[start - 1]!) === lower) start -= 1;
  let end = at;
  while (end < others.length - 1 && dayKey(others[end + 1]!) === lower) end += 1;

  const run = others.slice(start, end + 1).map((task) => task.id);
  run.splice(at - start, 0, movedId);
  const floor = start === 0 ? null : dayKey(others[start - 1]!);
  const ceiling = end === others.length - 1 ? null : dayKey(others[end + 1]!);
  const keys = keysBetween(floor, ceiling, run.length);
  return run.map((id, index) => ({ id, dayOrder: keys[index]! }));
}
