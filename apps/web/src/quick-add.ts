/**
 * What the add-task line shows about what it read.
 *
 * The parser (`@light/client-sdk`) says what it took and from where; this is
 * the wording for it. It lives apart from `AddTask.tsx` so it can be tested
 * without rendering anything, and because getting it wrong is quiet: a chip
 * that says "Fri 13 Nov" for the 14th looks exactly as right as one that
 * doesn't.
 */

import { meaning, type QuickAddToken } from "@light/client-sdk";

/**
 * A day, as a chip would say it.
 *
 * Today and tomorrow in words, then the weekday with the date, so "friday"
 * typed on a Wednesday reads back as "Fri 13 Nov" and the person can see which
 * Friday it chose. Read in UTC, because `day` is a bare calendar date and
 * the local zone has no business shifting it.
 */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "today";
  const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (day === tomorrow) return "tomorrow";

  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** The words on a chip. */
export function chipLabel(token: QuickAddToken, today: string): string {
  switch (token.kind) {
    case "project": return `#${token.name}`;
    case "label": return `@${token.name}`;
    case "priority": return `p${token.priority}`;
    case "description": return "notes";
    case "date": return dayLabel(token.date, today);
    case "time": return token.time;
    // The phrase as typed is the honest label: it is also what gets stored,
    // and what completing the task will re-read.
    case "recurrence": return token.text;
  }
}

/** The tooltip: what it became, and the assumption behind it when there was one. */
export function chipTitle(token: QuickAddToken): string {
  const base = `${meaning(token)} — click to put "${token.text}" back in the title`;
  return token.assumed === undefined ? base : `${token.assumed}. ${base}`;
}

/** A chip the person has taken back: the text, and where in the line it sat. */
export interface Dismissed {
  start: number;
  text: string;
}

/**
 * Keeps each dismissal for exactly as long as the text it was made about.
 *
 * A dismissed chip has to stay dismissed while the person keeps typing, or the
 * parser would read the same word again on the very next keystroke and the
 * chip would pop back. Remembering the text alone is not enough: select the
 * line, paste a new one that happens to say "tomorrow" too, and that
 * "tomorrow" would still be the old one's dismissal.
 *
 * So each is tied to its place. The old and new line are compared for what
 * they share at the front and at the back — the edit is whatever is between —
 * and a dismissal survives only if it sits wholly outside the edit, moved by
 * however much the edit grew or shrank the line. One that the edit touched is
 * gone, and typing the word again is read again.
 */
export function reconcileDismissed(
  before: string,
  after: string,
  dismissed: readonly Dismissed[],
): Dismissed[] {
  if (before === after) return [...dismissed];

  let prefix = 0;
  const shorter = Math.min(before.length, after.length);
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;

  // The back is only compared where it does not overlap the front, or a line
  // like "aaa" -> "aa" would claim the same characters for both.
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const delta = after.length - before.length;
  const kept: Dismissed[] = [];
  for (const item of dismissed) {
    const end = item.start + item.text.length;
    if (end <= prefix) kept.push(item);
    else if (item.start >= before.length - suffix) kept.push({ ...item, start: item.start + delta });
  }
  return kept;
}
