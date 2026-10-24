/**
 * Adapter for the Todoist MCP connector's normalised shape.
 *
 * Rather than a second mapper, this converts the connector's camelCase output
 * into the Sync API shape and hands it to `mapSyncExport`. One mapper means one
 * place where priority inversion, label minting and dangling references are
 * handled, so the two paths cannot drift apart.
 *
 * This path is lower fidelity on purpose. The connector does not expose
 * reminders or `day_order`, and it flattens projects into a tree, so an account
 * imported this way loses those. Use `fetchSyncExport` with an API token when
 * fidelity matters; use this when you would rather not mint a token.
 */

import type { MapOptions, MappedImport } from "./map.js";
import { mapSyncExport } from "./map.js";
import type {
  ConnectorExport,
  ConnectorProject,
  SyncExport,
  SyncItem,
  SyncNote,
  SyncProject,
  SyncSection,
} from "./types.js";

/** Todoist's own scale, which `mapSyncExport` then inverts back. */
function toSyncPriority(priority: string | undefined): number | undefined {
  if (priority === undefined) return undefined;
  const match = /^p([1-4])$/.exec(priority.trim().toLowerCase());
  if (match === null) return undefined;
  return 5 - Number(match[1]);
}

/** The connector nests projects; the Sync API lists them flat with parent ids. */
function flattenProjects(
  projects: ConnectorProject[],
  parentId: string | null,
  outProjects: SyncProject[],
  outSections: SyncSection[],
): void {
  for (const project of projects) {
    outProjects.push({
      id: project.id,
      name: project.name,
      parent_id: project.parentId ?? parentId,
      child_order: project.childOrder ?? 0,
      ...(project.color !== undefined ? { color: project.color } : {}),
      is_favorite: project.isFavorite === true,
      is_archived: project.isArchived === true,
      inbox_project: project.isInboxProject === true,
      description: project.description ?? "",
    });
    for (const section of project.sections ?? []) {
      outSections.push({
        id: section.id,
        name: section.name,
        project_id: section.projectId ?? project.id,
        section_order: section.sectionOrder ?? 0,
        description: section.description ?? "",
      });
    }
    if (project.children !== undefined && project.children.length > 0) {
      flattenProjects(project.children, project.id, outProjects, outSections);
    }
  }
}

export function connectorToSyncExport(input: ConnectorExport): SyncExport {
  const projects: SyncProject[] = [];
  const sections: SyncSection[] = [];
  flattenProjects(input.projects ?? [], null, projects, sections);

  const items: SyncItem[] = (input.tasks ?? []).map((task) => {
    // The connector reports a timed due as `dueDatetime` and an all-day one as
    // `dueDate`; the Sync shape carries both in a single `date`.
    const date = task.dueDatetime ?? task.dueDate;
    const priority = toSyncPriority(task.priority);
    return {
      id: task.id,
      project_id: task.projectId,
      section_id: task.sectionId ?? null,
      parent_id: task.parentId ?? null,
      content: task.content,
      description: task.description ?? "",
      ...(priority !== undefined ? { priority } : {}),
      child_order: task.childOrder ?? 0,
      due:
        date === undefined
          ? null
          : {
              date,
              ...(task.dueString !== undefined ? { string: task.dueString } : {}),
              is_recurring: task.recurring === true,
            },
      deadline: task.deadlineDate === undefined ? null : { date: task.deadlineDate },
      duration: task.duration ?? null,
      labels: task.labels ?? [],
      checked: task.checked === true,
      completed_at: task.completedAt ?? null,
      ...(task.addedAt !== undefined ? { added_at: task.addedAt } : {}),
    };
  });

  const notes: SyncNote[] = (input.comments ?? []).map((comment) => ({
    id: comment.id,
    item_id: comment.taskId ?? null,
    project_id: comment.projectId ?? null,
    content: comment.content ?? "",
    ...(comment.postedAt !== undefined ? { posted_at: comment.postedAt } : {}),
  }));

  return {
    full_sync: true,
    projects,
    sections,
    items,
    notes,
    labels: (input.labels ?? []).map((label) => ({
      id: label.id,
      name: label.name,
      ...(label.color !== undefined ? { color: label.color } : {}),
      item_order: label.order ?? 0,
      is_favorite: label.isFavorite === true,
    })),
    filters: (input.filters ?? []).map((filter) => ({
      id: filter.id,
      name: filter.name,
      query: filter.query ?? "",
      ...(filter.color !== undefined ? { color: filter.color } : {}),
      item_order: filter.itemOrder ?? 0,
      is_favorite: filter.isFavorite === true,
    })),
    reminders: [],
  };
}

export function mapConnectorExport(
  input: ConnectorExport,
  options: MapOptions = {},
): MappedImport {
  const mapped = mapSyncExport(connectorToSyncExport(input), options);

  // Shared labels are names applied to tasks with no label record. The mapper
  // already mints any it sees on a task, but the connector reports them
  // separately too, so anything listed and unused still gets a home.
  const result: MappedImport = {
    ...mapped,
    report: {
      ...mapped.report,
      source: "connector",
      unmappedFields: [
        ...mapped.report.unmappedFields,
        "reminders (not exposed by the connector)",
        "day_order (not exposed by the connector)",
        "task collapsed state and assignees",
      ],
    },
  };
  return result;
}
