import { describe, expect, it } from "vitest";
import { parseEntry } from "../src/components/AddTask.js";

/**
 * The add-task shorthand. Worth testing on its own because it is the one piece
 * of the UI with real logic in it, and because getting the stripping wrong
 * leaves "p1" sitting in the middle of someone's task title.
 */
describe("parseEntry", () => {
  it("keeps a plain line as-is", () => {
    expect(parseEntry("Ready publisher pitch deck")).toEqual({
      content: "Ready publisher pitch deck",
      priority: 4,
      labels: [],
      description: "",
    });
  });

  it("reads a priority and removes it from the title", () => {
    const result = parseEntry("Ready pitch deck p1");
    expect(result.priority).toBe(1);
    expect(result.content).toBe("Ready pitch deck");
  });

  it("reads a priority anywhere in the line", () => {
    expect(parseEntry("p2 Send the build").content).toBe("Send the build");
    expect(parseEntry("Send p3 the build").content).toBe("Send the build");
  });

  it("is case-insensitive about the priority", () => {
    expect(parseEntry("Fix it P1").priority).toBe(1);
  });

  it("ignores a priority-looking word that is part of the title", () => {
    // "p5" is not a priority, and "sp1" is not either.
    expect(parseEntry("Check p5 compliance").content).toBe("Check p5 compliance");
    expect(parseEntry("Deploy sp1 cluster").content).toBe("Deploy sp1 cluster");
    expect(parseEntry("Check p5 compliance").priority).toBe(4);
  });

  it("reads labels and removes them from the title", () => {
    const result = parseEntry("Write the deck @focus @deep");
    expect(result.labels).toEqual(["focus", "deep"]);
    expect(result.content).toBe("Write the deck");
  });

  it("does not repeat a label given twice", () => {
    expect(parseEntry("Task @focus @focus").labels).toEqual(["focus"]);
  });

  it("splits a description off after //", () => {
    const result = parseEntry("Ready pitch deck // lead with the economics");
    expect(result.content).toBe("Ready pitch deck");
    expect(result.description).toBe("lead with the economics");
  });

  it("leaves shorthand inside the description alone", () => {
    const result = parseEntry("Ready deck p1 // mention p2 pricing @later");
    expect(result.priority).toBe(1);
    expect(result.labels).toEqual([]);
    expect(result.description).toBe("mention p2 pricing @later");
  });

  it("handles everything at once", () => {
    const result = parseEntry("Ready publisher pitch deck p1 @focus // lead with economics");
    expect(result).toEqual({
      content: "Ready publisher pitch deck",
      priority: 1,
      labels: ["focus"],
      description: "lead with economics",
    });
  });

  it("collapses the whitespace left behind", () => {
    expect(parseEntry("Ready  p1  @focus  deck").content).toBe("Ready deck");
  });

  it("treats a line of only shorthand as empty, so it cannot be submitted", () => {
    expect(parseEntry("p1 @focus").content).toBe("");
    expect(parseEntry("   ").content).toBe("");
  });
});
