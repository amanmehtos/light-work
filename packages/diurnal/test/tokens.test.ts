import { describe, expect, it } from "vitest";
import { sunPosition, type SunPosition } from "../src/sun.js";
import { cssVariables, describeLight, tokensFor } from "../src/tokens.js";

function at(hour: number, minute = 0) {
  const wholeHours = Math.floor(hour);
  const minutes = Math.round((hour - wholeHours) * 60) + minute;
  return sunPosition(new Date(2026, 5, 21, wholeHours, minutes, 0, 0));
}

describe("shadow direction", () => {
  it("falls away from the light", () => {
    // Morning sun is page-left, so shadows fall to the right, and the reverse
    // in the evening. Getting this backwards is the one error that would make
    // the whole kit look wrong without looking broken.
    expect(tokensFor(at(7)).shadowX).toBeGreaterThan(0);
    expect(tokensFor(at(17)).shadowX).toBeLessThan(0);
  });

  it("is straight down when the sun is overhead", () => {
    expect(tokensFor(at(12)).shadowX).toBeCloseTo(0, 2);
  });

  it("always falls downward, at every hour", () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      // The light is always above the page; nothing should ever cast upwards.
      expect(tokensFor(at(hour)).shadowY, `hour ${hour}`).toBeGreaterThan(0);
    }
  });
});

describe("shadow length", () => {
  it("is shortest at midday and longest at the ends of the day", () => {
    const noon = tokensFor(at(12)).shadowLength;
    const morning = tokensFor(at(7)).shadowLength;
    const evening = tokensFor(at(17)).shadowLength;
    expect(noon).toBeLessThan(morning);
    expect(noon).toBeLessThan(evening);
  });

  it("grows as the sun drops, without reversing", () => {
    let previous = 0;
    for (let hour = 12; hour <= 18; hour += 0.5) {
      const length = tokensFor(at(hour)).shadowLength;
      expect(length).toBeGreaterThanOrEqual(previous);
      previous = length;
    }
  });

  it("stays within its bounds even in the middle of the night", () => {
    const night = tokensFor(at(2));
    expect(night.shadowLength).toBeLessThanOrEqual(12);
    expect(night.shadowLength).toBeGreaterThanOrEqual(3);
  });
});

describe("shadow weight", () => {
  it("is hardest in full daylight and faintest at night", () => {
    expect(tokensFor(at(12)).shadowAlpha).toBeGreaterThan(tokensFor(at(2)).shadowAlpha);
  });

  it("softens through dusk", () => {
    const afternoon = tokensFor(at(15)).shadowAlpha;
    const dusk = tokensFor(at(18, 30)).shadowAlpha;
    expect(dusk).toBeLessThan(afternoon);
  });
});

describe("palette", () => {
  it("follows the sun by default", () => {
    expect(tokensFor(at(12)).scheme).toBe("light");
    expect(tokensFor(at(2)).scheme).toBe("dark");
  });

  it("can be overruled, for someone working at night in a bright room", () => {
    expect(tokensFor(at(2), { scheme: "light" }).scheme).toBe("light");
    expect(tokensFor(at(12), { scheme: "dark" }).scheme).toBe("dark");
  });

  it("switches exactly once across the day, rather than flickering", () => {
    const schemes: string[] = [];
    for (let hour = 0; hour < 24; hour += 0.25) {
      schemes.push(tokensFor(at(hour)).scheme);
    }
    let changes = 0;
    for (let i = 1; i < schemes.length; i++) {
      if (schemes[i] !== schemes[i - 1]) changes += 1;
    }
    // Dark before dawn, light during the day, dark again after dusk.
    expect(changes).toBe(2);
  });
});

describe("cssVariables", () => {
  it("emits every property the stylesheet reads", () => {
    const variables = cssVariables(tokensFor(at(10)));
    for (const name of [
      "--dn-shadow-x",
      "--dn-shadow-y",
      "--dn-shadow-length",
      "--dn-shadow-blur",
      "--dn-shadow-alpha",
      "--dn-contact-alpha",
      "--dn-light-x",
      "--dn-light-y",
      "--dn-highlight-alpha",
      "--dn-warmth",
      "--dn-daylight",
      "--dn-altitude",
      "--dn-lateral",
    ]) {
      expect(variables[name], name).toBeDefined();
    }
  });

  it("gives lengths a unit and ratios none, so calc() works", () => {
    const variables = cssVariables(tokensFor(at(10)));
    expect(variables["--dn-shadow-length"]).toMatch(/px$/);
    expect(variables["--dn-shadow-blur"]).toMatch(/px$/);
    expect(variables["--dn-shadow-x"]).not.toMatch(/px$/);
    expect(Number(variables["--dn-shadow-alpha"])).not.toBeNaN();
  });

  it("never emits NaN, at any hour or either model", () => {
    const positions: SunPosition[] = [];
    for (let hour = 0; hour < 24; hour += 0.5) positions.push(at(hour));
    for (let hour = 0; hour < 24; hour += 3) {
      positions.push(
        sunPosition(new Date(Date.UTC(2026, 11, 21, hour)), { latitude: 69.6, longitude: 18.95 }),
      );
    }
    for (const sun of positions) {
      for (const [name, value] of Object.entries(cssVariables(tokensFor(sun)))) {
        expect(value, name).not.toContain("NaN");
      }
    }
  });
});

describe("describeLight", () => {
  it("says something true about each part of the day", () => {
    expect(describeLight(at(7))).toMatch(/morning/i);
    expect(describeLight(at(17))).toMatch(/evening|afternoon/i);
    expect(describeLight(at(12))).toMatch(/high sun/i);
    expect(describeLight(at(2))).toMatch(/dark/i);
  });
});
