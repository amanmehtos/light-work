import { describe, expect, it } from "vitest";
import { nextOccurrence, parseRecurrence } from "../src/recurrence.js";
import { clockAt } from "../src/wallclock.js";

describe("parseRecurrence", () => {
  it("reads the plain intervals", () => {
    expect(parseRecurrence("every day")).toMatchObject({ unit: "day", interval: 1 });
    expect(parseRecurrence("daily")).toMatchObject({ unit: "day", interval: 1 });
    expect(parseRecurrence("every 3 days")).toMatchObject({ unit: "day", interval: 3 });
    expect(parseRecurrence("every week")).toMatchObject({ unit: "week", interval: 1 });
    expect(parseRecurrence("every 2 weeks")).toMatchObject({ unit: "week", interval: 2 });
    expect(parseRecurrence("every other day")).toMatchObject({ unit: "day", interval: 2 });
    expect(parseRecurrence("every month")).toMatchObject({ unit: "month", interval: 1 });
    expect(parseRecurrence("every year")).toMatchObject({ unit: "year", interval: 1 });
  });

  it("reads weekday schedules", () => {
    expect(parseRecurrence("every monday")?.weekdays).toEqual([1]);
    expect(parseRecurrence("every saturday")?.weekdays).toEqual([6]);
    expect(parseRecurrence("every mon, wed, fri")?.weekdays).toEqual([1, 3, 5]);
    expect(parseRecurrence("every tuesday and thursday")?.weekdays).toEqual([2, 4]);
    expect(parseRecurrence("every weekday")?.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(parseRecurrence("every weekend")?.weekdays).toEqual([0, 6]);
  });

  it("ignores a time clause, which comes from the due date", () => {
    expect(parseRecurrence("every saturday at 9am")?.weekdays).toEqual([6]);
    expect(parseRecurrence("every day at 07:30")).toMatchObject({ unit: "day", interval: 1 });
  });

  it("reads a day of the month", () => {
    expect(parseRecurrence("every 15th")).toMatchObject({ unit: "month", dayOfMonth: 15 });
    expect(parseRecurrence("every 1st")).toMatchObject({ unit: "month", dayOfMonth: 1 });
  });

  it("recognises the from-completion form", () => {
    expect(parseRecurrence("every! 3 days")).toMatchObject({
      unit: "day",
      interval: 3,
      fromCompletion: true,
    });
    expect(parseRecurrence("every 3 days")?.fromCompletion).toBe(false);
  });

  it("returns null for anything it does not understand, rather than guessing", () => {
    expect(parseRecurrence("every 3rd thursday of the month")).toBeNull();
    expect(parseRecurrence("when I feel like it")).toBeNull();
    expect(parseRecurrence("every 0 days")).toBeNull();
    expect(parseRecurrence(null)).toBeNull();
    expect(parseRecurrence(undefined)).toBeNull();
  });
});

describe("nextOccurrence", () => {
  const on = (text: string, due: string, today: string) =>
    nextOccurrence(parseRecurrence(text)!, due, today);

  it("advances a daily task by a day", () => {
    expect(on("every day", "2026-10-24", "2026-10-24")).toBe("2026-10-25");
  });

  it("advances by the stated interval", () => {
    expect(on("every 3 days", "2026-10-24", "2026-10-24")).toBe("2026-10-27");
    expect(on("every 2 weeks", "2026-10-24", "2026-10-24")).toBe("2026-11-07");
  });

  it("catches up past missed occurrences so the result is in the future", () => {
    // Due a week ago and completed today: the next occurrence is tomorrow,
    // not another date already in the past.
    expect(on("every day", "2026-10-17", "2026-10-24")).toBe("2026-10-25");
  });

  it("measures the from-completion form from today instead", () => {
    expect(on("every! 3 days", "2026-10-17", "2026-10-24")).toBe("2026-10-27");
  });

  it("lands on the next listed weekday", () => {
    // 2026-10-24 is a Saturday.
    expect(new Date("2026-10-24T00:00:00Z").getUTCDay()).toBe(6);
    expect(on("every saturday", "2026-10-24", "2026-10-24")).toBe("2026-10-31");
    expect(on("every monday", "2026-10-24", "2026-10-24")).toBe("2026-10-26");
    expect(on("every mon, wed, fri", "2026-10-24", "2026-10-24")).toBe("2026-10-26");
  });

  it("skips the weekend for a weekday schedule", () => {
    // Friday 2026-10-23 -> Monday 2026-10-26.
    expect(on("every weekday", "2026-10-23", "2026-10-23")).toBe("2026-10-26");
  });

  it("preserves the time of day", () => {
    expect(on("every day", "2026-10-24T09:00:00.000Z", "2026-10-24")).toBe(
      "2026-10-25T09:00:00.000Z",
    );
  });

  it("clamps a monthly task rather than rolling into the next month", () => {
    // 31 January plus a month is the end of February, not early March.
    expect(on("every month", "2027-01-31", "2027-01-31")).toBe("2027-02-28");
    expect(on("every month", "2028-01-31", "2028-01-31")).toBe("2028-02-29");
  });

  it("keeps a pinned day of the month across a short month", () => {
    const recurrence = parseRecurrence("every 31st")!;
    expect(nextOccurrence(recurrence, "2027-01-31", "2027-01-31")).toBe("2027-02-28");
    // The pin is remembered, so March returns to the 31st.
    expect(nextOccurrence(recurrence, "2027-02-28", "2027-02-28")).toBe("2027-03-31");
  });

  it("handles a leap day yearly task", () => {
    expect(on("every year", "2028-02-29", "2028-02-29")).toBe("2029-02-28");
  });
});

/**
 * The day a repeat advances from is the day the person is on.
 *
 * A timed due is stored as a UTC instant. Nine in the morning in Brisbane
 * (UTC+10) is 23:00 the evening before in UTC, so reading the day off the
 * front of the instant gives yesterday — and "every weekday" advanced from
 * yesterday lands back on today. The task never moved.
 *
 * Pinned to a named zone rather than the runtime's, so this fails for everyone
 * and not only for someone sitting in the Pacific.
 */
describe("a repeat at a time of day, east of UTC", () => {
  const brisbane = "Australia/Brisbane"; // UTC+10, and no daylight saving

  /** The local Brisbane day of an instant, which is the whole point here. */
  const dayThere = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: brisbane,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));

  // 09:00 on Friday 13 November in Brisbane is 23:00 on Thursday the 12th in
  // UTC. Reading the day off the front of that instant gives Thursday.
  const fridayAt9 = "2026-11-12T23:00:00.000Z";

  it("is the Friday it looks like on the phone, not the Thursday it is in UTC", () => {
    expect(dayThere(fridayAt9)).toBe("2026-11-13");
    expect(fridayAt9.slice(0, 10)).toBe("2026-11-12"); // the trap
  });

  it("advances a weekly repeat from Friday, giving another Friday", () => {
    // Completed on the Monday before, so the task's own day is what the
    // advance starts from — which is where reading it in UTC goes wrong. When
    // completion is on or after the due day the code takes the later of the
    // two and the bug hides.
    const weekly = parseRecurrence("every week")!;
    const next = nextOccurrence(weekly, fridayAt9, "2026-11-09", brisbane);

    expect(dayThere(next)).toBe("2026-11-20");
    expect(clockAt(new Date(next), brisbane)).toBe("09:00");
  });

  it("advances every weekday from Friday to Monday, not back onto Friday", () => {
    const weekdays = parseRecurrence("every weekday")!;
    const next = nextOccurrence(weekdays, fridayAt9, "2026-11-10", brisbane);

    // Read in UTC the anchor is Thursday, and the next weekday after Thursday
    // is the Friday the task is already on — so it never moves.
    expect(dayThere(next)).toBe("2026-11-16");
    expect(clockAt(new Date(next), brisbane)).toBe("09:00");
  });

  it("keeps the clock face across a daylight-saving change", () => {
    // Rebuilt from the instant, a 9am task comes back an hour out when the
    // offset moves. Rebuilt from the wall clock, it does not.
    const london = "Europe/London";
    const weekly = parseRecurrence("every week")!;
    const beforeTheChange = "2026-03-25T09:00:00.000Z"; // 09:00 GMT, Wed 25 Mar
    const next = nextOccurrence(weekly, beforeTheChange, "2026-03-23", london);

    expect(clockAt(new Date(next), london)).toBe("09:00");
    expect(next).not.toBe("2026-04-01T09:00:00.000Z"); // that would be 10:00 BST
  });

  it("leaves an all-day repeat exactly as it was", () => {
    const weekly = parseRecurrence("every week")!;
    expect(nextOccurrence(weekly, "2026-11-13", "2026-11-09", brisbane)).toBe("2026-11-20");
  });
});
