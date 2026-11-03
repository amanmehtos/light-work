import { describe, expect, it } from "vitest";
import {
  atDay,
  atTime,
  blockMinutes,
  clock,
  dueDay,
  dueMinutes,
  shiftDay,
  snap,
} from "../src/schedule.js";

/**
 * The conversions between a calendar day and an instant.
 *
 * Worth its own file because the bug it guards against is invisible in a
 * London afternoon and wrong everywhere else: a timed due is stored in UTC, so
 * reading the day off the front of the string puts a 23:00 task on tomorrow.
 * Every assertion here goes through a round trip rather than an expected
 * literal, so the suite passes in any zone the developer happens to be in.
 */
describe("dueDay", () => {
  it("reads an all-day date straight off", () => {
    expect(dueDay(atDay("2026-11-03"))).toBe("2026-11-03");
  });

  it("keeps a timed task on the local day it was put on", () => {
    // 23:00 and 00:30 are the two that cross the date line in UTC, in one
    // direction or the other, from almost anywhere.
    expect(dueDay(atTime("2026-11-03", 23 * 60))).toBe("2026-11-03");
    expect(dueDay(atTime("2026-11-03", 30))).toBe("2026-11-03");
  });

  it("is null when nothing is scheduled", () => {
    expect(dueDay(null)).toBeNull();
  });
});

describe("dueMinutes", () => {
  it("round-trips a time of day", () => {
    expect(dueMinutes(atTime("2026-11-03", 9 * 60 + 30))).toBe(9 * 60 + 30);
    expect(dueMinutes(atTime("2026-11-03", 0))).toBe(0);
    expect(dueMinutes(atTime("2026-11-03", 23 * 60 + 45))).toBe(23 * 60 + 45);
  });

  it("is null for an all-day task, which has no time to give", () => {
    expect(dueMinutes(atDay("2026-11-03"))).toBeNull();
    expect(dueMinutes(null)).toBeNull();
  });
});

describe("atTime", () => {
  it("marks the task as timed", () => {
    expect(atTime("2026-11-03", 540).hasTime).toBe(true);
  });

  it("carries the recurrence phrase across, so a repeat survives a drag", () => {
    const repeating = {
      date: "2026-11-03",
      hasTime: false,
      text: "every monday",
      timezone: null,
      isRecurring: true,
    };
    const moved = atTime("2026-11-03", 600, repeating);
    expect(moved.text).toBe("every monday");
    expect(moved.isRecurring).toBe(true);
  });
});

describe("atDay", () => {
  it("keeps the day but drops the time, which is what the rail means", () => {
    const timed = atTime("2026-11-03", 14 * 60);
    const unscheduled = atDay(dueDay(timed)!, timed);
    expect(unscheduled.hasTime).toBe(false);
    expect(unscheduled.date).toBe("2026-11-03");
  });
});

describe("snap", () => {
  it("rounds to the nearest quarter hour", () => {
    expect(snap(7)).toBe(0);
    expect(snap(8)).toBe(15);
    expect(snap(9 * 60 + 22)).toBe(9 * 60 + 15);
  });

  it("never lands outside the day", () => {
    expect(snap(-40)).toBe(0);
    expect(snap(24 * 60 + 90)).toBe(23 * 60 + 45);
  });
});

describe("clock", () => {
  it("pads both halves", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(9 * 60 + 5)).toBe("09:05");
    expect(clock(23 * 60 + 45)).toBe("23:45");
  });
});

describe("shiftDay", () => {
  it("counts on the calendar, across a month and a year", () => {
    expect(shiftDay("2026-11-03", 1)).toBe("2026-11-04");
    expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("blockMinutes", () => {
  it("gives an unestimated task something grabbable", () => {
    expect(blockMinutes(null)).toBe(30);
  });

  it("uses a minute estimate as given", () => {
    expect(blockMinutes({ amount: 90, unit: "minute" })).toBe(90);
  });

  it("refuses to turn a multi-day task into a block that buries the day", () => {
    expect(blockMinutes({ amount: 2, unit: "day" })).toBe(30);
  });

  it("floors a tiny estimate at one slot, so it can still be hit", () => {
    expect(blockMinutes({ amount: 5, unit: "minute" })).toBe(15);
  });
});
