import { describe, expect, it } from "vitest";
import { nextOccurrence, parseRecurrence } from "../src/recurrence.js";

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
