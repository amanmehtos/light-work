import { describe, expect, it } from "vitest";
import type { Label, Project, Section, Task } from "@light/core";
import { applyOps, isLive, type Op } from "@light/core";
import { connectorToSyncExport, mapConnectorExport } from "../src/connector.js";
import type { ConnectorExport } from "../src/types.js";

/**
 * Copied from what the Todoist MCP connector actually returned for the account
 * this was built against, trimmed to the interesting parts: three levels of
 * nesting, a section whose description carries the plan, a task with a deadline
 * distinct from its due date, and shared labels with no label record.
 */
const connectorExport: ConnectorExport = {
  projects: [
    {
      id: "6cpmhrPpX5ghVqH8",
      name: "🔬 3WM 🏆 Assets",
      childOrder: 38,
      sections: [{ id: "6cqfFVGjQ7VpVhf8", name: "[BISNO]Prototype 0 - Sipper", sectionOrder: 2 }],
      children: [
        {
          id: "6fJp34cQvF4wr6Mx",
          name: "💵 BISNO 🏆 LEASY SF",
          parentId: "6cpmhrPpX5ghVqH8",
          childOrder: 40,
          sections: [
            { id: "6hJgMmVgW9xC8R3Q", name: "💻 Software Pipeline", sectionOrder: 1 },
            { id: "6hJgMmc65qfMxwPQ", name: "🔧 Hardware Pipeline", sectionOrder: 1 },
          ],
          children: [
            {
              id: "6WMgW8HhWQ3Wrphx",
              name: "❓ Develop Light Week🏆❓",
              parentId: "6fJp34cQvF4wr6Mx",
              childOrder: 46,
              sections: [],
              children: [],
            },
            {
              id: "6W2GWQ96522FC4GR",
              name: "❓ Develop Light Minute with Dock 🏆 ❓",
              parentId: "6fJp34cQvF4wr6Mx",
              childOrder: 44,
              sections: [],
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: "6WXf7v7R8F53Qq4F",
      name: "📍 Develop KYC🏆 MEHTOS 247 SF",
      childOrder: 16,
      sections: [
        {
          id: "6gqWxVc5JvVwhR3m",
          name: "📊 Phase 2 — VALIDATE DEMAND (Sep 22 → Nov 15)",
          sectionOrder: 3,
          description:
            "The demo is live. Now find out whether anyone wants this — and build Night Two while you wait for the answer.",
        },
      ],
      children: [],
    },
  ],
  tasks: [
    {
      id: "6gqWxhPwj2Q9jFGm",
      content: "Ready publisher pitch deck",
      description: "Needed for BOTH applications on the Aug 29-30 weekend — write it before, not during.",
      dueDate: "2026-10-24",
      recurring: false,
      deadlineDate: "2026-10-24",
      priority: "p1",
      projectId: "6WXf7v7R8F53Qq4F",
      sectionId: "6gqWxVc5JvVwhR3m",
      labels: ["TNIGA"],
      checked: false,
      addedAt: "2026-06-10T05:00:31.705Z",
    },
    {
      id: "6gqWxh8HVc4JgG4m",
      content: "Send early-look build + deck to Perp Games (warm exclusive)",
      recurring: false,
      priority: "p4",
      projectId: "6WXf7v7R8F53Qq4F",
      sectionId: "6gqWxVc5JvVwhR3m",
      labels: [],
      checked: false,
      addedAt: "2026-06-10T05:00:28.427Z",
    },
    {
      id: "6hFP8prFm8qhhQqm",
      content: "Night One + Two — fixing & testing (Nov 5 → Nov 15)",
      dueDate: "2026-11-05",
      deadlineDate: "2026-11-15",
      priority: "p1",
      projectId: "6WXf7v7R8F53Qq4F",
      labels: ["EMS"],
      checked: false,
    },
  ],
  labels: [
    { id: "2181960624", name: "focus", color: "charcoal", order: 5 },
    { id: "2162225020", name: "read", color: "charcoal", order: 1 },
  ],
  sharedLabels: ["EMS", "Habit", "TNIGA", "read", "ready", "watch"],
  filters: [
    { id: "2331437530", name: "Waiting For", query: "assigned to: waiting", itemOrder: 1 },
    { id: "2331437531", name: "Priority 1", query: "priority 1", itemOrder: 2 },
  ],
};

function materialise(ops: Op[]) {
  const byKind = new Map<string, Map<string, Record<string, unknown>>>();
  for (const op of ops) {
    let kind = byKind.get(op.kind);
    if (kind === undefined) {
      kind = new Map();
      byKind.set(op.kind, kind);
    }
    const record = applyOps<Record<string, unknown>>(null, [op]);
    if (isLive(record)) kind.set(op.entityId, record.value);
  }
  return <T>(kind: string): T[] => [...(byKind.get(kind)?.values() ?? [])] as unknown as T[];
}

const mapped = mapConnectorExport(connectorExport, { node: "test", now: () => 1_000 });
const get = materialise(mapped.ops);

describe("connectorToSyncExport", () => {
  it("flattens the project tree into parent ids", () => {
    const flat = connectorToSyncExport(connectorExport);
    expect(flat.projects).toHaveLength(5);
    const lightWeek = flat.projects!.find((p) => p.name.includes("Light Week"))!;
    expect(lightWeek.parent_id).toBe("6fJp34cQvF4wr6Mx");
  });

  it("lifts sections out of their nested projects", () => {
    const flat = connectorToSyncExport(connectorExport);
    expect(flat.sections).toHaveLength(4);
    expect(flat.sections!.map((s) => s.project_id)).toContain("6fJp34cQvF4wr6Mx");
  });

  it("does not invert priority twice", () => {
    const flat = connectorToSyncExport(connectorExport);
    const deck = flat.items!.find((i) => i.content === "Ready publisher pitch deck")!;
    // p1 is urgent, which is 4 on Todoist's internal scale.
    expect(deck.priority).toBe(4);
  });
});

describe("mapConnectorExport", () => {
  it("reconstructs the Light Suite project chain", () => {
    const projects = get<Project>("project");
    const byName = new Map(projects.map((p) => [p.name, p]));
    const lightWeek = byName.get("❓ Develop Light Week🏆❓")!;
    const bisno = byName.get("💵 BISNO 🏆 LEASY SF")!;
    const threeWm = byName.get("🔬 3WM 🏆 Assets")!;

    expect(lightWeek.parentId).toBe(bisno.id);
    expect(bisno.parentId).toBe(threeWm.id);
    expect(threeWm.parentId).toBeNull();
  });

  it("keeps emoji in names intact", () => {
    expect(get<Project>("project").some((p) => p.name === "❓ Develop Light Minute with Dock 🏆 ❓")).toBe(true);
  });

  it("keeps a section description", () => {
    const section = get<Section>("section").find((s) => s.name.includes("Phase 2"))!;
    expect(section.description).toContain("The demo is live");
  });

  it("round-trips p1 back to p1", () => {
    const deck = get<Task>("task").find((t) => t.content === "Ready publisher pitch deck")!;
    expect(deck.priority).toBe(1);
  });

  it("keeps a due date distinct from a later deadline", () => {
    const task = get<Task>("task").find((t) => t.content.startsWith("Night One + Two"))!;
    expect(task.due?.date).toBe("2026-11-05");
    expect(task.deadline?.date).toBe("2026-11-15");
  });

  it("mints the shared labels that tasks actually use", () => {
    expect(mapped.report.mintedLabels.sort()).toEqual(["EMS", "TNIGA"]);
    const names = get<Label>("label").map((l) => l.name).sort();
    expect(names).toEqual(["EMS", "TNIGA", "focus", "read"]);
  });

  it("is honest in its report about what this path cannot carry", () => {
    expect(mapped.report.source).toBe("connector");
    expect(mapped.report.unmappedFields.join(" ")).toContain("reminders");
  });

  it("maps two sections that share a sectionOrder without colliding", () => {
    const pipelines = get<Section>("section").filter((s) => s.name.includes("Pipeline"));
    expect(pipelines).toHaveLength(2);
    expect(pipelines[0]!.order).not.toBe(pipelines[1]!.order);
  });
});
