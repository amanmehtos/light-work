import { describe, expect, it } from "vitest";
import type { Task } from "@light/core";
import { focusLink } from "../src/components/TaskRow.js";

/**
 * The hand-off to Light Minute. Worth testing on its own because it is a string
 * crossing an application boundary: the only thing that tells us the encoding is
 * right is reading it back the way the other end does, and a title with an
 * ampersand or a slash in it is exactly where that goes wrong.
 */
function taskWith(fields: Partial<Task>): Task {
  return {
    id: "6cfX2v",
    projectId: "2349",
    sectionId: null,
    parentId: null,
    content: "Ready the deck",
    description: "",
    priority: 4,
    order: "a0",
    dayOrder: null,
    due: null,
    deadline: null,
    duration: null,
    labelIds: [],
    isCompleted: false,
    completedAt: null,
    isCollapsed: false,
    assigneeId: null,
    addedById: null,
    createdAt: "2026-10-28T09:00:00Z",
    ...fields,
  };
}

/** Reads the link the way BoundTask.swift does, so a test failure is a real one. */
function query(link: string): Record<string, string> {
  const url = new URL(link);
  expect(url.protocol).toBe("com.lightminute.app:");
  expect(url.pathname).toBe("/focus");
  return Object.fromEntries(new URLSearchParams(url.search));
}

describe("focusLink", () => {
  it("carries the task, its project and a planned length", () => {
    const link = focusLink(
      taskWith({ duration: { amount: 45, unit: "minute" } }),
      "Publisher pitch",
    );

    expect(link).toBe(
      "com.lightminute.app:/focus?taskId=6cfX2v&title=Ready%20the%20deck" +
        "&projectName=Publisher%20pitch&projectId=2349&planned=2700",
    );
  });

  it("survives an ampersand and a slash in the title", () => {
    const task = taskWith({ content: "Sales & marketing: Q3/Q4 plan" });

    expect(query(focusLink(task, "Books & bits"))).toEqual({
      taskId: "6cfX2v",
      title: "Sales & marketing: Q3/Q4 plan",
      projectName: "Books & bits",
      projectId: "2349",
      planned: "1500",
    });
  });

  it("spells a space %20, not +", () => {
    // URLComponents, at the other end, leaves a "+" standing as a "+".
    expect(focusLink(taskWith({}), null)).not.toContain("+");
  });

  it("leaves the project name out when there isn't one", () => {
    expect(query(focusLink(taskWith({}), null))).not.toHaveProperty("projectName");
  });

  it("does not offer a day-long estimate as a focus length", () => {
    const task = taskWith({ duration: { amount: 2, unit: "day" } });
    expect(query(focusLink(task, null)).planned).toBe("1500");
  });
});
