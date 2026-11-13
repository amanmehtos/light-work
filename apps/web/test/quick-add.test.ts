import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "@light/client-sdk";
import { chipLabel, chipTitle, dayLabel, reconcileDismissed } from "../src/quick-add.js";

const TODAY = "2026-11-11"; // a Wednesday
const read = (text: string) => parseQuickAdd(text, { today: TODAY, projects: [{ id: "h", name: "Home" }] });

describe("dayLabel", () => {
  it("says today and tomorrow in words", () => {
    expect(dayLabel("2026-11-11", TODAY)).toBe("today");
    expect(dayLabel("2026-11-12", TODAY)).toBe("tomorrow");
  });

  it("names the weekday, so 'friday' reads back as which Friday", () => {
    // Pinned to en-US-ish shape by pattern rather than by locale, because the
    // test machine's locale is not the point.
    const label = dayLabel("2026-11-13", TODAY);
    expect(label).toMatch(/Fri/);
    expect(label).toMatch(/13/);
  });

  it("is not moved by the machine's time zone", () => {
    // A bare calendar day read in local time would be the 12th west of
    // Greenwich. 2026-11-13 must stay the 13th.
    expect(dayLabel("2026-11-13", TODAY)).toMatch(/13/);
    expect(dayLabel("2026-11-13", TODAY)).not.toMatch(/\b12\b/);
  });

  it("adds the year only when it is not this one", () => {
    expect(dayLabel("2027-01-05", TODAY)).toMatch(/2027/);
    expect(dayLabel("2026-12-05", TODAY)).not.toMatch(/2026/);
  });
});

describe("chipLabel", () => {
  const parse = read("pay rent tomorrow 9am p1 @errand #Home // note");
  const label = (kind: string) => chipLabel(parse.tokens.find((token) => token.kind === kind)!, TODAY);

  it("says each token the way the person would", () => {
    expect(label("date")).toBe("tomorrow");
    expect(label("time")).toBe("09:00");
    expect(label("priority")).toBe("p1");
    expect(label("label")).toBe("@errand");
    expect(label("project")).toBe("#Home");
    expect(label("description")).toBe("notes");
  });

  it("shows a repeat as it was typed", () => {
    const repeat = read("standup every weekday").tokens[0]!;
    expect(chipLabel(repeat, TODAY)).toBe("every weekday");
  });
});

describe("chipTitle", () => {
  it("says what the chip is and how to take it back", () => {
    const token = read("call mum tomorrow").tokens[0]!;
    expect(chipTitle(token)).toContain("due 2026-11-12");
    expect(chipTitle(token)).toContain('"tomorrow"');
  });

  it("leads with the assumption when there was one", () => {
    const token = read("plan next week").tokens[0]!;
    expect(chipTitle(token)).toMatch(/^"next week" does not say which day/);
  });
});

describe("reconcileDismissed", () => {
  const tomorrow = { start: 13, text: "tomorrow" };

  it("keeps a dismissal while the text around it changes", () => {
    // Typing at the end, and typing at the front, which moves it along.
    expect(reconcileDismissed("book flights tomorrow", "book flights tomorrow now", [tomorrow])).toEqual([tomorrow]);
    expect(reconcileDismissed("book flights tomorrow", "please book flights tomorrow", [tomorrow])).toEqual([
      { start: 20, text: "tomorrow" },
    ]);
  });

  it("follows the text when something before it is deleted", () => {
    expect(reconcileDismissed("book flights tomorrow", "flights tomorrow", [tomorrow])).toEqual([
      { start: 8, text: "tomorrow" },
    ]);
  });

  it("drops it once the text has been edited", () => {
    expect(reconcileDismissed("book flights tomorrow", "book flights tomorro", [tomorrow])).toEqual([]);
    expect(reconcileDismissed("book flights tomorrow", "book flights", [tomorrow])).toEqual([]);
  });

  it("drops it when the whole line is replaced by one that says the same word", () => {
    // The case a remembered-text check gets wrong: this is a new "tomorrow".
    expect(reconcileDismissed("book flights tomorrow", "pay rent tomorrow 9am", [tomorrow])).toEqual([]);
  });

  it("changes nothing when the line did not change", () => {
    expect(reconcileDismissed("a tomorrow", "a tomorrow", [{ start: 2, text: "tomorrow" }])).toEqual([
      { start: 2, text: "tomorrow" },
    ]);
  });

  it("does not let a repeated character confuse the front and back of an edit", () => {
    expect(reconcileDismissed("aaa tomorrow", "aa tomorrow", [{ start: 4, text: "tomorrow" }])).toEqual([
      { start: 3, text: "tomorrow" },
    ]);
  });

  it("keeps the ones the edit missed and drops the ones it hit", () => {
    const both = [
      { start: 0, text: "p1" },
      { start: 5, text: "tomorrow" },
    ];
    expect(reconcileDismissed("p1 a tomorrow", "p1 a tomorroX", both)).toEqual([{ start: 0, text: "p1" }]);
  });
});
