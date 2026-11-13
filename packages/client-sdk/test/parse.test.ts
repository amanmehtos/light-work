import { describe, expect, it } from "vitest";
import { nextOccurrence } from "../src/recurrence.js";
import {
  meaning,
  parseQuickAdd,
  parseQuickAddStrict,
  type QuickAddOptions,
  type QuickAddParse,
  type QuickAddToken,
} from "../src/parse.js";

/**
 * The Quick Add contract.
 *
 * This file was written before the parser, and it is the thing to read to know
 * what the parser promises. Most of it is about what must *not* happen: the
 * parser backs both a text field, where a wrong guess shows up as a chip you
 * can dismiss, and an agent tool, where nobody is watching. The cases that
 * matter most are the ones where it says nothing.
 *
 * Every test pins the calendar with `TODAY`, a Wednesday, so "friday" and
 * "next week" mean the same thing whenever the suite runs.
 */

const TODAY = "2026-11-11"; // a Wednesday
const FRIDAY_TODAY = "2026-11-13"; // a Friday, for the weekday-on-its-own-day case

const HOME = { id: "p-home", name: "Home" };
const WORK = { id: "p-work", name: "Work" };
const KYC = { id: "p-kyc", name: "Develop KYC" };

function read(text: string, options: Partial<QuickAddOptions> = {}): QuickAddParse {
  return parseQuickAdd(text, { today: TODAY, projects: [HOME, WORK, KYC], ...options });
}

function find<K extends QuickAddToken["kind"]>(
  parse: QuickAddParse,
  kind: K,
): Extract<QuickAddToken, { kind: K }>[] {
  return parse.tokens.filter((token): token is Extract<QuickAddToken, { kind: K }> => token.kind === kind);
}

/** What a line must look like when the parser has declined to read any of it. */
function expectUntouched(text: string) {
  const parse = read(text);
  expect(parse.tokens, `tokens in "${text}"`).toEqual([]);
  expect(parse.title).toBe(text.replace(/\s+/g, " ").trim());
  return parse;
}

describe("the line from the plan", () => {
  const line = "pay rent tomorrow 9am p1 @errand #Home";
  const parse = read(line);

  it("reads five things and leaves the title alone", () => {
    expect(parse.title).toBe("pay rent");
    expect(parse.tokens.map((token) => token.kind).sort()).toEqual(
      ["date", "label", "priority", "project", "time"],
    );
    expect(parse.declined).toEqual([]);
  });

  it("says what each one became", () => {
    expect(find(parse, "date")[0]).toMatchObject({ date: "2026-11-12", text: "tomorrow" });
    expect(find(parse, "time")[0]).toMatchObject({ time: "09:00", text: "9am" });
    expect(find(parse, "priority")[0]).toMatchObject({ priority: 1, text: "p1" });
    expect(find(parse, "label")[0]).toMatchObject({ name: "errand", text: "@errand" });
    expect(find(parse, "project")[0]).toMatchObject({ projectId: "p-home", name: "Home", text: "#Home" });
  });

  it("collects them into the fields a task is made from", () => {
    expect(parse.priority).toBe(1);
    expect(parse.labels).toEqual(["errand"]);
    expect(parse.projectId).toBe("p-home");
    expect(parse.schedule).toMatchObject({ date: "2026-11-12", time: "09:00", recurrence: null });
    expect(parse.schedule?.assumed).toEqual([]);
  });
});

describe("token spans", () => {
  it("point at exactly the text each token was read from", () => {
    const line = "pay rent on friday at 9am p1 @errand #Home // landlord is Sam";
    const parse = read(line);
    expect(parse.tokens.length).toBe(6);
    for (const token of parse.tokens) {
      expect(line.slice(token.start, token.end), token.kind).toBe(token.text);
    }
  });

  it("include the connecting word that was taken with a date or a time", () => {
    const parse = read("pay rent on friday at 9am");
    expect(find(parse, "date")[0]!.text).toBe("on friday");
    expect(find(parse, "time")[0]!.text).toBe("at 9am");
    expect(parse.title).toBe("pay rent");
  });

  it("never overlap, and come back in the order they were typed", () => {
    const parse = read("p2 @a standup every weekday 9am #Work @b // x p1");
    const starts = parse.tokens.map((token) => token.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (let i = 1; i < parse.tokens.length; i++) {
      expect(parse.tokens[i]!.start).toBeGreaterThanOrEqual(parse.tokens[i - 1]!.end);
    }
  });

  it("give back the source unchanged, so a UI can draw over it", () => {
    const line = "  pay   rent   tomorrow ";
    expect(read(line).source).toBe(line);
  });

  it("leave the title with the whitespace tidied where tokens were cut out", () => {
    expect(read("Ready  p1  @focus  deck").title).toBe("Ready deck");
  });
});

describe("dates it reads", () => {
  it.each([
    ["call mum today", "2026-11-11"],
    ["call mum tomorrow", "2026-11-12"],
    ["call mum Tomorrow", "2026-11-12"],
    ["call mum tonight", "2026-11-11"],
    ["call mum friday", "2026-11-13"],
    ["call mum on friday", "2026-11-13"],
    ["call mum monday", "2026-11-16"],
    ["call mum thu", "2026-11-12"],
    ["call mum in 3 days", "2026-11-14"],
    ["call mum in 1 day", "2026-11-12"],
    ["call mum in 2 weeks", "2026-11-25"],
    ["call mum dec 25", "2026-12-25"],
    ["call mum 25 dec", "2026-12-25"],
    ["call mum 25th december", "2026-12-25"],
    ["call mum december 25th 2026", "2026-12-25"],
    ["call mum 2026-12-25", "2026-12-25"],
    ["call mum nov 11", "2026-11-11"],
    ["call mum feb 29 2028", "2028-02-29"],
    ["tomorrow call mum", "2026-11-12"],
  ])("%s", (line, date) => {
    const parse = read(line);
    expect(find(parse, "date")).toHaveLength(1);
    expect(find(parse, "date")[0]!.date).toBe(date);
    expect(find(parse, "date")[0]!.assumed).toBeUndefined();
    expect(parse.title).toBe("call mum");
    expect(parse.declined).toEqual([]);
  });

  it("does not read 'tonight' as a time, because nothing says which", () => {
    const parse = read("call mum tonight");
    expect(parse.schedule).toMatchObject({ date: "2026-11-11", time: null });
  });
});

describe("times it reads", () => {
  it.each([
    ["9am", "09:00"],
    ["9:30pm", "21:30"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["12:15am", "00:15"],
    ["11:59PM", "23:59"],
    ["9 pm", "21:00"],
    ["17:30", "17:30"],
    ["09:00", "09:00"],
    ["00:30", "00:30"],
    ["at 9am", "09:00"],
  ])("%s", (typed, time) => {
    const parse = read(`standup tomorrow ${typed}`);
    expect(find(parse, "time")).toHaveLength(1);
    expect(find(parse, "time")[0]!.time).toBe(time);
    expect(parse.title).toBe("standup");
  });
});

describe("recurrence, handed to parseRecurrence", () => {
  it("reads 'every weekday' and keeps the time separate", () => {
    const parse = read("standup every weekday 9am");
    expect(parse.title).toBe("standup");
    const repeat = find(parse, "recurrence")[0]!;
    expect(repeat.text).toBe("every weekday");
    expect(repeat.rule).toMatchObject({ unit: "week", weekdays: [1, 2, 3, 4, 5] });
    expect(parse.schedule).toMatchObject({
      date: "2026-11-11", // a Wednesday, which is a weekday, so it starts today
      time: "09:00",
    });
    expect(parse.schedule?.recurrence?.text).toBe("every weekday");
  });

  it("starts a weekday schedule on the first matching day", () => {
    expect(read("water plants every monday").schedule?.date).toBe("2026-11-16");
    expect(read("water plants every mon, wed, fri").schedule?.date).toBe("2026-11-11");
    expect(read("water plants every saturday").schedule?.date).toBe("2026-11-14");
  });

  it("starts a day-of-month schedule on the next such day", () => {
    expect(read("pay rent every 15th").schedule?.date).toBe("2026-11-15");
    expect(read("pay rent every 1st").schedule?.date).toBe("2026-12-01");
  });

  it("starts 'every day' and 'every 3 days' today", () => {
    expect(read("floss every day").schedule?.date).toBe("2026-11-11");
    expect(read("floss every 3 days").schedule?.date).toBe("2026-11-11");
    expect(find(read("floss every! 3 days"), "recurrence")[0]!.rule.fromCompletion).toBe(true);
  });

  it("keeps the phrase as typed, because completing the task re-reads it", () => {
    expect(read("floss Every Day").schedule?.recurrence?.text).toBe("Every Day");
  });

  it("is honest that 'every week' has no day to start from", () => {
    const parse = read("review budget every week");
    expect(parse.schedule?.date).toBe("2026-11-11");
    expect(parse.schedule?.assumed.length).toBe(1);
    expect(find(parse, "recurrence")[0]!.assumed).toContain("starts today");
  });
});

describe("a repeat that would start in the past", () => {
  it("starts at the next occurrence instead, and says so", () => {
    // 2026-11-11 is a Wednesday and a weekday; at 14:00 the 9am one is gone.
    const parse = read("standup every weekday 9am", { now: "14:00" });
    expect(parse.schedule).toMatchObject({ date: "2026-11-12", time: "09:00" });
    const token = find(parse, "recurrence")[0]!;
    expect(token.assumed).toMatch(/09:00 has already passed today.*Thursday 2026-11-12/);
    expect(parse.schedule?.assumed).toEqual([token.assumed]);
  });

  it("does not move a repeat whose time is still ahead", () => {
    const parse = read("standup every weekday 9am", { now: "08:00" });
    expect(parse.schedule?.date).toBe("2026-11-11");
    expect(find(parse, "recurrence")[0]!.assumed).toBeUndefined();
  });

  it("treats the minute itself as gone", () => {
    expect(read("standup every day 9am", { now: "09:00" }).schedule?.date).toBe("2026-11-12");
  });

  it("does nothing without a clock to compare to", () => {
    expect(read("standup every weekday 9am").schedule?.date).toBe("2026-11-11");
  });

  it("does nothing for a repeat with no time, or one that starts another day anyway", () => {
    expect(read("floss every day", { now: "23:59" }).schedule?.date).toBe("2026-11-11");
    expect(read("water plants every monday 9am", { now: "23:59" }).schedule?.date).toBe("2026-11-16");
  });

  it("is something strict refuses, as it is a call", () => {
    const result = parseQuickAddStrict("standup every weekday 9am", {
      today: TODAY,
      projects: [],
      now: "14:00",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("has already passed today");
  });

  it("lands on the date completing the task now would have produced", () => {
    // Not a coincidence worth leaving to chance: the two must agree.
    const parse = read("standup every weekday 9am", { now: "14:00" });
    const rule = find(parse, "recurrence")[0]!.rule;
    expect(parse.schedule?.date).toBe(nextOccurrence(rule, TODAY, TODAY));
  });
});

describe("what a date does when it has to make a call", () => {
  it("rolls a day that has already passed this year into next, and says so", () => {
    const token = find(read("renew passport jan 5"), "date")[0]!;
    expect(token.date).toBe("2027-01-05");
    expect(token.assumed).toMatch(/next year/);
  });

  it("does not call today's own date a day that has passed", () => {
    const token = find(read("renew passport nov 11"), "date")[0]!;
    expect(token.date).toBe("2026-11-11");
    expect(token.assumed).toBeUndefined();
  });

  it("takes 'friday' said on a Friday to mean next week, and says so", () => {
    const token = find(read("call mum friday", { today: FRIDAY_TODAY }), "date")[0]!;
    expect(token.date).toBe("2026-11-20");
    expect(token.assumed).toMatch(/today is friday/i);
  });

  it("takes 'next week' to mean next Monday, and says so", () => {
    const token = find(read("plan the quarter next week"), "date")[0]!;
    expect(token.date).toBe("2026-11-16");
    expect(token.text).toBe("next week");
    expect(token.assumed).toMatch(/monday/i);
  });

  it("gives a time on its own today's date, and says so", () => {
    const parse = read("call mum 5pm");
    expect(parse.schedule).toMatchObject({ date: "2026-11-11", time: "17:00" });
    expect(parse.schedule?.assumed).toEqual([expect.stringMatching(/today/)]);
    expect(find(parse, "time")[0]!.assumed).toMatch(/today/);
  });
});

describe("priority, labels and the rest of the shorthand", () => {
  it("reads a priority and removes it from the title", () => {
    const parse = read("Ready pitch deck p1");
    expect(parse.priority).toBe(1);
    expect(parse.title).toBe("Ready pitch deck");
  });

  it("reads a priority anywhere in the line", () => {
    expect(read("p2 Send the build").title).toBe("Send the build");
    expect(read("Send p3 the build").title).toBe("Send the build");
    expect(read("Send p3 the build").priority).toBe(3);
  });

  it("is case-insensitive about the priority", () => {
    expect(read("Fix it P1").priority).toBe(1);
  });

  it("reads labels and removes them from the title", () => {
    const parse = read("Write the deck @focus @deep");
    expect(parse.labels).toEqual(["focus", "deep"]);
    expect(parse.title).toBe("Write the deck");
  });

  it("does not repeat a label given twice, though both are tokens to take back", () => {
    const parse = read("Task @focus @focus");
    expect(parse.labels).toEqual(["focus"]);
    expect(find(parse, "label")).toHaveLength(2);
  });

  it("splits a description off after //", () => {
    const parse = read("Ready pitch deck // lead with the economics");
    expect(parse.title).toBe("Ready pitch deck");
    expect(parse.description).toBe("lead with the economics");
  });

  it("reads //notes with no space after it", () => {
    expect(read("Ready pitch deck //lead with it").description).toBe("lead with it");
  });

  it("leaves shorthand inside the description alone", () => {
    const parse = read("Ready deck p1 // mention p2 pricing @later tomorrow");
    expect(parse.priority).toBe(1);
    expect(parse.labels).toEqual([]);
    expect(parse.schedule).toBeNull();
    expect(parse.description).toBe("mention p2 pricing @later tomorrow");
  });

  it("handles everything at once", () => {
    const parse = read("Ready publisher pitch deck p1 @focus // lead with economics");
    expect(parse.title).toBe("Ready publisher pitch deck");
    expect(parse.priority).toBe(1);
    expect(parse.labels).toEqual(["focus"]);
    expect(parse.description).toBe("lead with economics");
  });

  it("treats a line of only shorthand as having no title, so it cannot be submitted", () => {
    expect(read("p1 @focus").title).toBe("");
    expect(read("   ").title).toBe("");
  });
});

describe("projects", () => {
  it("resolves #Name against the projects it was given, ignoring case", () => {
    expect(read("File taxes #home").projectId).toBe("p-home");
    expect(read("File taxes #HOME").projectId).toBe("p-home");
  });

  it("reads a project with spaces in its name from a hyphen or underscore", () => {
    expect(read("Fix onboarding #Develop-KYC").projectId).toBe("p-kyc");
    expect(read("Fix onboarding #develop_kyc").projectId).toBe("p-kyc");
  });

  it("declines a project it does not have, and leaves it in the title", () => {
    const parse = read("File taxes #Garage");
    expect(parse.projectId).toBeNull();
    expect(parse.title).toBe("File taxes #Garage");
    expect(parse.declined).toEqual([expect.objectContaining({ text: "#Garage", reason: expect.stringMatching(/no project/i) })]);
  });

  it("declines a name that fits two projects rather than choosing one", () => {
    const twins = [
      { id: "a", name: "Home" },
      { id: "b", name: "home" },
    ];
    const parse = read("File taxes #Home", { projects: twins });
    expect(parse.projectId).toBeNull();
    expect(parse.title).toBe("File taxes #Home");
    expect(parse.declined[0]!.reason).toMatch(/more than one/i);
  });

  it("declines two different projects in one line", () => {
    const parse = read("File taxes #Home #Work");
    expect(parse.projectId).toBeNull();
    expect(parse.title).toBe("File taxes #Home #Work");
    expect(parse.declined.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* the negative cases                                                  */
/* ------------------------------------------------------------------ */

describe("text that is not a date, a label, a priority or a project", () => {
  it.each([
    // Numbers are not dates, and never become one.
    "Ready publisher pitch deck",
    "read chapter 3",
    "read chapters 3 and 4",
    "buy 5 apples",
    "version 2026 release notes",
    "answer question 12",
    "chapter 5 jan was a character",
    // Slashes and colons that are not what they look like.
    "buy 1/2 cup sugar",
    "check the and/or logic",
    "aspect ratio 16:9",
    // A word that contains shorthand is not shorthand.
    "Deploy sp1 cluster",
    "Check p5 compliance",
    "reply to p10 thread",
    "fix p1, then ship",
    "see appendix p1a",
    // Addresses and links.
    "email bob@example.com",
    "see https://example.com/a//b",
    "fix issue #123",
    "C# and F# interop",
    "tidy up @",
    // Words that are dates only sometimes.
    "write the weekly report",
    "daily standup notes",
    "monthly review deck",
    "annually inspect the boiler",
    "the cat sat on the sun lounger",
    "they wed in june",
    "march forward with the plan",
    "i may have 5 minutes",
    "may 5 people attend",
    "march 3 miles",
    "tomorrow's agenda",
    "yesterday",
    "every window needs cleaning",
    "buy every ingredient",
  ])("%s", (text) => {
    // Some of these are *declined* with a reason rather than simply not
    // matched (see the next block); either way nothing is claimed and the
    // title is exactly what was typed.
    expectUntouched(text);
  });

  it("does not claim a bare number, however it is placed", () => {
    for (const text of ["read chapter 3", "buy 5 apples", "3", "in 3", "at 5 sharp"]) {
      expect(find(read(text), "date"), text).toEqual([]);
      expect(find(read(text), "time"), text).toEqual([]);
    }
  });

  it("does not take a month name without a day for a date", () => {
    expectUntouched("plan for january");
    expectUntouched("jan 2026 budget");
    expectUntouched("dec 40");
  });

  it("does not take an email address for a label", () => {
    const parse = read("email bob@example.com");
    expect(find(parse, "label")).toEqual([]);
  });

  it("does not take a url for a description", () => {
    const parse = read("read https://example.com/a // from sam");
    expect(parse.description).toBe("from sam");
    expect(parse.title).toBe("read https://example.com/a");
    expect(read("read https://example.com/a").description).toBe("");
  });
});

describe("what it says it could not read", () => {
  /** Each is left whole in the title, and named in `declined`. */
  it.each<[string, string[], RegExp]>([
    // A date with a word in front that changes what it means.
    ["ship it next friday", ["next friday"], /next/i],
    ["ship it this friday", ["this friday"], /this/i],
    ["report due by friday", ["by friday"], /deadline|before/i],
    ["report due friday", ["due friday"], /deadline|due/i],
    ["finish before friday", ["before friday"], /deadline|before/i],
    // A date with a part of the day stuck to it.
    ["lunch friday morning", ["friday morning"], /part of the day/i],
    ["call mum tomorrow evening", ["tomorrow evening"], /part of the day/i],
    ["call mum tomorrow pm", ["tomorrow pm"], /part of the day|am or pm/i],
    // Two dates.
    ["call mum tomorrow friday", ["tomorrow", "friday"], /two/i],
    // A date that does not exist, or is not ahead of us.
    ["party feb 30", ["feb 30"], /no such date/i],
    ["party 2026-02-30", ["2026-02-30"], /no such date/i],
    ["party feb 29 2027", ["feb 29 2027"], /no such date/i],
    ["backdate 2020-01-01", ["2020-01-01"], /past/i],
    ["backdate jan 5 2020", ["jan 5 2020"], /past/i],
    ["backdate nov 3 2026", ["nov 3 2026"], /past/i],
    // Shapes it recognises and does not support.
    ["send it in 2 months", ["in 2 months"], /not supported|months/i],
    ["send it in 30 minutes", ["in 30 minutes"], /not supported|minutes/i],
    ["send it in 2 hours", ["in 2 hours"], /not supported|hours/i],
    ["send it next month", ["next month"], /not supported|month/i],
    ["send it this weekend", ["this weekend"], /not supported|weekend/i],
    ["send it 3/4/2026", ["3/4/2026"], /day|month/i],
    // A time that could be morning or evening, or not a time at all.
    ["meet at 5", ["at 5"], /am or pm|morning or evening/i],
    ["meet 9:30", ["9:30"], /am or pm|morning or evening/i],
    ["read john 3:16", ["3:16"], /am or pm|morning or evening|not a time/i],
    ["meet 10:30", ["10:30"], /am or pm|morning or evening/i],
    ["meet 13pm", ["13pm"], /not a valid time/i],
    ["meet 0am", ["0am"], /not a valid time/i],
    ["meet 9:75am", ["9:75am"], /not a valid time/i],
    ["meet 25:00", ["25:00"], /not a valid time|not a time/i],
    // A repeat it does not understand.
    ["clean every other tuesday", ["every other tuesday"], /repeat/i],
    ["pay every 3rd thursday of the month", ["every 3rd thursday of the month"], /repeat|where/i],
    ["pay every 0 days", ["every 0 days"], /repeat/i],
    ["sync every monday starting tomorrow", ["every monday", "tomorrow"], /repeat|two|schedule/i],
    // Punctuation stuck to a date word.
    ["pay rent tomorrow.", ["tomorrow."], /punctuation/i],
    ["pay rent friday,", ["friday,"], /punctuation/i],
    // Two priorities.
    ["fix it p1 p2", ["p1", "p2"], /two priorities|more than one/i],
  ])("%s", (text, named, why) => {
    const parse = read(text);
    expect(parse.title, "the whole line stays as the title").toBe(text);
    expect(parse.schedule, "no date was claimed").toBeNull();
    expect(parse.declined.map((item) => item.text)).toEqual(named);
    expect(parse.declined.map((item) => item.reason).join(" | ")).toMatch(why);
  });

  it("declines a date in the middle of a sentence rather than guess where it ends", () => {
    const parse = read("email sam tomorrow about the invoice");
    expect(parse.schedule).toBeNull();
    expect(parse.title).toBe("email sam tomorrow about the invoice");
    expect(parse.declined[0]).toMatchObject({ text: "tomorrow" });
    expect(parse.declined[0]!.reason).toMatch(/middle/i);
  });

  it("is happy with the same date at either end of the title", () => {
    expect(read("tomorrow email sam about the invoice").schedule?.date).toBe("2026-11-12");
    expect(read("email sam about the invoice tomorrow").schedule?.date).toBe("2026-11-12");
  });

  it("does not hand a time today's date when the day beside it was refused", () => {
    // Read naively, "7pm" is a perfectly good time, and a task due today at 7pm
    // is exactly the wrong answer for "dinner tomorrow".
    const parse = read("dinner tomorrow with mum at 7pm");
    expect(parse.schedule).toBeNull();
    expect(find(parse, "time")).toEqual([]);
    expect(parse.title).toBe("dinner tomorrow with mum at 7pm");
    expect(parse.declined.map((item) => item.text)).toEqual(expect.arrayContaining(["tomorrow", "at 7pm"]));
  });

  it("does not hand a time today's date when the day beside it was 'by friday'", () => {
    const parse = read("send report by friday 5pm");
    expect(parse.schedule).toBeNull();
    expect(parse.title).toBe("send report by friday 5pm");
  });

  it("does not claim a recurrence that has more words after it", () => {
    const parse = read("every monday pay rent");
    expect(parse.schedule).toBeNull();
    expect(parse.title).toBe("every monday pay rent");
  });

  it("still reads the other shorthand on a line whose date it declined", () => {
    const parse = read("ship it next friday p1 @launch #Work");
    expect(parse.priority).toBe(1);
    expect(parse.labels).toEqual(["launch"]);
    expect(parse.projectId).toBe("p-work");
    expect(parse.schedule).toBeNull();
    expect(parse.title).toBe("ship it next friday");
  });

  it("does not read the same line differently depending on its case", () => {
    expect(read("Ship It NEXT Friday").declined).toHaveLength(1);
    expect(read("PAY RENT TOMORROW").schedule?.date).toBe("2026-11-12");
  });
});

describe("a line that stops on a connecting word", () => {
  it.each(["call mum by", "pay on", "meet at", "ship next", "every", "every!", "in", "jan", "#", "@", "//"])(
    "%s",
    (text) => {
      // Each of these once ran a matcher off the end of the line.
      expect(() => read(text)).not.toThrow();
      expect(read(text).schedule).toBeNull();
    },
  );
});

describe("taking a token back", () => {
  it("leaves a dismissed token in the title, and reads nothing else differently", () => {
    const parse = read("book flights tomorrow p1", { ignore: ["tomorrow"] });
    expect(parse.schedule).toBeNull();
    expect(parse.title).toBe("book flights tomorrow");
    expect(parse.priority).toBe(1);
  });

  it("matches the text that was dismissed without regard to case", () => {
    const parse = read("book flights Tomorrow", { ignore: ["tomorrow"] });
    expect(parse.title).toBe("book flights Tomorrow");
  });

  it("can dismiss a priority, a label or a project", () => {
    const parse = read("fix p2 @a #Home", { ignore: ["p2", "@a", "#Home"] });
    expect(parse.tokens).toEqual([]);
    expect(parse.title).toBe("fix p2 @a #Home");
  });

  it("does not let a dismissed day strand a time on today", () => {
    // The person took 'friday' back into the title; the 5pm that went with it
    // is now a time with no day. It is still read — with the assumption
    // marked, which is what the chip is for — rather than silently dropped.
    const parse = read("call mum friday 5pm", { ignore: ["friday"] });
    expect(parse.schedule).toMatchObject({ date: "2026-11-11", time: "17:00" });
    expect(parse.schedule?.assumed.length).toBe(1);
  });
});

describe("meaning", () => {
  it("describes each kind of token in words a person would use", () => {
    const parse = read("pay rent tomorrow 9am p1 @errand #Home // note");
    const said = Object.fromEntries(parse.tokens.map((token) => [token.kind, meaning(token)]));
    expect(said).toMatchObject({
      date: "due 2026-11-12",
      time: "at 09:00",
      priority: "priority p1",
      label: "label errand",
      project: "project Home",
      description: "notes",
    });
  });
});

/* ------------------------------------------------------------------ */
/* the strict entry point                                              */
/* ------------------------------------------------------------------ */

describe("parseQuickAddStrict", () => {
  const strict = (text: string, options: Partial<QuickAddOptions> = {}) =>
    parseQuickAddStrict(text, { today: TODAY, projects: [HOME, WORK, KYC], ...options });

  it("accepts a line it read completely", () => {
    const result = strict("pay rent tomorrow 9am p1 @errand #Home");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parse.title).toBe("pay rent");
  });

  it("accepts a line with nothing in it to read", () => {
    const result = strict("read chapter 3");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parse.title).toBe("read chapter 3");
  });

  it("accepts a date that needed no call to be made", () => {
    expect(strict("call mum friday").ok).toBe(true);
    expect(strict("call mum in 3 days").ok).toBe(true);
    expect(strict("call mum 2026-12-25").ok).toBe(true);
  });

  it("refuses what the lenient parser would have left in the title, and names it", () => {
    const result = strict("ship it next friday");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.text)).toEqual(["next friday"]);
      expect(result.message).toContain('"next friday"');
      expect(result.message).toMatch(/nothing was created/i);
    }
  });

  it("refuses what the lenient parser claimed on an assumption, and names it", () => {
    // The two parsers agree on what they read; they disagree on what to do
    // about a guess. The text field shows it as a chip and lets you take it
    // back. An agent has no chip.
    const line = "plan the quarter next week";
    const lenient = read(line);
    expect(find(lenient, "date")[0]!.date).toBe("2026-11-16");

    const result = strict(line);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems[0]).toMatchObject({ text: "next week" });
      expect(result.message).toContain('"next week"');
      expect(result.message).toMatch(/monday/i);
    }
  });

  it("refuses a weekday said on that weekday", () => {
    const result = strict("call mum friday", { today: FRIDAY_TODAY });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"friday"');
  });

  it("refuses a year-less date that has already gone by this year", () => {
    const result = strict("renew passport jan 5");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"jan 5"');
  });

  it("refuses a time with no day", () => {
    const result = strict("call mum 5pm");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"5pm"');
  });

  it("refuses a repeat whose first day it had to assume", () => {
    const result = strict("review budget every week");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"every week"');
  });

  it("refuses an unknown project", () => {
    const result = strict("file taxes #Garage");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"#Garage"');
  });

  it("refuses a line with nothing left to be the title", () => {
    const result = strict("tomorrow 9am p1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/title/i);
  });

  it("names every problem, not just the first", () => {
    const result = strict("ship it next friday at 5 #Garage");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.length).toBeGreaterThanOrEqual(3);
      expect(result.message).toContain('"next friday"');
      expect(result.message).toContain('"at 5"');
      expect(result.message).toContain('"#Garage"');
    }
  });

  it("tells the caller what to do instead", () => {
    const result = strict("ship it next friday");
    if (!result.ok) {
      expect(result.message).toMatch(/create_task|YYYY-MM-DD|date/);
    }
  });

  it("never refuses what the lenient parser read with nothing to doubt", () => {
    // The strict parser is the lenient one plus a refusal to proceed; it must
    // not read anything differently when it does proceed.
    const line = "pay rent tomorrow 9am p1 @errand #Home // landlord";
    const result = strict(line);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parse).toEqual(read(line));
  });
});

/* ------------------------------------------------------------------ */
/* invariants over arbitrary text                                      */
/* ------------------------------------------------------------------ */

describe("whatever it is given", () => {
  // A small vocabulary of exactly the words that make a parser go wrong,
  // shuffled with a fixed seed so a failure is reproducible.
  const vocabulary = [
    "pay", "rent", "call", "mum", "chapter", "3", "5", "12", "tomorrow", "today", "friday", "next",
    "by", "on", "at", "in", "days", "weeks", "every", "weekday", "other", "tuesday", "3rd", "jan",
    "may", "march", "5th", "9am", "5pm", "17:30", "9:30", "p1", "p2", "p5", "@errand", "@a", "#Home",
    "#Garage", "#123", "//", "// notes", "2026-12-25", "2026-02-30", "feb", "30", "morning", "pm",
    "tomorrow.", "1/2", "a@b.c", "https://x.y//z",
  ];

  function lines(count: number): string[] {
    let seed = 20261111;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    return Array.from({ length: count }, () =>
      Array.from({ length: 1 + Math.floor(next() * 8) }, () => vocabulary[Math.floor(next() * vocabulary.length)]!).join(
        next() < 0.1 ? "  " : " ",
      ),
    );
  }

  it("reports spans that are exactly the text they claim, in order, without overlap", () => {
    for (const line of lines(2000)) {
      const parse = read(line);
      const marks = [...parse.tokens, ...parse.declined].sort((a, b) => a.start - b.start);
      for (let i = 0; i < marks.length; i++) {
        const mark = marks[i]!;
        expect(line.slice(mark.start, mark.end), line).toBe(mark.text);
        if (i > 0) expect(mark.start, line).toBeGreaterThanOrEqual(marks[i - 1]!.end);
      }
    }
  });

  it("leaves in the title everything it did not claim, and nothing it did", () => {
    for (const line of lines(2000)) {
      const parse = read(line);
      let rebuilt = "";
      let at = 0;
      for (const token of parse.tokens) {
        rebuilt += line.slice(at, token.start);
        at = token.end;
      }
      rebuilt += line.slice(at);
      expect(parse.title, line).toBe(rebuilt.replace(/\s+/g, " ").trim());
    }
  });

  it("is never more trusting in strict mode than it was in lenient mode", () => {
    for (const line of lines(2000)) {
      const lenient = read(line);
      const strict = parseQuickAddStrict(line, { today: TODAY, projects: [HOME, WORK, KYC] });
      if (strict.ok) {
        expect(lenient.declined, line).toEqual([]);
        expect(lenient.tokens.filter((token) => token.assumed !== undefined), line).toEqual([]);
        expect(lenient.title, line).not.toBe("");
        expect(strict.parse, line).toEqual(lenient);
      } else {
        expect(strict.problems.length, line).toBeGreaterThan(0);
        for (const problem of strict.problems) expect(strict.message, line).toContain(`"${problem.text}"`);
      }
    }
  });

  it("claims at most one day, one time and one priority", () => {
    for (const line of lines(2000)) {
      const kinds = read(line).tokens.map((token) => token.kind);
      const count = (kind: string) => kinds.filter((k) => k === kind).length;
      expect(count("date") + count("recurrence"), line).toBeLessThanOrEqual(1);
      expect(count("time"), line).toBeLessThanOrEqual(1);
      expect(count("priority"), line).toBeLessThanOrEqual(1);
      expect(count("project"), line).toBeLessThanOrEqual(1);
    }
  });
});

describe("a day that opens the title", () => {
  /**
   * The case that nearly shipped. A day in the middle of a title was already
   * refused, but a day at the *front* had no plain words before it, so the
   * middle rule never saw it and the day was claimed outright — quietly
   * removing a word from the title and inventing a due date for it.
   *
   * These read as adjectives far more often than as dates, so the reading is
   * kept (it is often right, and the chip can be dismissed) but marked as an
   * assumption, which is what makes strict callers refuse it.
   */
  const leading = ["Friday retro notes", "Monday standup agenda", "Sunday roast shopping list"];

  for (const text of leading) {
    it(`treats the day in "${text}" as an assumption, not a certainty`, () => {
      const parsed = parseQuickAdd(text, { today: "2026-11-13" });
      expect(parsed.schedule).not.toBeNull();
      expect(parsed.schedule!.assumed.length).toBeGreaterThan(0);
      expect(parsed.schedule!.assumed.join(" ")).toMatch(/opens the title/);
    });

    it(`refuses "${text}" in strict mode, where nothing can be dismissed`, () => {
      const strict = parseQuickAddStrict(text, { today: "2026-11-13" });
      expect(strict.ok).toBe(false);
    });
  }

  it("still reads a trailing day with no hesitation, which is the common case", () => {
    // Monday, not Friday: the fixture day is itself a Friday, and "friday"
    // said on a Friday is a separate assumption that would mask this one.
    const parsed = parseQuickAdd("retro notes monday", { today: "2026-11-13" });
    expect(parsed.schedule?.date).toBe("2026-11-16");
    expect(parsed.title).toBe("retro notes");
    expect(parsed.schedule!.assumed).toEqual([]);
    expect(parseQuickAddStrict("retro notes monday", { today: "2026-11-13" }).ok).toBe(true);
  });

  it("still trusts a leading today or tomorrow, which are only ever temporal", () => {
    // The exemption. "Sunday" doubles as an adjective — a Sunday roast — and
    // "tomorrow" does not, so "tomorrow call mum" needs no hedging.
    const parsed = parseQuickAdd("tomorrow call mum", { today: "2026-11-13" });
    expect(parsed.schedule?.date).toBe("2026-11-14");
    expect(parsed.title).toBe("call mum");
    expect(parsed.schedule!.assumed).toEqual([]);
  });

  it("leaves a day in the middle alone, as before", () => {
    const parsed = parseQuickAdd("write the Friday report", { today: "2026-11-13" });
    expect(parsed.schedule).toBeNull();
    expect(parsed.title).toBe("write the Friday report");
  });
});
