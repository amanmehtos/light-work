/**
 * The arithmetic the day view needs.
 *
 * A `Due` carries either a calendar day (`2026-11-03`) or a full instant
 * (`2026-11-03T09:30:00.000Z`), and which one it is comes from `hasTime`, not
 * from the string's shape. That difference is easy to get wrong by eye: the
 * instant is UTC, so slicing ten characters off it gives the wrong day for
 * anyone east of Greenwich in the morning or west of it in the evening. Every
 * conversion between the two lives here, and is tested, rather than being
 * spelled out again at each call site.
 *
 * "Day" throughout means the user's local calendar day, because that is what
 * Today and a day view have to mean to the person reading them.
 */

import type { Due } from "@light/core";

/** Minutes past midnight that a slot can start on: a quarter of an hour. */
export const SNAP_MINUTES = 15;

/** The local calendar day of a date, as `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  // en-CA formats as YYYY-MM-DD, and does it in the local zone — which is the
  // whole point, and is why this is not `toISOString().slice(0, 10)`.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Which day a task sits on, or null if it is not scheduled at all. */
export function dueDay(due: Due | null): string | null {
  if (due === null) return null;
  if (!due.hasTime) return due.date.slice(0, 10);
  const when = new Date(due.date);
  return Number.isNaN(when.getTime()) ? due.date.slice(0, 10) : localDay(when);
}

/** Minutes past local midnight, or null when the task is all-day. */
export function dueMinutes(due: Due | null): number | null {
  if (due === null || !due.hasTime) return null;
  const when = new Date(due.date);
  if (Number.isNaN(when.getTime())) return null;
  return when.getHours() * 60 + when.getMinutes();
}

/** Nearest quarter hour, clamped into the day. */
export function snap(minutes: number, step: number = SNAP_MINUTES): number {
  const rounded = Math.round(minutes / step) * step;
  return Math.max(0, Math.min(24 * 60 - step, rounded));
}

/** Breaks `YYYY-MM-DD` into numbers, so a Date can be built in local time. */
function parseDay(day: string): [number, number, number] {
  const [year, month, date] = day.slice(0, 10).split("-").map(Number);
  return [year ?? 1970, month ?? 1, date ?? 1];
}

/**
 * The same task, now at a time on a day.
 *
 * Built with the local-time Date constructor rather than by string-joining a
 * `Z` on the end, so dropping a task at 09:00 means nine in the morning where
 * the person dropping it is standing.
 */
export function atTime(day: string, minutes: number, from: Due | null = null): Due {
  const [year, month, date] = parseDay(day);
  const when = new Date(year, month - 1, date, 0, minutes, 0, 0);
  return {
    date: when.toISOString(),
    hasTime: true,
    text: from?.text ?? null,
    timezone: from?.timezone ?? null,
    isRecurring: from?.isRecurring ?? false,
  };
}

/** The same task, on a day but at no particular time. */
export function atDay(day: string, from: Due | null = null): Due {
  return {
    date: day.slice(0, 10),
    hasTime: false,
    text: from?.text ?? null,
    timezone: from?.timezone ?? null,
    isRecurring: from?.isRecurring ?? false,
  };
}

/** `09:30`, for a label. Minutes past midnight in, clock face out. */
export function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = Math.floor(minutes % 60);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The day `offset` days from `day`, counted on the calendar. */
export function shiftDay(day: string, offset: number): string {
  const [year, month, date] = parseDay(day);
  return localDay(new Date(year, month - 1, date + offset));
}

/**
 * How long a block should be, in minutes.
 *
 * A task with no estimate still has to be big enough to grab, and one
 * estimated in days is a body of work rather than a sitting — showing it as an
 * eight-hour block would bury the day under one task.
 */
export function blockMinutes(duration: { amount: number; unit: string } | null): number {
  if (duration === null || duration.unit !== "minute") return 30;
  return Math.max(SNAP_MINUTES, duration.amount);
}
