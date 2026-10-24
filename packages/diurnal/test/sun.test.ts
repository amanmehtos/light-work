import { describe, expect, it } from "vitest";
import { hourOf, sunPosition } from "../src/sun.js";

/**
 * A local Date at a given hour, so these tests do not depend on the zone.
 *
 * The hour may be fractional — `Date`'s constructor truncates its arguments,
 * so a fractional hour has to be split out into minutes by hand.
 */
function at(hour: number, minute = 0): Date {
  const wholeHours = Math.floor(hour);
  const minutes = Math.round((hour - wholeHours) * 60) + minute;
  return new Date(2026, 5, 21, wholeHours, minutes, 0, 0);
}

describe("the clock model", () => {
  it("puts the sun on the horizon at sunrise and sunset", () => {
    expect(sunPosition(at(6)).altitude).toBeCloseTo(0, 5);
    expect(sunPosition(at(18)).altitude).toBeCloseTo(0, 5);
  });

  it("puts it overhead at solar noon", () => {
    expect(sunPosition(at(12)).altitude).toBeCloseTo(1, 5);
  });

  it("moves the light from left to right across the day", () => {
    // East is page-left at dawn, overhead at noon, page-right at dusk.
    expect(sunPosition(at(6)).lateral).toBeCloseTo(-1, 5);
    expect(sunPosition(at(12)).lateral).toBeCloseTo(0, 5);
    expect(sunPosition(at(18)).lateral).toBeCloseTo(1, 5);
  });

  it("moves monotonically through the morning", () => {
    let previous = -Infinity;
    for (let hour = 6; hour <= 12; hour += 0.5) {
      const lateral = sunPosition(at(hour)).lateral;
      expect(lateral).toBeGreaterThan(previous);
      previous = lateral;
    }
  });

  it("puts the sun below the horizon at night", () => {
    expect(sunPosition(at(2)).isNight).toBe(true);
    expect(sunPosition(at(22)).isNight).toBe(true);
    expect(sunPosition(at(12)).isNight).toBe(false);
  });

  it("respects a custom sunrise and sunset", () => {
    const winter = { sunriseHour: 8, sunsetHour: 16 };
    expect(sunPosition(at(8), winter).altitude).toBeCloseTo(0, 5);
    expect(sunPosition(at(12), winter).altitude).toBeCloseTo(1, 5);
    expect(sunPosition(at(7), winter).isNight).toBe(true);
  });

  it("never reports a lateral position outside the page", () => {
    for (let hour = 0; hour < 24; hour += 0.25) {
      const sun = sunPosition(at(hour));
      expect(sun.lateral).toBeGreaterThanOrEqual(-1);
      expect(sun.lateral).toBeLessThanOrEqual(1);
      expect(sun.altitude).toBeGreaterThanOrEqual(-1);
      expect(sun.altitude).toBeLessThanOrEqual(1);
    }
  });
});

describe("daylight", () => {
  it("is full in the middle of the day and absent deep in the night", () => {
    expect(sunPosition(at(12)).daylight).toBe(1);
    expect(sunPosition(at(2)).daylight).toBe(0);
  });

  it("eases through twilight rather than switching", () => {
    const dusk = sunPosition(at(18)).daylight;
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
  });

  it("increases through the morning without going backwards", () => {
    let previous = -1;
    for (let hour = 4; hour <= 12; hour += 0.5) {
      const daylight = sunPosition(at(hour)).daylight;
      expect(daylight).toBeGreaterThanOrEqual(previous);
      previous = daylight;
    }
  });
});

describe("warmth", () => {
  it("peaks when the sun is low but still up", () => {
    const golden = sunPosition(at(6, 45)).warmth;
    const noon = sunPosition(at(12)).warmth;
    expect(golden).toBeGreaterThan(noon);
    expect(golden).toBeGreaterThan(0);
  });

  it("is neutral at midday", () => {
    expect(sunPosition(at(12)).warmth).toBeCloseTo(0, 2);
  });

  it("goes cool at night", () => {
    expect(sunPosition(at(2)).warmth).toBeLessThan(0);
  });

  it("stays within range all day", () => {
    for (let hour = 0; hour < 24; hour += 0.25) {
      const warmth = sunPosition(at(hour)).warmth;
      expect(warmth).toBeGreaterThanOrEqual(-1);
      expect(warmth).toBeLessThanOrEqual(1);
    }
  });
});

describe("the solar model", () => {
  const bangkok = { latitude: 13.7563, longitude: 100.5018 };

  it("is used when coordinates are given", () => {
    expect(sunPosition(new Date(), bangkok).model).toBe("solar");
    expect(sunPosition(new Date()).model).toBe("clock");
  });

  it("puts the sun up at local midday and down at local midnight", () => {
    // 05:00Z is noon in Bangkok; 17:00Z is midnight there.
    const noon = sunPosition(new Date("2026-06-21T05:00:00Z"), bangkok);
    const midnight = sunPosition(new Date("2026-06-21T17:00:00Z"), bangkok);
    expect(noon.altitude).toBeGreaterThan(0.5);
    expect(midnight.altitude).toBeLessThan(0);
    expect(midnight.isNight).toBe(true);
  });

  it("gives the Arctic a sun that never sets in midsummer", () => {
    const tromso = { latitude: 69.6, longitude: 18.95 };
    let lowest = 1;
    for (let hour = 0; hour < 24; hour++) {
      const sun = sunPosition(new Date(Date.UTC(2026, 5, 21, hour)), tromso);
      lowest = Math.min(lowest, sun.altitude);
    }
    // The midnight sun: above the horizon at every hour of the day.
    expect(lowest).toBeGreaterThan(0);
  });

  it("gives a lower midday sun in winter than in summer", () => {
    const summer = sunPosition(new Date("2026-06-21T12:00:00Z"), { latitude: 51.5, longitude: 0 });
    const winter = sunPosition(new Date("2026-12-21T12:00:00Z"), { latitude: 51.5, longitude: 0 });
    expect(winter.altitude).toBeLessThan(summer.altitude);
    expect(winter.altitude).toBeGreaterThan(0);
  });
});

describe("hourOf", () => {
  it("reads a fractional hour", () => {
    expect(hourOf(at(14, 30))).toBeCloseTo(14.5, 5);
  });
});
