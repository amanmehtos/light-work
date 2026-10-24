import { describe, expect, it } from "vitest";
import {
  applyOps,
  compareOrder,
  isLive,
  type Label,
  type Op,
  type Project,
  type Section,
  type Task,
} from "@light/core";
import {
  durationFrom,
  dueFromSync,
  mapSyncExport,
  priorityFromConnector,
  priorityFromSync,
} from "../src/map.js";
import { realisticExport } from "./fixture.js";

/** Rebuilds the entity graph from the generated ops, as the server would. */
function materialise(ops: Op[]) {
  const byKind = new Map<string, Map<string, Record<string, unknown>>>();
  for (const op of ops) {
    let kind = byKind.get(op.kind);
    if (kind === undefined) {
      kind = new Map();
      byKind.set(op.kind, kind);
    }
    const existing = kind.get(op.entityId);
    const record = applyOps<Record<string, unknown>>(
      existing === undefined ? null : { value: existing, clocks: {}, deletedAt: null },
      [op],
    );
    if (isLive(record)) kind.set(op.entityId, record.value);
  }
  return <T>(kind: string): T[] =>
    [...(byKind.get(kind)?.values() ?? [])] as unknown as T[];
}

const mapped = mapSyncExport(realisticExport, { node: "test-import", now: () => 1_000_000 });
const get = materialise(mapped.ops);
const id = (kind: string, sourceId: string) => mapped.idMap[`${kind}:${sourceId}`]!;

describe("priority", () => {
  it("inverts Todoist's scale so 4 becomes the urgent p1", () => {
    expect(priorityFromSync(4).priority).toBe(1);
    expect(priorityFromSync(3).priority).toBe(2);
    expect(priorityFromSync(2).priority).toBe(3);
    expect(priorityFromSync(1).priority).toBe(4);
  });

  it("defaults a missing priority to none", () => {
    expect(priorityFromSync(undefined)).toEqual({ priority: 4, outOfRange: false });
  });

  it("flags values outside the scale instead of producing nonsense", () => {
    expect(priorityFromSync(9)).toEqual({ priority: 4, outOfRange: true });
    expect(priorityFromSync(0)).toEqual({ priority: 4, outOfRange: true });
    expect(priorityFromSync(2.5)).toEqual({ priority: 4, outOfRange: true });
  });

  it("reads the connector's already user-facing form without inverting twice", () => {
    expect(priorityFromConnector("p1").priority).toBe(1);
    expect(priorityFromConnector("p4").priority).toBe(4);
    expect(priorityFromConnector("urgent")).toEqual({ priority: 4, outOfRange: true });
  });
});

describe("dates", () => {
  it("distinguishes an all-day date from a timed one", () => {
    expect(dueFromSync({ date: "2026-10-24" })?.hasTime).toBe(false);
    expect(dueFromSync({ date: "2026-10-24T09:00:00.000000Z" })?.hasTime).toBe(true);
  });

  it("keeps the recurrence phrase, which cannot be rebuilt from the date", () => {
    const due = dueFromSync({ date: "2026-10-24T09:00:00Z", string: "every saturday at 9am", is_recurring: true });
    expect(due?.text).toBe("every saturday at 9am");
    expect(due?.isRecurring).toBe(true);
  });

  it("treats an empty due as absent", () => {
    expect(dueFromSync(null)).toBeNull();
    expect(dueFromSync({ date: "" })).toBeNull();
    expect(dueFromSync({})).toBeNull();
  });
});

describe("duration", () => {
  it("accepts the documented units", () => {
    expect(durationFrom({ amount: 90, unit: "minute" }).duration).toEqual({ amount: 90, unit: "minute" });
    expect(durationFrom({ amount: 3, unit: "day" }).duration).toEqual({ amount: 3, unit: "day" });
  });

  it("falls back to minutes and says so for anything else", () => {
    const result = durationFrom({ amount: 3, unit: "fortnight" });
    expect(result.duration).toEqual({ amount: 3, unit: "minute" });
    expect(result.unknownUnit).toBe(true);
  });

  it("ignores a zero or absent duration", () => {
    expect(durationFrom({ amount: 0, unit: "minute" }).duration).toBeNull();
    expect(durationFrom(null).duration).toBeNull();
  });
});

describe("projects", () => {
  it("carries three levels of nesting through", () => {
    const projects = get<Project>("project");
    const lightWeek = projects.find((p) => p.name.includes("Light Week"))!;
    const bisno = projects.find((p) => p.name.includes("BISNO"))!;
    const threeWm = projects.find((p) => p.name.includes("3WM"))!;

    expect(lightWeek.parentId).toBe(bisno.id);
    expect(bisno.parentId).toBe(threeWm.id);
    expect(threeWm.parentId).toBeNull();
  });

  it("keeps the inbox, favourites and archived flags", () => {
    const projects = get<Project>("project");
    expect(projects.find((p) => p.isInbox)?.name).toBe("Inbox");
    expect(projects.find((p) => p.name.includes("ARME"))?.isFavorite).toBe(true);
    expect(projects.find((p) => p.name.includes("SHEPHERD"))?.isArchived).toBe(true);
  });

  it("promotes a project whose parent is missing rather than losing it", () => {
    const orphan = get<Project>("project").find((p) => p.name === "Orphaned project")!;
    expect(orphan).toBeDefined();
    expect(orphan.parentId).toBeNull();
    expect(mapped.report.warnings.some((w) => w.code === "missing_project_parent")).toBe(true);
  });

  it("skips deleted projects", () => {
    expect(get<Project>("project").some((p) => p.name === "Deleted project")).toBe(false);
  });

  it("gives siblings ascending order keys", () => {
    const siblings = get<Project>("project")
      .filter((p) => p.parentId === null)
      .map((p) => p.order);
    expect([...siblings].sort(compareOrder)).toEqual(
      get<Project>("project").filter((p) => p.parentId === null)
        .sort((a, b) => compareOrder(a.order, b.order)).map((p) => p.order),
    );
    expect(new Set(siblings).size).toBe(siblings.length);
  });
});

describe("sections", () => {
  it("preserves the long markdown description that holds the plan", () => {
    const section = get<Section>("section").find((s) => s.name.includes("Phase 1"))!;
    expect(section.description).toContain("THE CHAIN");
    expect(section.description).toContain("MegaGrants weekend");
  });

  it("drops a section whose project is missing, with a warning", () => {
    expect(get<Section>("section").some((s) => s.name.includes("missing project"))).toBe(false);
    expect(mapped.report.warnings.some((w) => w.sourceId === "s_gone_project")).toBe(true);
  });
});

describe("tasks", () => {
  const tasks = () => get<Task>("task");

  it("keeps due and deadline as separate fields", () => {
    const deck = tasks().find((t) => t.content === "Ready publisher pitch deck")!;
    expect(deck.due).toEqual({
      date: "2026-10-24",
      hasTime: false,
      text: "24 Oct",
      timezone: null,
      isRecurring: false,
    });
    expect(deck.deadline).toEqual({ date: "2026-10-24" });
  });

  it("maps urgent to p1", () => {
    expect(tasks().find((t) => t.content === "Ready publisher pitch deck")!.priority).toBe(1);
  });

  it("keeps subtask nesting", () => {
    const sub = tasks().find((t) => t.content.includes("Competitive slide"))!;
    expect(sub.parentId).toBe(id("task", "i_deck"));
  });

  it("carries completion state and timestamp", () => {
    const done = tasks().find((t) => t.content === "Submit demo build")!;
    expect(done.isCompleted).toBe(true);
    expect(done.completedAt).toBe("2026-09-16T10:00:00.000000Z");
    expect(mapped.report.completedTasks).toBe(1);
  });

  it("promotes a subtask whose parent is gone instead of dropping it", () => {
    const orphan = tasks().find((t) => t.content === "Orphaned subtask")!;
    expect(orphan).toBeDefined();
    expect(orphan.parentId).toBeNull();
  });

  it("re-roots a task whose section is gone instead of dropping it", () => {
    const task = tasks().find((t) => t.content === "Task in a vanished section")!;
    expect(task).toBeDefined();
    expect(task.sectionId).toBeNull();
  });

  it("skips a task whose project is gone, since there is nowhere to put it", () => {
    expect(tasks().some((t) => t.content === "Task in a vanished project")).toBe(false);
    expect(mapped.report.warnings.some((w) => w.sourceId === "i_badproject")).toBe(true);
  });

  it("skips deleted tasks", () => {
    expect(tasks().some((t) => t.content === "Deleted task")).toBe(false);
  });

  it("keeps a recurrence phrase and its timezone", () => {
    const recurring = tasks().find((t) => t.content === "Log wishlists")!;
    expect(recurring.due?.isRecurring).toBe(true);
    expect(recurring.due?.text).toBe("every saturday at 9am");
    expect(recurring.due?.timezone).toBe("Asia/Bangkok");
  });

  it("orders siblings within their own container", () => {
    const inSection = tasks()
      .filter((t) => t.sectionId === id("section", "s_phase2") && t.parentId === null)
      .map((t) => t.order);
    expect(new Set(inSection).size).toBe(inSection.length);
  });
});

describe("labels", () => {
  it("mints labels that exist only as names on tasks", () => {
    // EMS and TNIGA are shared labels with no label record of their own.
    expect(mapped.report.mintedLabels.sort()).toEqual(["EMS", "TNIGA"]);
    const names = get<Label>("label").map((l) => l.name).sort();
    expect(names).toEqual(["EMS", "TNIGA", "focus", "read"]);
  });

  it("links tasks to label ids, including the minted ones", () => {
    const deck = get<Task>("task").find((t) => t.content === "Ready publisher pitch deck")!;
    const labels = get<Label>("label");
    const byId = new Map(labels.map((l) => [l.id, l.name]));
    expect(deck.labelIds.map((lid) => byId.get(lid)).sort()).toEqual(["TNIGA", "focus"]);
  });

  it("gives a minted label a stable id across runs", () => {
    const again = mapSyncExport(realisticExport, { node: "other", now: () => 2_000_000 });
    expect(again.idMap["label-name:EMS"]).toBe(mapped.idMap["label-name:EMS"]);
  });
});

describe("comments and reminders", () => {
  it("keeps task comments, project comments and attachments", () => {
    const comments = get<{ content: string; taskId: string | null; projectId: string | null; attachment: unknown }>("comment");
    expect(comments).toHaveLength(3);
    const withFile = comments.find((c) => c.content === "Deck v3")!;
    expect(withFile.attachment).toEqual({
      fileName: "deck.pdf",
      fileType: "application/pdf",
      fileUrl: "https://example.com/deck.pdf",
      fileSize: 2048,
    });
    expect(comments.find((c) => c.content === "Project-level note")!.projectId).toBe(id("project", "p_kyc"));
  });

  it("drops an orphaned comment with a warning", () => {
    expect(mapped.report.warnings.some((w) => w.code === "orphan_comment")).toBe(true);
  });

  it("maps all three reminder kinds", () => {
    const reminders = get<{ kind: string; offsetMinutes: number | null; place: { radiusMetres: number } | null; trigger: string | null }>("reminder");
    expect(reminders).toHaveLength(3);
    expect(reminders.find((r) => r.kind === "relative")!.offsetMinutes).toBe(30);
    expect(reminders.find((r) => r.kind === "absolute")!.offsetMinutes).toBeNull();
    const location = reminders.find((r) => r.kind === "location")!;
    expect(location.place?.radiusMetres).toBe(150);
    expect(location.trigger).toBe("arrive");
  });
});

describe("filters", () => {
  it("keeps saved filter queries verbatim", () => {
    const filters = get<{ name: string; query: string }>("filter");
    expect(filters.map((f) => f.query).sort()).toEqual(["assigned to: waiting", "priority 1"]);
  });
});

describe("idempotency", () => {
  it("produces the same entity ids on a second run, so re-importing does not duplicate", () => {
    const again = mapSyncExport(realisticExport, { node: "second", now: () => 9_000_000 });
    expect(again.idMap).toEqual(mapped.idMap);
  });

  it("converges to the same graph when the second run's ops are applied on top", () => {
    const again = mapSyncExport(realisticExport, { node: "second", now: () => 9_000_000 });
    const combined = materialise([...mapped.ops, ...again.ops]);
    expect(combined<Task>("task").length).toBe(get<Task>("task").length);
    expect(combined<Project>("project").length).toBe(get<Project>("project").length);
  });
});

describe("report", () => {
  it("counts what was imported", () => {
    expect(mapped.report.counts.project).toBe(8);
    expect(mapped.report.counts.section).toBe(2);
    expect(mapped.report.counts.filter).toBe(2);
    expect(mapped.report.counts.comment).toBe(3);
    expect(mapped.report.counts.reminder).toBe(3);
  });

  it("names what it could not carry over, rather than staying silent", () => {
    expect(mapped.report.unmappedFields.length).toBeGreaterThan(0);
    expect(mapped.report.warnings.length).toBeGreaterThan(0);
  });
});
