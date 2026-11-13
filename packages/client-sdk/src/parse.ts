/**
 * Quick Add: reading a task out of a line of text.
 *
 * One parser, used by the web app's add-task field and by the agent's
 * `create_task_from_text` tool, so the two cannot disagree about what
 * "tomorrow 9am p1" means. It recognises the shorthand people already have in
 * their fingers from Todoist — `#Project`, `@label`, `p1`..`p4`, `// notes`,
 * dates, times and "every ..." phrases — and it hands recurrence phrases to
 * `parseRecurrence` rather than reimplementing them.
 *
 * Why this file exists at all, given that the add-task line used to refuse
 * dates on purpose ("guessing wrong about a date is worse than one extra
 * tab"): that position was right about the risk and wrong about the remedy.
 * The remedy is not to never read a date, it is to never *guess* one. Three
 * rules follow, and the tests in `parse.test.ts` are the contract for each.
 *
 *   1. It reports where it read each thing. Every token carries the offsets of
 *      the text it came from, so a UI can show "I took this" and let the person
 *      take it back, and a failure can quote exactly what it could not read.
 *
 *   2. When it is not sure, it says nothing. Text it declines stays in the
 *      title, untouched, and is listed in `declined` with the reason. Silence
 *      beats a wrong date: a title that still says "next friday" is visibly
 *      un-parsed, where a task quietly filed under the wrong day is not.
 *
 *   3. Reading and trusting are separate. Some things can be read with a call
 *      that has to be made — "friday" said on a Friday, "jan 5" in November, a
 *      time with no day. Those come back as tokens with `assumed` set, which a
 *      text field draws as a chip you can dismiss. `parseQuickAddStrict` is for
 *      callers with no chip: it refuses both the declined and the assumed, and
 *      names each. The agent path uses that one.
 *
 * The line it draws is deliberately on the cautious side of Todoist's, which
 * reads "next friday", "by friday" and a date in the middle of a sentence.
 * Each of those is something a person means differently on different days, and
 * a parser has no way to ask. Where Todoist guesses, this declines.
 *
 * Everything is a plain calendar day (`YYYY-MM-DD`) and a plain wall-clock time
 * (`HH:MM`). Turning those into an instant needs a time zone, which a parser
 * of text has no business knowing; `Operations.createTaskFromText` does that.
 */

import type { Priority } from "@light/core";
import { nextOccurrence, parseRecurrence, type Recurrence } from "./recurrence.js";

/* ------------------------------------------------------------------ */
/* shapes                                                              */
/* ------------------------------------------------------------------ */

export interface ProjectRef {
  id: string;
  name: string;
}

export interface QuickAddOptions {
  /** The local calendar day, `YYYY-MM-DD`. Every relative date is read against it. */
  today: string;
  /**
   * The wall-clock time now, `HH:MM`, on `today`. Only used to keep a repeat
   * from starting in the past: "standup every weekday 9am" typed at 14:00 would
   * otherwise be due, and overdue, from the moment it was made. Without it
   * that case is simply not noticed.
   */
  now?: string;
  /**
   * The projects a `#Name` may refer to. A `#Name` that matches none is not a
   * project, so it is declined rather than claimed: `#123` and "#hashtag" are
   * things people put in titles.
   */
  projects?: readonly ProjectRef[];
  /**
   * Token text the person has taken back, matched without regard to case. A
   * dismissed chip goes here, which is what makes dismissing it put the text
   * back in the title instead of the parser reading it again next keystroke.
   */
  ignore?: readonly string[];
}

/** Where a piece of the source text sits. Offsets are UTF-16 indexes into `source`. */
export interface Span {
  start: number;
  end: number;
  /** Exactly `source.slice(start, end)`, kept so a consumer need not slice. */
  text: string;
}

export type QuickAddToken = Span & {
  /**
   * Present when the parser had to make a call to read this, and says which.
   * A token without it was read from words that mean one thing.
   */
  assumed?: string;
} & (
    | { kind: "project"; projectId: string; name: string }
    | { kind: "label"; name: string }
    | { kind: "priority"; priority: Priority }
    | { kind: "description"; description: string }
    | { kind: "date"; date: string }
    | { kind: "time"; time: string }
    | { kind: "recurrence"; rule: Recurrence; date: string }
  );

/** Text that looked like shorthand and was not read. It is still in the title. */
export interface Declined extends Span {
  reason: string;
}

export interface QuickAddSchedule {
  /** `YYYY-MM-DD`. For a repeat, the first day it falls on. */
  date: string;
  /** `HH:MM` wall-clock, or null for all-day. */
  time: string | null;
  recurrence: { text: string; rule: Recurrence } | null;
  /** Every assumption behind this schedule; empty when there were none. */
  assumed: string[];
}

export interface QuickAddParse {
  source: string;
  /** The source with every claimed token cut out and the whitespace tidied. */
  title: string;
  tokens: QuickAddToken[];
  declined: Declined[];

  priority: Priority | null;
  /** Names as typed, once each. */
  labels: string[];
  projectId: string | null;
  description: string;
  schedule: QuickAddSchedule | null;
}

/** A line the strict parser would not accept, and why. */
export interface Problem extends Span {
  why: string;
}

export type StrictResult =
  | { ok: true; parse: QuickAddParse }
  | { ok: false; problems: Problem[]; message: string };

/* ------------------------------------------------------------------ */
/* calendar arithmetic, on `YYYY-MM-DD` strings                        */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function utc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  return format(new Date(utc(day).getTime() + delta * DAY_MS));
}

/** 0 = Sunday, as `Date` and `Recurrence.weekdays` have it. */
function weekdayOf(day: string): number {
  return utc(day).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** The day as `YYYY-MM-DD`, or null if there is no such day (30 February). */
function realDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Weekday words, and which day each is.
 *
 * Full names, plus the abbreviations that are not also English: "wed", "sat"
 * and "sun" are left out, because "sat on the fence" and "sun cream" are far
 * likelier than a Wednesday, Saturday or Sunday said in shorthand, and the
 * cost of wrongly reading one is a task filed on the wrong day. They remain
 * readable after "every", where nothing else they could mean fits.
 */
const WEEKDAY_WORDS: Record<string, number> = {
  sunday: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6,
};

/** Months by name. `ambiguous` ones are also words, and must be written with an ordinal. */
const MONTH_WORDS: Record<string, { month: number; ambiguous: boolean }> = {
  jan: { month: 1, ambiguous: false }, january: { month: 1, ambiguous: false },
  feb: { month: 2, ambiguous: false }, february: { month: 2, ambiguous: false },
  mar: { month: 3, ambiguous: false }, march: { month: 3, ambiguous: true },
  apr: { month: 4, ambiguous: false }, april: { month: 4, ambiguous: false },
  may: { month: 5, ambiguous: true },
  jun: { month: 6, ambiguous: false }, june: { month: 6, ambiguous: false },
  jul: { month: 7, ambiguous: false }, july: { month: 7, ambiguous: false },
  aug: { month: 8, ambiguous: false }, august: { month: 8, ambiguous: false },
  sep: { month: 9, ambiguous: false }, sept: { month: 9, ambiguous: false },
  september: { month: 9, ambiguous: false },
  oct: { month: 10, ambiguous: false }, october: { month: 10, ambiguous: false },
  nov: { month: 11, ambiguous: false }, november: { month: 11, ambiguous: false },
  dec: { month: 12, ambiguous: false }, december: { month: 12, ambiguous: false },
};

/** "Friday 2026-11-13", for an assumption that has to say which day it chose. */
function dayWithName(day: string): string {
  const name = WEEKDAY_NAMES[weekdayOf(day)]!;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${day}`;
}

/* ------------------------------------------------------------------ */
/* words                                                               */
/* ------------------------------------------------------------------ */

interface Word {
  text: string;
  lower: string;
  start: number;
  end: number;
}

function wordsOf(text: string): Word[] {
  const words: Word[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    words.push({
      text: match[0],
      lower: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return words;
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/** Words that, stuck to a date, say which part of the day rather than which day. */
const PART_OF_DAY = new Set(["morning", "afternoon", "evening", "night", "noon", "midnight", "am", "pm"]);

/**
 * Words that, in front of a date, change what it is a date *for*.
 *
 * "by friday" is a deadline and not a due date; "next friday" is two different
 * days depending on who says it and when; "last friday" is gone. A parser that
 * dropped the modifier and kept the weekday would be reading a different
 * sentence from the one typed.
 */
const MODIFIERS: Record<string, string> = {
  next: "'next' before a day is read two ways — the coming one, or the one after it",
  this: "'this' before a day is read two ways — the coming one, or the one in the current week",
  last: "'last' before a day points at one that has gone",
  by: "'by' names a deadline, which is not the same thing as the day you plan to do it",
  before: "'before' names a deadline, which is not the same thing as the day you plan to do it",
  until: "'until' names a deadline, which is not the same thing as the day you plan to do it",
  till: "'till' names a deadline, which is not the same thing as the day you plan to do it",
  due: "'due' names a deadline, which is not the same thing as the day you plan to do it",
  after: "'after' names a boundary, not a day",
  since: "'since' names a boundary, not a day",
  from: "'from' names a boundary, not a day",
};

/* ------------------------------------------------------------------ */
/* candidates                                                          */
/* ------------------------------------------------------------------ */

type Group = "schedule" | "time" | "priority" | "project" | "label" | "description";

/**
 * A reading of some words, before it has been checked against its neighbours.
 *
 * Reading and deciding are separate passes. Whether "tomorrow" is a date
 * depends on what else is on the line — a second date, a word either side of
 * it — and none of that is known at the word. So the scan proposes, and the
 * rules below it decide.
 */
interface Candidate {
  from: number;
  to: number;
  group: Group;
  /** Set when this should not be claimed; the text stays in the title. */
  decline?: string;
  /** Dropped without comment (instead of declined) when words follow it. */
  silentUnlessLast?: boolean;
  /** A repeat phrase must be last, because its end is only knowable that way. */
  mustBeLast?: boolean;
  make?: (span: Span) => QuickAddToken;
}

/** What a matcher reports: how many words it used, and either a reading or a refusal. */
type Match = { to: number; decline: string } | { to: number; make: (span: Span) => QuickAddToken };

/* ------------------------------------------------------------------ */
/* the parser                                                          */
/* ------------------------------------------------------------------ */

export function parseQuickAdd(source: string, options: QuickAddOptions): QuickAddParse {
  if (!DAY_PATTERN.test(options.today)) {
    throw new Error(`parseQuickAdd needs today as YYYY-MM-DD, not "${options.today}"`);
  }
  const today = options.today;
  const projects = options.projects ?? [];
  const ignored = new Set((options.ignore ?? []).map((text) => text.toLowerCase()));

  /* ---- the description is cut off first and nothing inside it is read ---- */

  // `//` must start a word. Otherwise "https://example.com" would split a link
  // out of the title and call the rest of the address a note.
  let head = source;
  let description: QuickAddToken | null = null;
  const marker = /(?:^|\s)\/\//.exec(source);
  if (marker !== null) {
    const start = source.indexOf("//", marker.index);
    const body = source.slice(start + 2).trim();
    const end = source.trimEnd().length;
    const span = { start, end, text: source.slice(start, end) };
    if (body !== "" && !ignored.has(span.text.toLowerCase())) {
      description = { ...span, kind: "description", description: body };
      head = source.slice(0, start);
    }
  }

  const words = wordsOf(head);
  const candidates: Candidate[] = [];

  /* ---- matchers ---- */

  const word = (index: number): Word | undefined => words[index];

  function matchPriority(index: number): Match | null {
    const found = /^p([1-4])$/i.exec(word(index)!.text);
    if (found === null) return null;
    const priority = Number(found[1]) as Priority;
    return { to: index + 1, make: (span) => ({ ...span, kind: "priority", priority }) };
  }

  function matchLabel(index: number): Match | null {
    const found = /^@([\p{L}\p{N}_-]+)$/u.exec(word(index)!.text);
    if (found === null) return null;
    const name = found[1]!;
    return { to: index + 1, make: (span) => ({ ...span, kind: "label", name }) };
  }

  /** A project name as a word can spell it: spaces, hyphens and underscores are one thing. */
  const projectKey = (name: string) => name.toLowerCase().replace(/[\s_-]+/g, "-");

  function matchProject(index: number): Match | null {
    const found = /^#(\p{L}[\p{L}\p{N}_-]*)$/u.exec(word(index)!.text);
    if (found === null) return null;
    const wanted = projectKey(found[1]!);
    const hits = projects.filter((project) => projectKey(project.name) === wanted);
    if (hits.length === 0) {
      return { to: index + 1, decline: `no project is named "${found[1]}"` };
    }
    if (hits.length > 1) {
      return { to: index + 1, decline: `more than one project is named "${found[1]}", and it could be either` };
    }
    const hit = hits[0]!;
    return {
      to: index + 1,
      make: (span) => ({ ...span, kind: "project", projectId: hit.id, name: hit.name }),
    };
  }

  /* -- dates -- */

  function dateToken(date: string, assumed?: string) {
    return (span: Span): QuickAddToken => ({
      ...span,
      kind: "date",
      date,
      ...(assumed === undefined ? {} : { assumed }),
    });
  }

  /** A day someone named outright, checked for being a real day that is still ahead. */
  function explicitDay(year: number, month: number, day: number, to: number): Match {
    const found = realDay(year, month, day);
    if (found === null) return { to, decline: "there is no such date" };
    if (found < today) return { to, decline: `${found} is in the past` };
    return { to, make: dateToken(found) };
  }

  function matchRelative(index: number): Match | null {
    const [first, count, unit] = [word(index), word(index + 1), word(index + 2)];
    if (first === undefined || first.lower !== "in" || count === undefined || unit === undefined) return null;
    if (!/^\d{1,3}$/.test(count.text)) return null;
    const amount = Number(count.text);

    const named = /^(day|days|week|weeks)$/.exec(unit.lower);
    if (named !== null) {
      const weeks = named[1]!.startsWith("week");
      if (amount < 1 || amount > (weeks ? 52 : 365)) {
        return { to: index + 3, decline: `${amount} ${unit.lower} is not a count it will read` };
      }
      return { to: index + 3, make: dateToken(addDays(today, weeks ? amount * 7 : amount)) };
    }
    if (/^(month|months|year|years|hour|hours|hr|hrs|minute|minutes|min|mins)$/.test(unit.lower)) {
      return { to: index + 3, decline: `"in ${count.text} ${unit.lower}" is not supported; give the day instead` };
    }
    return null;
  }

  function nextMonday(): string {
    const delta = (1 - weekdayOf(today) + 7) % 7 || 7;
    return addDays(today, delta);
  }

  function matchNextPeriod(index: number): Match | null {
    const first = word(index);
    const second = word(index + 1);
    if (first === undefined || second === undefined) return null;
    if (first.lower !== "next" && first.lower !== "this") return null;

    if (first.lower === "next" && second.lower === "week") {
      const monday = nextMonday();
      return {
        to: index + 2,
        make: dateToken(monday, `"next week" does not say which day; this reads it as ${dayWithName(monday)}`),
      };
    }
    if (/^(week|weekend|month|year)$/.test(second.lower)) {
      return {
        to: index + 2,
        decline: `"${first.lower} ${second.lower}" is not supported; give the day instead`,
      };
    }
    return null;
  }

  function matchMonthDay(index: number): Match | null {
    const first = word(index)!;
    const second = word(index + 1);
    if (second === undefined) return null;

    let month: { month: number; ambiguous: boolean } | undefined;
    let dayWord: Word;
    if (first.lower in MONTH_WORDS) {
      month = MONTH_WORDS[first.lower];
      dayWord = second;
    } else if (second.lower in MONTH_WORDS) {
      month = MONTH_WORDS[second.lower];
      dayWord = first;
    } else {
      return null;
    }

    const dayMatch = /^(\d{1,2})(st|nd|rd|th)?$/.exec(dayWord.lower);
    if (month === undefined || dayMatch === null) return null;
    const day = Number(dayMatch[1]);
    const ordinal = dayMatch[2] !== undefined;
    // 0 and 32+ are not days, and "dec 40" or "jan 2026" are far likelier to be
    // something else than a mistyped date.
    if (day < 1 || day > 31) return null;
    // "may 5 people attend", "march 3 miles": the month is also a word, so only
    // an ordinal makes it unambiguous.
    if (month.ambiguous && !ordinal) return null;

    let to = index + 2;
    // An explicit year may follow either order: "jan 5 2027", "5 jan 2027".
    const yearWord = word(to);
    const thisYear = Number(today.slice(0, 4));
    if (yearWord !== undefined && /^\d{4}$/.test(yearWord.text)) {
      to += 1;
      const year = Number(yearWord.text);
      if (year < thisYear) return { to, decline: `${yearWord.text} is in the past` };
      if (year > 2100) return { to, decline: `${yearWord.text} is not a year it will read` };
      return explicitDay(year, month.month, day, to);
    }

    const thisYears = realDay(thisYear, month.month, day);
    if (thisYears === null) {
      // 29 February in a year that has none, or 30 February in any.
      return { to, decline: `there is no such date in ${thisYear}` };
    }
    if (thisYears >= today) return { to, make: dateToken(thisYears) };

    const nextYears = realDay(thisYear + 1, month.month, day);
    if (nextYears === null) return { to, decline: `there is no such date in ${thisYear + 1}` };
    return {
      to,
      make: dateToken(
        nextYears,
        `${thisYears} has already gone by, so this reads it as next year, ${nextYears}`,
      ),
    };
  }

  function matchWritten(index: number): Match | null {
    const current = word(index)!;

    const iso = DAY_PATTERN.exec(current.text);
    if (iso !== null) return explicitDay(Number(iso[1]), Number(iso[2]), Number(iso[3]), index + 1);

    // `3/4/2026` is 3 April or 4 March depending on who typed it. Without a
    // year it is as likely a fraction ("1/2 cup"), so only the dated form is
    // recognised — in order to be refused.
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(current.text)) {
      return {
        to: index + 1,
        decline: "a day/month/year written with slashes could be day-first or month-first",
      };
    }
    return matchMonthDay(index);
  }

  function matchKeyword(index: number): Match | null {
    const current = word(index)!;
    const bare = current.lower.replace(TRAILING_PUNCTUATION, "");

    const isDateWord = (candidate: string) =>
      candidate === "today" || candidate === "tomorrow" || candidate === "tonight" || candidate in WEEKDAY_WORDS;
    if (bare !== current.lower && isDateWord(bare)) {
      return {
        to: index + 1,
        decline: `punctuation is stuck to "${bare}", so it was not read as a date`,
      };
    }

    if (bare === "today" || bare === "tonight") return { to: index + 1, make: dateToken(today) };
    if (bare === "tomorrow") return { to: index + 1, make: dateToken(addDays(today, 1)) };

    if (bare in WEEKDAY_WORDS) {
      const target = WEEKDAY_WORDS[bare]!;
      let delta = (target - weekdayOf(today) + 7) % 7;
      if (delta === 0) {
        const name = WEEKDAY_NAMES[target]!;
        return {
          to: index + 1,
          make: dateToken(
            addDays(today, 7),
            `today is ${name[0]!.toUpperCase()}${name.slice(1)}, so "${bare}" is read as the one a week away, not today`,
          ),
        };
      }
      return { to: index + 1, make: dateToken(addDays(today, delta)) };
    }
    return null;
  }

  /** A date, written any of the ways it is read. */
  function matchDate(index: number): Match | null {
    // Called with the word after a modifier or connector, which may not exist.
    if (word(index) === undefined) return null;
    const matched =
      matchNextPeriod(index) ?? matchRelative(index) ?? matchWritten(index) ?? matchKeyword(index);
    if (matched === null || "decline" in matched) return matched;

    // "friday morning", "tomorrow pm": the date is fine and the rest of the
    // phrase is a different thing, so reading just the date would drop half of
    // what was said. Declined whole, with the extra word.
    const after = word(matched.to);
    if (after !== undefined && PART_OF_DAY.has(after.lower)) {
      return {
        to: matched.to + 1,
        decline: `"${after.lower}" is a part of the day, or am or pm, and a day with a part of the day on it is not read`,
      };
    }
    return matched;
  }

  /* -- times -- */

  function timeToken(time: string, assumed?: string) {
    return (span: Span): QuickAddToken => ({
      ...span,
      kind: "time",
      time,
      ...(assumed === undefined ? {} : { assumed }),
    });
  }

  const NOT_A_TIME = "that is not a valid time";
  const AM_OR_PM =
    "without am or pm it could be morning or evening, or not a time at all (a ratio, a verse)";

  function matchTime(index: number): Match | null {
    if (word(index) === undefined) return null;
    const current = word(index)!;

    // `9am`, `9:30pm`
    const attached = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(current.lower);
    if (attached !== null) {
      return clock12(index + 1, Number(attached[1]), Number(attached[2] ?? 0), attached[3]!);
    }

    // `9 pm`, `9:30 pm`
    const next = word(index + 1);
    const spaced = /^(\d{1,2})(?::(\d{2}))?$/.exec(current.lower);
    if (spaced !== null && next !== undefined && (next.lower === "am" || next.lower === "pm")) {
      return clock12(index + 2, Number(spaced[1]), Number(spaced[2] ?? 0), next.lower);
    }

    // `17:30`. Only forms that cannot be read two ways: an hour past twelve, or
    // one with a leading zero. "10:30" is 10:30 to someone on a 24-hour clock
    // and probably 10:30 in the morning to everyone else, and that is a
    // difference worth refusing over.
    const bare = /^(\d{1,2}):(\d{2})$/.exec(current.text);
    if (bare !== null) {
      const hour = Number(bare[1]);
      const minute = Number(bare[2]);
      if (hour > 23 || minute > 59) return { to: index + 1, decline: NOT_A_TIME };
      if (hour >= 13 || bare[1]!.startsWith("0")) {
        return { to: index + 1, make: timeToken(`${pad(hour)}:${pad(minute)}`) };
      }
      return { to: index + 1, decline: AM_OR_PM };
    }
    return null;
  }

  function clock12(to: number, hour: number, minute: number, meridiem: string): Match {
    if (hour < 1 || hour > 12 || minute > 59) return { to, decline: NOT_A_TIME };
    const hours24 = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    return { to, make: timeToken(`${pad(hours24)}:${pad(minute)}`) };
  }

  /* -- repeats -- */

  /** Words that, after "every", are plainly the start of a repeat. */
  function looksRepeating(text: string): boolean {
    const bare = text.toLowerCase().replace(TRAILING_PUNCTUATION, "");
    return (
      /^(day|days|week|weeks|month|months|year|years|weekday|weekdays|weekend|weekends|other)$/.test(bare) ||
      /^\d+(st|nd|rd|th)?$/.test(bare) ||
      bare in WEEKDAY_WORDS ||
      ["wed", "wednesday", "sat", "sun"].includes(bare)
    );
  }

  /** Words that end a repeat phrase, since `parseRecurrence` reads them as clauses. */
  const REPEAT_STOPS = new Set(["at", "from", "starting", "until", "till", "for", "on", "by", "after", "before"]);

  function firstOccurrence(rule: Recurrence): { date: string; assumed?: string } {
    if (rule.weekdays.length > 0) {
      for (let step = 0; step < 7; step++) {
        const day = addDays(today, step);
        if (rule.weekdays.includes(weekdayOf(day))) return { date: day };
      }
    }
    if (rule.dayOfMonth !== null) {
      const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
      for (let offset = 0; offset < 2; offset++) {
        const index = month - 1 + offset;
        const y = year + Math.floor(index / 12);
        const m = (index % 12) + 1;
        const day = realDay(y, m, Math.min(rule.dayOfMonth, daysInMonth(y, m)));
        if (day !== null && day >= today) return { date: day };
      }
    }
    // "every day" and "every 3 days" start today. Weekly and longer without a
    // day to hang them on do too, but that is a choice, and says so.
    if (rule.unit === "day") return { date: today };
    return {
      date: today,
      assumed: `no day was given to anchor "every ${rule.interval === 1 ? "" : `${rule.interval} `}${rule.unit}${rule.interval === 1 ? "" : "s"}", so it starts today`,
    };
  }

  /** Refuses the run of repeat-looking words from `to` on, as one phrase. */
  function refuseRepeat(from: number): Match {
    let to = from;
    while (
      word(to) !== undefined &&
      (looksRepeating(word(to)!.text) || ["and", "or", "of", "the", "in"].includes(word(to)!.lower))
    ) {
      to += 1;
    }
    return { to, decline: "that is a repeat, and it is not one this can read" };
  }

  function matchRepeat(index: number): Match | null {
    const first = word(index)!;
    if (first.lower !== "every" && first.lower !== "every!") return null;

    for (let length = Math.min(7, words.length - index - 1); length >= 1; length--) {
      const phrase = words.slice(index + 1, index + 1 + length);
      if (phrase.some((item) => REPEAT_STOPS.has(item.lower))) continue;
      const text = [first, ...phrase].map((item) => item.text).join(" ");
      const rule = parseRecurrence(text);
      if (rule === null) continue;

      // The longest prefix that parses is not always the phrase: "every 3rd
      // thursday of the month" starts with "every 3rd", which is a perfectly
      // good monthly schedule, and reading just that would turn a different
      // sentence into a wrong one. When the next word is plainly more of a
      // repeat, the parse stopped short and the whole run is refused.
      const next = word(index + 1 + length);
      if (next !== undefined && (looksRepeating(next.text) || ["and", "or", "of", "the"].includes(next.lower))) {
        return refuseRepeat(index + 1 + length);
      }

      const start = firstOccurrence(rule);
      return {
        to: index + 1 + length,
        make: (span) => ({
          ...span,
          kind: "recurrence",
          rule,
          date: start.date,
          ...(start.assumed === undefined ? {} : { assumed: start.assumed }),
        }),
      };
    }

    // `parseRecurrence` could not read it, but it plainly was a repeat. Silence
    // here would be the worst outcome: an agent asking for a weekly task would
    // be handed an ordinary one with "every other tuesday" in its title.
    if (word(index + 1) === undefined || !looksRepeating(word(index + 1)!.text)) return null;
    return refuseRepeat(index + 1);
  }

  /* ---- the scan ---- */

  function modifierDecline(index: number): Match | null {
    const first = word(index)!;
    const reason = MODIFIERS[first.lower];
    if (reason === undefined) return null;
    const after = matchDate(index + 1);
    if (after === null) return null;
    return { to: after.to, decline: reason };
  }

  function connected(index: number, connector: string, matcher: (at: number) => Match | null): Match | null {
    const first = word(index)!;
    if (first.lower !== connector) return null;
    const found = matcher(index + 1);
    if (found === null) return null;
    // The connector is part of the phrase, and goes with it: "pay rent on
    // friday" should leave "pay rent", not "pay rent on".
    return found;
  }

  interface Found {
    match: Match;
    group: Group;
    /** Where the phrase starts, which is before the match when a connector went with it. */
    from: number;
    extra?: Partial<Candidate>;
  }

  /**
   * The first reading that fits at this word. The order is the order of
   * precedence: shorthand with a sigil cannot be anything else, a repeat is
   * tried before the dates inside it ("every monday" is not "monday"), and a
   * modifier is tried before the date it modifies so "next friday" is refused
   * whole and not read as "friday".
   */
  function readAt(at: number): Found | null {
    const here = word(at)!;
    const tries: [Match | null, Group, Partial<Candidate>?][] = [
      [matchPriority(at), "priority"],
      [matchLabel(at), "label"],
      [matchProject(at), "project"],
      [matchRepeat(at), "schedule", { mustBeLast: true }],
      [connected(at, "on", matchDate), "schedule"],
      [modifierDecline(at), "schedule"],
      [matchDate(at), "schedule"],
      [connected(at, "at", matchTime), "time"],
    ];
    for (const [match, group, extra] of tries) {
      if (match !== null) return { match, group, from: at, ...(extra === undefined ? {} : { extra }) };
    }

    // "at 5" with nothing after the 5. Read as a time it would be 5am or 5pm,
    // and there is no telling which; left alone it is a number in a sentence.
    // Only worth a refusal at the end of the line, where it reads as a time.
    const number = word(at + 1);
    if (here.lower === "at" && number !== undefined && /^\d{1,2}$/.test(number.text)) {
      return { match: { to: at + 2, decline: AM_OR_PM }, group: "time", from: at, extra: { silentUnlessLast: true } };
    }

    const time = matchTime(at);
    return time === null ? null : { match: time, group: "time", from: at };
  }

  let index = 0;
  while (index < words.length) {
    const found = readAt(index);
    if (found === null) {
      index += 1;
      continue;
    }

    const { match, group, from, extra } = found;
    const first = word(from)!;
    const last = word(match.to - 1)!;
    const text = head.slice(first.start, last.end);

    // A dismissed token is not a candidate at all: the person has said what it
    // is, and it is title text.
    if (!ignored.has(text.toLowerCase())) {
      const candidate: Candidate = { from, to: match.to, group, ...extra };
      if ("decline" in match) {
        candidate.decline = match.decline;
      } else {
        candidate.make = match.make;
      }
      candidates.push(candidate);
    }
    index = match.to;
  }

  /* ---- the rules that decide between candidates ---- */

  const spanOf = (candidate: Candidate): Span => {
    const first = word(candidate.from)!;
    const last = word(candidate.to - 1)!;
    return { start: first.start, end: last.end, text: head.slice(first.start, last.end) };
  };

  const live = (group: Group) => candidates.filter((c) => c.group === group && c.decline === undefined);

  // Two of anything that can only be one thing. Neither is more likely to be
  // the one meant, so neither is taken.
  const conflicts: [Group, string][] = [
    ["priority", "this line has more than one priority"],
    ["project", "this line names more than one project"],
    ["schedule", "this line gives two days, or a day and a repeat, and only one can be the schedule"],
    ["time", "this line gives two times"],
  ];
  for (const [group, reason] of conflicts) {
    const same = live(group);
    if (same.length > 1) for (const candidate of same) candidate.decline = reason;
  }

  // Plain words are the ones nothing claimed or declined, and where they sit
  // decides whether a day or a time is at the edge of the title (where it
  // reads as an addition to it) or in the middle (where it may be part of it).
  const covered = new Set<number>();
  for (const candidate of candidates) {
    for (let at = candidate.from; at < candidate.to; at++) covered.add(at);
  }
  const plainBefore = (candidate: Candidate) => {
    for (let at = 0; at < candidate.from; at++) if (!covered.has(at)) return true;
    return false;
  };
  const plainAfter = (candidate: Candidate) => {
    for (let at = candidate.to; at < words.length; at++) if (!covered.has(at)) return true;
    return false;
  };

  const dropped = new Set<Candidate>();
  for (const candidate of candidates) {
    if (candidate.decline !== undefined && candidate.silentUnlessLast !== true) continue;
    const trailing = !plainAfter(candidate);

    if (candidate.silentUnlessLast === true) {
      // "at 5" in the middle of "arrive at 5 stations" is a number in a
      // sentence; only at the end does it read as a time somebody meant.
      if (!trailing) dropped.add(candidate);
      continue;
    }
    if (candidate.mustBeLast === true) {
      if (!trailing) {
        // Extended to the plain words after it, so the message can quote the
        // whole phrase it could not place ("every 3rd thursday of the month")
        // and not the fragment it happened to understand.
        let to = candidate.to;
        while (to < words.length && !covered.has(to)) to += 1;
        candidate.to = to;
        candidate.decline = "where this repeat ends is unclear, because more words follow it";
      }
      continue;
    }
    if (candidate.group === "schedule" || candidate.group === "time") {
      if (plainBefore(candidate) && plainAfter(candidate)) {
        candidate.decline = "it is in the middle of the title, and may be part of it";
        continue;
      }
    }

    // The other weak position, and the one that nearly got away. A day at the
    // *front* of the title has no plain words before it, so the middle rule
    // never looked at it and it was claimed outright: "Friday retro notes"
    // came back as "retro notes" due Friday, and "Sunday roast shopping list"
    // as "roast shopping list". English puts a time adverbial at the end — you
    // write "retro notes friday" when you mean the day — so leading is where a
    // weekday is most often an adjective describing the thing, not a date for
    // it. Trailing stays confident, which is the common case and the safe one.
    //
    // An assumption rather than a refusal, because the reading is often right
    // and the chip is dismissable. What it buys is that strict callers — the
    // MCP tool, where there are no chips and nobody watching — now refuse it
    // instead of silently eating a word out of someone's title.
    // "today", "tomorrow" and "tonight" are exempt: they are only ever
    // temporal, so "tomorrow call mum" means the day and nothing else. The
    // trap is weekday and month names, which double as ordinary adjectives —
    // a Sunday roast, a Friday retro, a March review.
    const RELATIVE = new Set(["today", "tomorrow", "tonight"]);
    const opensWithARelativeWord = RELATIVE.has(
      words
        .slice(candidate.from, candidate.to)
        .map((word) => word.lower)
        .join(" "),
    );

    if (
      candidate.group === "schedule" &&
      !opensWithARelativeWord &&
      !plainBefore(candidate) &&
      plainAfter(candidate)
    ) {
      const inner = candidate.make;
      if (inner !== undefined) {
        candidate.make = (span) => {
          const token = inner(span);
          const note = `"${span.text}" opens the title, where it may describe the task rather than schedule it`;
          // Not `"assumed" in token`: the key is omitted entirely when there is
          // no assumption, which is precisely the token that needs marking.
          const existing = (token as { assumed?: string }).assumed;
          return {
            ...token,
            assumed: existing === undefined ? note : `${existing}; ${note}`,
          } as QuickAddToken;
        };
      }
    }
  }

  // A time takes its day from the date beside it, and when there is none,
  // from today. That default is fine for "call mum 5pm" and wrong when the
  // date that went with it was refused: "dinner tomorrow with mum at 7pm"
  // would come out due today at 19:00. So a refused day takes the times with it.
  const refusedDay = candidates.some((c) => c.group === "schedule" && c.decline !== undefined && !dropped.has(c));
  const survivingDay = candidates.some((c) => c.group === "schedule" && c.decline === undefined);
  if (refusedDay && !survivingDay) {
    for (const candidate of candidates) {
      if (candidate.group === "time" && candidate.decline === undefined) {
        candidate.decline = "the day it goes with was not read, and it will not be put on today instead";
      }
    }
  }

  /* ---- what is left ---- */

  const tokens: QuickAddToken[] = [];
  const declined: Declined[] = [];
  for (const candidate of candidates) {
    if (dropped.has(candidate)) continue;
    const span = spanOf(candidate);
    if (candidate.decline !== undefined) {
      declined.push({ ...span, reason: candidate.decline });
    } else {
      tokens.push(candidate.make!(span));
    }
  }
  if (description !== null) tokens.push(description);

  // A time with no date beside it is today's. Said out loud, on the token.
  const hasDay = tokens.some((token) => token.kind === "date" || token.kind === "recurrence");
  const finished = tokens.map((token): QuickAddToken =>
    token.kind === "time" && !hasDay
      ? { ...token, assumed: "no day was given, so this is read as today" }
      : token,
  );

  // A repeat that starts today at a time that has already gone would be
  // overdue the moment it exists. Moved to the next occurrence — the day
  // completing it now would have produced — and said so, since it is a call.
  const clock = finished.find((token) => token.kind === "time");
  const adjusted = finished.map((token): QuickAddToken => {
    if (token.kind !== "recurrence" || clock?.kind !== "time" || options.now === undefined) return token;
    if (token.date !== today || clock.time > options.now) return token;
    const next = nextOccurrence(token.rule, today, today);
    const note = `${clock.time} has already passed today, so the first one is ${dayWithName(next)}`;
    return { ...token, date: next, assumed: token.assumed === undefined ? note : `${token.assumed}; ${note}` };
  });

  const title = withoutSpans(source, adjusted).replace(/\s+/g, " ").trim();
  return summarise(source, title, adjusted, declined, today);
}

/** The source with each token's text cut out. */
function withoutSpans(source: string, tokens: QuickAddToken[]): string {
  let out = "";
  let at = 0;
  for (const token of [...tokens].sort((a, b) => a.start - b.start)) {
    out += source.slice(at, token.start);
    at = token.end;
  }
  return out + source.slice(at);
}

function summarise(
  source: string,
  title: string,
  tokens: QuickAddToken[],
  declined: Declined[],
  today: string,
): QuickAddParse {
  const byStart = (a: Span, b: Span) => a.start - b.start;
  tokens.sort(byStart);
  declined.sort(byStart);

  let priority: Priority | null = null;
  let projectId: string | null = null;
  let description = "";
  const labels: string[] = [];
  let dayToken: (QuickAddToken & { kind: "date" | "recurrence" }) | undefined;
  let timeToken: (QuickAddToken & { kind: "time" }) | undefined;

  for (const token of tokens) {
    switch (token.kind) {
      case "priority": priority = token.priority; break;
      case "project": projectId = token.projectId; break;
      case "description": description = token.description; break;
      case "label":
        if (!labels.some((name) => name.toLowerCase() === token.name.toLowerCase())) labels.push(token.name);
        break;
      case "date":
      case "recurrence": dayToken = token; break;
      case "time": timeToken = token; break;
    }
  }

  let schedule: QuickAddSchedule | null = null;
  if (dayToken !== undefined || timeToken !== undefined) {
    const assumed = [dayToken, timeToken].flatMap((token) =>
      token?.assumed === undefined ? [] : [token.assumed],
    );
    schedule = {
      date: dayToken === undefined ? today : dayToken.date,
      time: timeToken === undefined ? null : timeToken.time,
      recurrence:
        dayToken !== undefined && dayToken.kind === "recurrence"
          ? { text: dayToken.text, rule: dayToken.rule }
          : null,
      assumed,
    };
  }

  return { source, title, tokens, declined, priority, labels, projectId, description, schedule };
}

/* ------------------------------------------------------------------ */
/* the strict entry point                                              */
/* ------------------------------------------------------------------ */

/**
 * The same reading, for a caller that cannot show a chip.
 *
 * The text field can afford to read "next week" as a Monday, because the
 * Monday appears beside the box and one click puts "next week" back. An agent
 * writing a task has no beside the box. A wrong date it writes is simply a
 * wrong date, found weeks later.
 *
 * So this refuses to proceed on anything the lenient parser either declined or
 * had to assume, and says what, quoting the text. It never reads anything
 * differently from `parseQuickAdd` — when it does proceed, the parse is that
 * one, unchanged — it only declines to go on. That is a separate entry point
 * rather than a flag so that no caller can pass the wrong one by accident, and
 * no future change to the lenient path can quietly loosen this one.
 */
export function parseQuickAddStrict(source: string, options: QuickAddOptions): StrictResult {
  const parse = parseQuickAdd(source, options);

  const problems: Problem[] = [
    ...parse.declined.map((item): Problem => ({ start: item.start, end: item.end, text: item.text, why: item.reason })),
    ...parse.tokens.flatMap((token): Problem[] =>
      token.assumed === undefined
        ? []
        : [{ start: token.start, end: token.end, text: token.text, why: token.assumed }],
    ),
  ];
  if (parse.title === "") {
    problems.push({
      start: 0,
      end: source.length,
      text: source.trim(),
      why: "nothing is left to be the task's title once the shorthand is taken out",
    });
  }
  problems.sort((a, b) => a.start - b.start);

  if (problems.length === 0) return { ok: true, parse };

  const lines = problems.map((problem) => `- "${problem.text}": ${problem.why}`);
  return {
    ok: false,
    problems,
    message:
      `Could not read this safely, so nothing was created:\n${lines.join("\n")}\n` +
      "Say the date outright (for example 2026-11-20), leave it out, or set the fields directly.",
  };
}

/** What a token became, in words. For a chip's tooltip, or a message to an agent. */
export function meaning(token: QuickAddToken): string {
  switch (token.kind) {
    case "project": return `project ${token.name}`;
    case "label": return `label ${token.name}`;
    case "priority": return `priority p${token.priority}`;
    case "description": return "notes";
    case "date": return `due ${token.date}`;
    case "time": return `at ${token.time}`;
    case "recurrence": return `repeats "${token.text}", first on ${token.date}`;
  }
}
