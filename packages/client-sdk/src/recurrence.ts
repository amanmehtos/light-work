/**
 * Recurrence.
 *
 * Todoist stores a recurring schedule as the phrase the user typed, which means
 * completing a task has to re-read that phrase to find the next occurrence. This
 * implements the common subset of that language and is explicit about the rest:
 * an unrecognised phrase returns `null` rather than a guess, and the caller
 * completes the task normally and says it could not reschedule. Silently
 * inventing a next date would be worse than admitting the gap.
 *
 * Supported:
 *   every day · daily · every N days
 *   every week · weekly · every N weeks
 *   every monday · every mon, wed · every weekday · every weekend
 *   every month · monthly · every N months · every Nth (day of month)
 *   every year · yearly · every N years
 *   every! ...   (Todoist's "from the completion date" variant)
 *
 * An all-day task is a plain calendar day and stays one. A timed task is a UTC
 * instant, and the day it falls on is worked out where the person is standing,
 * not in UTC — nine in the morning is the evening before in UTC once you are
 * east of about UTC+9, and advancing from that day skips one. The wall-clock
 * time is preserved rather than the instant, so a 9am task is still 9am on the
 * other side of a daylight-saving change.
 */

import { clockAt, instantAt } from "./wallclock.js";

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export interface Recurrence {
  /** Days, weeks, months or years between occurrences. */
  unit: "day" | "week" | "month" | "year";
  interval: number;
  /** For weekday schedules: the days of the week it lands on, 0 = Sunday. */
  weekdays: number[];
  /** For monthly schedules pinned to a date, e.g. "every 15th". */
  dayOfMonth: number | null;
  /**
   * True for Todoist's `every!` form, where the next occurrence is measured from
   * when the task was completed rather than from when it was due. The
   * difference shows up on an overdue task: `every day` catches up, `every! day`
   * starts again from today.
   */
  fromCompletion: boolean;
}

export function parseRecurrence(text: string | null | undefined): Recurrence | null {
  if (text === null || text === undefined) return null;

  let phrase = text.trim().toLowerCase();
  // Strip a time clause; the time comes from the due date, not the phrase.
  phrase = phrase.replace(/\s+at\s+.*$/, "").trim();
  // Strip a start clause, which affects the first occurrence, not the interval.
  phrase = phrase.replace(/\s+(starting|from)\s+.*$/, "").trim();

  const fromCompletion = /^every!/.test(phrase);
  phrase = phrase.replace(/^every!\s*/, "").replace(/^every\s*/, "").trim();

  const base = (unit: Recurrence["unit"], interval: number): Recurrence => ({
    unit,
    interval,
    weekdays: [],
    dayOfMonth: null,
    fromCompletion,
  });

  // Bare shorthands.
  if (phrase === "" || phrase === "day") return base("day", 1);
  if (text.trim().toLowerCase() === "daily") return base("day", 1);
  if (phrase === "week") return base("week", 1);
  if (text.trim().toLowerCase() === "weekly") return base("week", 1);
  if (phrase === "month") return base("month", 1);
  if (text.trim().toLowerCase() === "monthly") return base("month", 1);
  if (phrase === "year") return base("year", 1);
  if (text.trim().toLowerCase() === "yearly" || text.trim().toLowerCase() === "annually") {
    return base("year", 1);
  }

  if (phrase === "weekday" || phrase === "weekdays") {
    return { ...base("week", 1), weekdays: [1, 2, 3, 4, 5] };
  }
  if (phrase === "weekend" || phrase === "weekends") {
    return { ...base("week", 1), weekdays: [0, 6] };
  }

  // "N days" / "other day" and friends.
  const interval = /^(\d+|other)\s+(day|week|month|year)s?$/.exec(phrase);
  if (interval !== null) {
    const count = interval[1] === "other" ? 2 : Number(interval[1]);
    if (count >= 1) return base(interval[2] as Recurrence["unit"], count);
  }

  // "15th" / "1st" — a monthly schedule pinned to a day of the month.
  const monthDay = /^(\d{1,2})(st|nd|rd|th)$/.exec(phrase);
  if (monthDay !== null) {
    const day = Number(monthDay[1]);
    if (day >= 1 && day <= 31) return { ...base("month", 1), dayOfMonth: day };
  }

  // One or more weekday names.
  const parts = phrase.split(/\s*(?:,|and)\s*/).filter((part) => part !== "");
  if (parts.length > 0 && parts.every((part) => part in WEEKDAYS)) {
    const weekdays = [...new Set(parts.map((part) => WEEKDAYS[part]!))].sort((a, b) => a - b);
    return { ...base("week", 1), weekdays };
  }

  return null;
}

/** Splits an ISO date or datetime into its calendar day and the rest. */
function splitDate(iso: string): { day: string; time: string } {
  const index = iso.indexOf("T");
  return index === -1 ? { day: iso, time: "" } : { day: iso.slice(0, index), time: iso.slice(index) };
}

/**
 * The day a due value falls on, where the person is standing.
 *
 * An all-day due is already a calendar day. A timed one is a UTC instant, and
 * the ten characters at the front of it are the UTC day — which is not the
 * same day east of about UTC+9, where nine in the morning is the evening
 * before in UTC. Advancing from that wrong day is how "every weekday 9am"
 * skipped a day each time it was completed: Friday's instant read as
 * Thursday, so the next weekday came out Friday again rather than Monday.
 */
function dueParts(iso: string, zone?: string): { day: string; minutes: number | null } {
  if (!iso.includes("T")) return { day: iso.slice(0, 10), minutes: null };
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return { day: iso.slice(0, 10), minutes: null };

  const day = new Intl.DateTimeFormat("en-CA", {
    ...(zone === undefined ? {} : { timeZone: zone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
  const [hours, mins] = clockAt(when, zone).split(":").map(Number);
  return { day, minutes: (hours ?? 0) * 60 + (mins ?? 0) };
}

/**
 * The next due value: a bare day when the task is all-day, and the same
 * wall-clock time on the new day when it is not.
 *
 * Rebuilt rather than re-attached. Carrying the original `T…Z` across would
 * keep the instant and so drift the clock face whenever the offset changed —
 * a 9am task becoming 10am across a daylight-saving boundary. `instantAt`
 * returns null for a wall-clock time that does not exist on that day (the
 * spring-forward gap), and the old behaviour is the honest fallback there.
 */
function rebuild(day: string, minutes: number | null, zone: string | undefined, original: string): string {
  if (minutes === null) return day;
  const instant = instantAt(day, minutes, zone);
  if (instant !== null) return instant;
  const index = original.indexOf("T");
  return index === -1 ? day : day + original.slice(index);
}

function toUtc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Advances a month without rolling over.
 *
 * Adding a month to 31 January must give 28 or 29 February, not 2 or 3 March,
 * which is what naive date arithmetic produces.
 */
function addMonths(date: Date, months: number, pinnedDay: number | null): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const wanted = pinnedDay ?? date.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(wanted, lastOfTarget)));
}

/**
 * The next occurrence after `currentDue`.
 *
 * `completedOn` is used for the `every!` form and as the floor for a catch-up:
 * completing a daily task that is a week overdue should land on tomorrow, not
 * on a date still in the past.
 */
export function nextOccurrence(
  recurrence: Recurrence,
  currentDue: string,
  completedOn: string = new Date().toISOString().slice(0, 10),
  /** Defaults to wherever this is running, which for a client is the user. */
  zone?: string,
): string {
  const { day, minutes } = dueParts(currentDue, zone);
  const today = splitDate(completedOn).day;

  if (recurrence.weekdays.length > 0) {
    // Step forward to the next listed weekday strictly after the anchor.
    const anchorDay = recurrence.fromCompletion ? today : day > today ? day : today;
    const anchor = toUtc(anchorDay);
    for (let step = 1; step <= 7 * Math.max(recurrence.interval, 1) + 7; step++) {
      const candidate = new Date(anchor.getTime() + step * 86_400_000);
      if (recurrence.weekdays.includes(candidate.getUTCDay())) {
        return rebuild(fromUtc(candidate), minutes, zone, currentDue);
      }
    }
    return rebuild(fromUtc(new Date(anchor.getTime() + 7 * 86_400_000)), minutes, zone, currentDue);
  }

  const start = toUtc(recurrence.fromCompletion ? today : day);

  const step = (from: Date): Date => {
    switch (recurrence.unit) {
      case "day":
        return new Date(from.getTime() + recurrence.interval * 86_400_000);
      case "week":
        return new Date(from.getTime() + recurrence.interval * 7 * 86_400_000);
      case "month":
        return addMonths(from, recurrence.interval, recurrence.dayOfMonth);
      case "year":
        return addMonths(from, recurrence.interval * 12, recurrence.dayOfMonth);
    }
  };

  let next = step(start);
  if (!recurrence.fromCompletion) {
    // Catch up past any missed occurrences, so an overdue task lands in the
    // future rather than on another date already gone.
    let guard = 0;
    while (fromUtc(next) <= today && guard < 1000) {
      next = step(next);
      guard += 1;
    }
  }
  return rebuild(fromUtc(next), minutes, zone, currentDue);
}
