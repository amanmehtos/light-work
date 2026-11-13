import { describe, expect, it } from "vitest";
import { COLORS, DEFAULT_COLOR, colorMark } from "../src/entities.js";

describe("colorMark", () => {
  it("has a mark for every named colour", () => {
    for (const name of COLORS) {
      const mark = colorMark(name);
      expect([1, 2, 3, 4]).toContain(mark.tone);
      expect(typeof mark.filled).toBe("boolean");
    }
  });

  it("keeps charcoal and yellow visibly different", () => {
    // The case the mapping exists for: an imported account with `Work` in
    // charcoal and `Home` in yellow must not collapse to one dot.
    expect(colorMark("charcoal")).not.toEqual(colorMark("yellow"));
  });

  it("puts the darkest colours in the darkest tone and the lightest in the lightest", () => {
    expect(colorMark("berry_red").tone).toBe(1);
    expect(colorMark("yellow").tone).toBe(4);
  });

  it("uses all eight marks, so no tone or fill is wasted", () => {
    const seen = new Set(COLORS.map((name) => JSON.stringify(colorMark(name))));
    expect(seen.size).toBe(8);
  });

  it("falls back to the default colour's mark for a name it does not know", () => {
    expect(colorMark("chartreuse")).toEqual(colorMark(DEFAULT_COLOR));
    expect(colorMark("")).toEqual(colorMark(DEFAULT_COLOR));
    // Inherited object keys are not colour names either.
    expect(colorMark("constructor")).toEqual(colorMark(DEFAULT_COLOR));
  });
});
