/**
 * Todoist -> Light Week.
 *
 * The output is a list of sync ops, not rows. An import is therefore just a
 * very large push through the ordinary sync protocol: it needs no privileged
 * write path, it converges with whatever else is happening on the account, and
 * a half-finished import can be resumed by pushing the remaining ops.
 */

import {
  Clock,
  DEFAULT_COLOR,
  type Comment,
  type Deadline,
  type Due,
  type Duration,
  type DurationUnit,
  type EntityByKind,
  type EntityKind,
  type Filter,
  type JsonObject,
  type Label,
  type Op,
  type Priority,
  type Project,
  type ProjectView,
  type Reminder,
  type Section,
  type Task,
  encodeHLC,
  keysBetween,
  newId,
} from "@light/core";
import { externalId } from "./external-id.js";
import { type ImportReport, type Warning, emptyCounts } from "./report.js";
import type {
  SyncDue,
  SyncDuration,
  SyncExport,
  SyncItem,
  SyncProject,
} from "./types.js";

const SOURCE = "todoist";

export interface MapOptions {
  /** Node id recorded on the generated ops. Defaults to a fresh importer node. */
  node?: string;
  /** Clock source, overridable in tests. */
  now?: () => number;
}

export interface MappedImport {
  ops: Op[];
  report: ImportReport;
  /** Todoist id -> Light Week id, for every entity mapped. */
  idMap: Record<string, string>;
}

/* ---------------------------------------------------------------- */
/* Field conversions                                                 */
/* ---------------------------------------------------------------- */

/**
 * Todoist's priority scale runs 1..4 with **4 meaning urgent**, the opposite of
 * the p1..p4 a user reads in the UI. Light Week stores the user-facing order, so
 * this inverts. Getting it backwards silently flips every priority in the
 * account, which is why it is a named function with a test rather than inline
 * arithmetic.
 */
export function priorityFromSync(value: number | undefined): {
  priority: Priority;
  outOfRange: boolean;
} {
  if (value === undefined) return { priority: 4, outOfRange: false };
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    return { priority: 4, outOfRange: true };
  }
  return { priority: (5 - value) as Priority, outOfRange: false };
}

/** The connector reports priority as the user-facing `"p1"`..`"p4"`. */
export function priorityFromConnector(value: string | undefined): {
  priority: Priority;
  outOfRange: boolean;
} {
  if (value === undefined) return { priority: 4, outOfRange: false };
  const match = /^p([1-4])$/.exec(value.trim().toLowerCase());
  if (match === null) return { priority: 4, outOfRange: true };
  return { priority: Number(match[1]) as Priority, outOfRange: false };
}

export function dueFromSync(due: SyncDue | null | undefined): Due | null {
  if (due == null) return null;
  const date = due.date;
  if (typeof date !== "string" || date === "") return null;
  return {
    date,
    // Todoist signals a timed task by including a time component in `date`.
    hasTime: date.includes("T"),
    text: typeof due.string === "string" && due.string !== "" ? due.string : null,
    timezone: typeof due.timezone === "string" && due.timezone !== "" ? due.timezone : null,
    isRecurring: due.is_recurring === true,
  };
}

export function deadlineFromDate(date: string | null | undefined): Deadline | null {
  if (typeof date !== "string" || date === "") return null;
  return { date };
}

export function durationFrom(
  duration: SyncDuration | null | undefined,
): { duration: Duration | null; unknownUnit: boolean } {
  if (duration == null || typeof duration.amount !== "number" || duration.amount <= 0) {
    return { duration: null, unknownUnit: false };
  }
  const raw = (duration.unit ?? "minute").toLowerCase();
  let unit: DurationUnit;
  let unknownUnit = false;
  if (raw === "minute" || raw === "minutes" || raw === "min") unit = "minute";
  else if (raw === "day" || raw === "days") unit = "day";
  else {
    unit = "minute";
    unknownUnit = true;
  }
  return { duration: { amount: duration.amount, unit }, unknownUnit };
}

function viewFrom(style: string | undefined): ProjectView {
  if (style === "board") return "board";
  if (style === "calendar") return "calendar";
  return "list";
}

function colorFrom(color: string | undefined): string {
  return color !== undefined && color !== "" ? color : DEFAULT_COLOR;
}

/* ---------------------------------------------------------------- */
/* Ordering                                                          */
/* ---------------------------------------------------------------- */

/**
 * Converts Todoist's integer `child_order` into fractional index keys, grouped
 * by container so that siblings get keys relative to each other.
 *
 * Order is assigned by position after sorting, not by the integer itself:
 * Todoist's orders are frequently sparse or duplicated across an old account,
 * and a stable sort on (order, id) gives a deterministic result either way.
 */
function assignOrders<T>(
  items: T[],
  containerOf: (item: T) => string,
  orderOf: (item: T) => number,
  idOf: (item: T) => string,
): Map<string, string> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = containerOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }

  const result = new Map<string, string>();
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const delta = orderOf(a) - orderOf(b);
      if (delta !== 0) return delta;
      return idOf(a) < idOf(b) ? -1 : 1;
    });
    const keys = keysBetween(null, null, group.length);
    group.forEach((item, index) => {
      result.set(idOf(item), keys[index]!);
    });
  }
  return result;
}

/* ---------------------------------------------------------------- */
/* The mapper                                                        */
/* ---------------------------------------------------------------- */

class OpBuilder {
  readonly ops: Op[] = [];
  readonly counts = emptyCounts();
  private readonly clock: Clock;

  constructor(
    private readonly node: string,
    now: () => number,
  ) {
    this.clock = new Clock(node, now);
  }

  /** Generic over the kind so a Task cannot be filed as a Project. */
  upsert<K extends EntityKind>(kind: K, entityId: string, row: EntityByKind[K]): void {
    this.ops.push({
      id: newId(),
      kind,
      entityId,
      type: "upsert",
      fields: { ...row } as unknown as JsonObject,
      clock: encodeHLC(this.clock.next()),
      node: this.node,
    });
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
  }
}

export function mapSyncExport(
  input: SyncExport,
  options: MapOptions = {},
): MappedImport {
  const node = options.node ?? `import-${newId().slice(-8)}`;
  const builder = new OpBuilder(node, options.now ?? Date.now);
  const warnings: Warning[] = [];
  const idMap: Record<string, string> = {};

  const id = (kind: string, sourceId: string): string => {
    const mapped = externalId(SOURCE, kind, sourceId);
    idMap[`${kind}:${sourceId}`] = mapped;
    return mapped;
  };

  const live = <T extends { is_deleted?: boolean }>(rows: T[] | undefined): T[] =>
    (rows ?? []).filter((row) => row.is_deleted !== true);

  /* -- projects ------------------------------------------------- */
  const projects = live(input.projects);
  const projectIds = new Set(projects.map((p) => p.id));

  // Resolve parents *before* assigning order keys. A project whose parent is
  // missing is promoted to the top level, which moves it into a different
  // sibling group — ordering it against its original group would hand it a key
  // that collides with a genuine top-level sibling.
  const resolvedParent = new Map<string, string | null>();
  for (const project of projects) {
    const parent = project.parent_id;
    if (parent == null || parent === "") {
      resolvedParent.set(project.id, null);
      continue;
    }
    if (projectIds.has(parent)) {
      resolvedParent.set(project.id, parent);
      continue;
    }
    resolvedParent.set(project.id, null);
    warnings.push({
      code: "missing_project_parent",
      sourceId: project.id,
      detail: `parent ${parent} is absent from the export; moved to the top level`,
    });
  }

  const projectOrders = assignOrders(
    projects,
    (p: SyncProject) => resolvedParent.get(p.id) ?? "__root",
    (p) => p.child_order ?? 0,
    (p) => p.id,
  );

  for (const project of projects) {
    const parentSourceId = resolvedParent.get(project.id) ?? null;
    const row: Project = {
      id: id("project", project.id),
      parentId: parentSourceId === null ? null : id("project", parentSourceId),
      name: project.name,
      color: colorFrom(project.color),
      order: projectOrders.get(project.id) ?? "V",
      view: viewFrom(project.view_style),
      isFavorite: project.is_favorite === true,
      isArchived: project.is_archived === true,
      isInbox: project.inbox_project === true,
      isCollapsed: project.collapsed === true,
      description: project.description ?? "",
    };
    builder.upsert("project", row.id, row);
  }

  /* -- sections ------------------------------------------------- */
  const sections = live(input.sections).filter((section) => {
    if (projectIds.has(section.project_id)) return true;
    warnings.push({
      code: "missing_task_project",
      sourceId: section.id,
      detail: `section's project ${section.project_id} is absent; section skipped`,
    });
    return false;
  });
  const sectionIds = new Set(sections.map((s) => s.id));
  const sectionOrders = assignOrders(
    sections,
    (s) => s.project_id,
    (s) => s.section_order ?? 0,
    (s) => s.id,
  );

  for (const section of sections) {
    const row: Section = {
      id: id("section", section.id),
      projectId: id("project", section.project_id),
      name: section.name,
      // Several of these hold the actual plan, in markdown. Must survive.
      description: section.description ?? "",
      order: sectionOrders.get(section.id) ?? "V",
      isArchived: section.is_archived === true,
      isCollapsed: section.collapsed === true,
    };
    builder.upsert("section", row.id, row);
  }

  /* -- labels --------------------------------------------------- */
  const labelRecords = live(input.labels);
  const labelIdByName = new Map<string, string>();
  const labelOrders = assignOrders(
    labelRecords,
    () => "__all",
    (l) => l.item_order ?? 0,
    (l) => l.id,
  );

  for (const label of labelRecords) {
    const row: Label = {
      id: id("label", label.id),
      name: label.name,
      color: colorFrom(label.color),
      order: labelOrders.get(label.id) ?? "V",
      isFavorite: label.is_favorite === true,
    };
    labelIdByName.set(label.name, row.id);
    builder.upsert("label", row.id, row);
  }

  // Tasks carry label *names*. A shared label applied to a task has no label
  // record of its own, so any name not already known has to be minted here or
  // the tag is silently lost on import.
  const mintedLabels: string[] = [];
  const mintLabel = (name: string): string => {
    const existing = labelIdByName.get(name);
    if (existing !== undefined) return existing;
    const row: Label = {
      id: externalId(SOURCE, "label-name", name),
      name,
      color: DEFAULT_COLOR,
      order: "V",
      isFavorite: false,
    };
    labelIdByName.set(name, row.id);
    mintedLabels.push(name);
    idMap[`label-name:${name}`] = row.id;
    builder.upsert("label", row.id, row);
    warnings.push({
      code: "label_minted_from_task",
      sourceId: name,
      detail: `label "${name}" appears on tasks but has no label record; created it`,
    });
    return row.id;
  };

  /* -- tasks ---------------------------------------------------- */
  const items = live(input.items).filter((item) => {
    if (projectIds.has(item.project_id)) return true;
    warnings.push({
      code: "missing_task_project",
      sourceId: item.id,
      detail: `task's project ${item.project_id} is absent; task skipped`,
    });
    return false;
  });
  const itemIds = new Set(items.map((i) => i.id));

  // Group siblings by their real container so ordering is relative to the list
  // the task actually appears in.
  const containerOf = (item: SyncItem): string => {
    if (item.parent_id != null && itemIds.has(item.parent_id)) return `t:${item.parent_id}`;
    if (item.section_id != null && sectionIds.has(item.section_id)) return `s:${item.section_id}`;
    return `p:${item.project_id}`;
  };
  const itemOrders = assignOrders(items, containerOf, (i) => i.child_order ?? 0, (i) => i.id);
  const dayOrders = assignOrders(
    items.filter((i) => typeof i.day_order === "number" && i.day_order >= 0),
    () => "__day",
    (i) => i.day_order ?? 0,
    (i) => i.id,
  );

  let completedTasks = 0;
  for (const item of items) {
    let parentId: string | null = null;
    if (item.parent_id != null && item.parent_id !== "") {
      if (itemIds.has(item.parent_id)) {
        parentId = id("task", item.parent_id);
      } else {
        // Usually an archived or completed parent. Promote rather than drop.
        warnings.push({
          code: "missing_task_parent",
          sourceId: item.id,
          detail: `parent task ${item.parent_id} is absent; promoted to the project root`,
        });
      }
    }

    let sectionId: string | null = null;
    if (item.section_id != null && item.section_id !== "") {
      if (sectionIds.has(item.section_id)) {
        sectionId = id("section", item.section_id);
      } else {
        warnings.push({
          code: "missing_section",
          sourceId: item.id,
          detail: `section ${item.section_id} is absent; task placed at the project root`,
        });
      }
    }

    const { priority, outOfRange } = priorityFromSync(item.priority);
    if (outOfRange) {
      warnings.push({
        code: "priority_out_of_range",
        sourceId: item.id,
        detail: `priority ${String(item.priority)} is outside 1..4; defaulted to p4`,
      });
    }

    const { duration, unknownUnit } = durationFrom(item.duration);
    if (unknownUnit) {
      warnings.push({
        code: "unknown_duration_unit",
        sourceId: item.id,
        detail: `duration unit ${String(item.duration?.unit)} not recognised; read as minutes`,
      });
    }

    const isCompleted = item.checked === true;
    if (isCompleted) completedTasks += 1;

    const row: Task = {
      id: id("task", item.id),
      projectId: id("project", item.project_id),
      sectionId,
      parentId,
      content: item.content,
      description: item.description ?? "",
      priority,
      order: itemOrders.get(item.id) ?? "V",
      dayOrder: dayOrders.get(item.id) ?? null,
      due: dueFromSync(item.due),
      deadline: deadlineFromDate(item.deadline?.date),
      duration,
      labelIds: (item.labels ?? []).map(mintLabel),
      isCompleted,
      completedAt: item.completed_at ?? null,
      isCollapsed: item.collapsed === true,
      assigneeId: item.responsible_uid ?? null,
      addedById: item.added_by_uid ?? null,
      createdAt: item.added_at ?? new Date(0).toISOString(),
    };
    builder.upsert("task", row.id, row);
  }

  /* -- comments ------------------------------------------------- */
  for (const note of live(input.notes)) {
    const onTask = note.item_id != null && itemIds.has(note.item_id);
    const onProject = note.project_id != null && projectIds.has(note.project_id);
    if (!onTask && !onProject) {
      warnings.push({
        code: "orphan_comment",
        sourceId: note.id,
        detail: "comment's task and project are both absent; skipped",
      });
      continue;
    }
    const attachment = note.file_attachment;
    const row: Comment = {
      id: id("comment", note.id),
      taskId: onTask ? id("task", note.item_id!) : null,
      projectId: !onTask && onProject ? id("project", note.project_id!) : null,
      content: note.content ?? "",
      attachment:
        attachment != null && typeof attachment.file_url === "string"
          ? {
              fileName: attachment.file_name ?? "",
              fileType: attachment.file_type ?? "",
              fileUrl: attachment.file_url,
              fileSize: attachment.file_size ?? null,
            }
          : null,
      postedById: note.posted_uid ?? null,
      postedAt: note.posted_at ?? new Date(0).toISOString(),
    };
    builder.upsert("comment", row.id, row);
  }

  /* -- reminders ------------------------------------------------ */
  for (const reminder of live(input.reminders)) {
    if (!itemIds.has(reminder.item_id)) {
      warnings.push({
        code: "unsupported_reminder",
        sourceId: reminder.id,
        detail: `reminder's task ${reminder.item_id} is absent; skipped`,
      });
      continue;
    }
    const kind =
      reminder.type === "absolute" ? "absolute" : reminder.type === "location" ? "location" : "relative";
    const latitude = Number(reminder.loc_lat ?? Number.NaN);
    const longitude = Number(reminder.loc_long ?? Number.NaN);
    const hasPlace = Number.isFinite(latitude) && Number.isFinite(longitude);
    const row: Reminder = {
      id: id("reminder", reminder.id),
      taskId: id("task", reminder.item_id),
      kind,
      offsetMinutes: kind === "relative" ? (reminder.minute_offset ?? 0) : null,
      fireAt: kind === "absolute" ? (reminder.due?.date ?? null) : null,
      place:
        kind === "location" && hasPlace
          ? {
              name: reminder.name ?? "",
              latitude,
              longitude,
              radiusMetres: reminder.radius ?? 100,
            }
          : null,
      trigger: kind === "location" ? (reminder.loc_trigger === "on_leave" ? "leave" : "arrive") : null,
    };
    builder.upsert("reminder", row.id, row);
  }

  /* -- filters -------------------------------------------------- */
  const filters = live(input.filters);
  const filterOrders = assignOrders(filters, () => "__all", (f) => f.item_order ?? 0, (f) => f.id);
  for (const filter of filters) {
    const row: Filter = {
      id: id("filter", filter.id),
      name: filter.name,
      query: filter.query ?? "",
      color: colorFrom(filter.color),
      order: filterOrders.get(filter.id) ?? "V",
      isFavorite: filter.is_favorite === true,
    };
    builder.upsert("filter", row.id, row);
  }

  return {
    ops: builder.ops,
    idMap,
    report: {
      source: "sync-api",
      counts: builder.counts,
      completedTasks,
      mintedLabels,
      warnings,
      unmappedFields: [
        "project.is_shared and collaborators (sharing is not implemented yet)",
        "item.note_count (derived, recomputed from comments)",
        "user settings, karma and goals",
        "activity history",
      ],
    },
  };
}
