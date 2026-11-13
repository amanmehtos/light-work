import { describe, expect, it } from "vitest";
import { clockAt, instantAt } from "../src/wallclock.js";

describe("instantAt", () => {
  it("reads a time in the zone it was given, not the machine's", () => {
    // New York is UTC-5 in November and UTC-4 in July.
    expect(instantAt("2026-11-12", 9 * 60, "America/New_York")).toBe("2026-11-12T14:00:00.000Z");
    expect(instantAt("2026-07-12", 9 * 60, "America/New_York")).toBe("2026-07-12T13:00:00.000Z");
  });

  it("can land on the previous UTC day, which is the point of storing an instant", () => {
    // 09:00 in Sydney is the evening before in UTC.
    expect(instantAt("2026-11-12", 9 * 60, "Australia/Sydney")).toBe("2026-11-11T22:00:00.000Z");
  });

  it("agrees with UTC when the zone is UTC", () => {
    expect(instantAt("2026-11-12", 17 * 60 + 30, "UTC")).toBe("2026-11-12T17:30:00.000Z");
  });

  it("refuses a time the clock never shows", () => {
    // New York skipped 02:00-03:00 on 8 March 2026.
    expect(instantAt("2026-03-08", 2 * 60 + 30, "America/New_York")).toBeNull();
    expect(instantAt("2026-03-08", 3 * 60, "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
  });

  it("reads the machine's own time when no zone is given", () => {
    const instant = instantAt("2026-11-12", 9 * 60 + 15);
    const when = new Date(instant!);
    expect([when.getFullYear(), when.getMonth(), when.getDate(), when.getHours(), when.getMinutes()]).toEqual([
      2026, 10, 12, 9, 15,
    ]);
  });

  it("throws on a zone that does not exist, rather than falling back to another", () => {
    expect(() => instantAt("2026-11-12", 540, "Mars/Olympus")).toThrow();
  });
});

describe("clockAt", () => {
  it("reads the wall clock in the zone it is given", () => {
    const instant = new Date("2026-11-12T14:05:00.000Z");
    expect(clockAt(instant, "UTC")).toBe("14:05");
    expect(clockAt(instant, "America/New_York")).toBe("09:05");
    expect(clockAt(instant, "Asia/Kolkata")).toBe("19:35");
  });

  it("is the inverse of instantAt", () => {
    const instant = instantAt("2026-11-12", 9 * 60 + 15, "Australia/Sydney")!;
    expect(clockAt(new Date(instant), "Australia/Sydney")).toBe("09:15");
  });

  it("writes midnight as 00:00, not 24:00", () => {
    expect(clockAt(new Date("2026-11-12T00:00:00.000Z"), "UTC")).toBe("00:00");
  });
});
