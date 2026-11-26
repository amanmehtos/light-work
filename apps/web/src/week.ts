/**
 * The arithmetic Light Week, the week view, needs — kept apart from the
 * component so it can be tested without a DOM.
 *
 * Three things live here: which seven days are on the page, which tasks go on
 * each (and where), and how blocks share a day's width while one is being
 * dragged. The last is the one that makes dragging feel right: the overlap
 * sweep runs on the *preview* — the day as it would be if the block in hand
 * were let go now — so the neighbours make room while the block is still in
 * the air, not only after the drop.
 */

import type { Task } from "@light/core";
import { SNAP_MINUTES, blockMinutes, dueDay, dueMinutes, shiftDay, snap } from "./schedule.js";

/**
 * The first day of a week, as `Date.getDay` numbers it (0 = Sunday).
 *
 * Monday, because nothing in the account says otherwise — there is no
 * week-start preference yet — and Monday is the week `reschedule("next-week")`
 * already means, so "next week" and the next page of this view agree.
 */
export const WEEK_STARTS_ON = 1;

/** The first day of the week `day` is in. */
export function weekStart(day: string, startsOn: number = WEEK_STARTS_ON): string {
  // Read as a UTC calendar date: a bare day has no zone, and reading it as
  // local time would make it the day before for anyone west of Greenwich.
  const weekday = new Date(`${day.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return shiftDay(day, -((weekday - startsOn + 7) % 7));
}

/** The seven days from `start`. */
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_unused, step) => shiftDay(start, step));
}

/** One day's worth of the week: the strip at the top, and the hours. */
export interface DayTasks {
  /** On the day, at no particular time: the all-day strip, "Waiting". */
  waiting: Task[];
  /** On the day, at a time: blocks, earliest first. */
  timed: Task[];
}

/**
 * The week's open tasks, dealt into its days.
 *
 * Only what has a date is on a calendar. A task with no date is not waiting
 * for any of these days in particular, and putting the whole undated backlog
 * at the top of every day buried the days under it — that backlog is the
 * inbox's and the projects', not the week's.
 */
export function bucketWeek(tasks: readonly Task[], days: readonly string[]): Map<string, DayTasks> {
  const byDay = new Map<string, DayTasks>(days.map((day) => [day, { waiting: [], timed: [] }]));
  for (const task of tasks) {
    if (task.isCompleted) continue;
    const bucket = byDay.get(dueDay(task.due) ?? "");
    if (bucket === undefined) continue;
    if (dueMinutes(task.due) === null) bucket.waiting.push(task);
    else bucket.timed.push(task);
  }
  for (const bucket of byDay.values()) {
    bucket.timed.sort((a, b) => (dueMinutes(a.due) ?? 0) - (dueMinutes(b.due) ?? 0));
  }
  return byDay;
}

/** A block on a day, in minutes past midnight. */
export interface Span {
  id: string;
  start: number;
  end: number;
}

export function spanOf(task: Task): Span {
  const start = dueMinutes(task.due) ?? 0;
  return { id: task.id, start, end: start + blockMinutes(task.duration) };
}

/**
 * Where a block in hand would go if it were let go now: a time on a day, a
 * day's all-day strip, or nowhere (outside the week, which puts it back).
 */
export type Landing =
  | { kind: "slot"; day: string; minutes: number }
  | { kind: "strip"; day: string }
  | null;

/**
 * The start a pointer means, snapped to the quarter hour.
 *
 * `grab` is how far below the block's top it was taken hold of, so the block
 * keeps its place under the pointer instead of jumping its top to it: drag a
 * one-hour block by its middle and it is the middle that follows.
 */
export function slotAt(pointerMinutes: number, grab: number, length: number): number {
  // Clamped so the whole block stays inside the day, not only its top.
  const latest = Math.floor((24 * 60 - Math.max(length, SNAP_MINUTES)) / SNAP_MINUTES) * SNAP_MINUTES;
  return Math.min(snap(pointerMinutes - grab), latest);
}

/**
 * One day's blocks as they would be with the block in hand put down.
 *
 * The block in hand leaves whatever day it was on, and if the landing is a
 * time on *this* day it is here instead, at that time. With no landing the
 * day is as it is: a block carried out of the week has not left yet.
 */
export function previewDay(
  spans: readonly Span[],
  day: string,
  moving: { id: string; length: number } | null,
  landing: Landing,
): Span[] {
  if (moving === null || landing === null) return [...spans];
  const rest = spans.filter((span) => span.id !== moving.id);
  if (landing.kind === "slot" && landing.day === day) {
    rest.push({ id: moving.id, start: landing.minutes, end: landing.minutes + moving.length });
  }
  return rest;
}

/**
 * Overlap, resolved into columns.
 *
 * Two tasks at the same hour cannot both have the full width or one would be
 * invisible. Blocks are laid out left to right in the first column whose last
 * block has already finished — the standard calendar sweep — and every block
 * in a run of overlaps then shares the width of that run.
 */
export function layOut(blocks: readonly Span[]): Map<string, { column: number; columns: number }> {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const placed = new Map<string, { column: number; columns: number }>();

  let run: (Span & { column: number })[] = [];
  let runEnd = -1;

  const flush = (): void => {
    const columns = run.reduce((most, block) => Math.max(most, block.column + 1), 1);
    for (const block of run) placed.set(block.id, { column: block.column, columns });
    run = [];
    runEnd = -1;
  };

  for (const block of sorted) {
    // A block starting after everything so far has ended begins a new run, and
    // the previous run's width is settled.
    if (block.start >= runEnd) flush();

    const taken = new Set(run.filter((other) => other.end > block.start).map((o) => o.column));
    let column = 0;
    while (taken.has(column)) column += 1;

    run.push({ ...block, column });
    runEnd = Math.max(runEnd, block.end);
  }
  flush();

  return placed;
}

/** `Mon 23`, for a column's head. */
export function columnLabel(day: string): { weekday: string; date: string } {
  const when = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return {
    weekday: when.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }),
    date: String(when.getUTCDate()),
  };
}

/**
 * `Nov 23 – 29, 2026`, or `23–29 Nov 2026`: the week, said once.
 *
 * `formatRange` rather than two dates joined by hand, so the month and year
 * are not repeated inside one month and are where the reader's locale puts
 * them when the week crosses into the next.
 */
export function weekTitle(start: string): string {
  const format = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return format.formatRange(new Date(`${start}T00:00:00Z`), new Date(`${shiftDay(start, 6)}T00:00:00Z`));
}
