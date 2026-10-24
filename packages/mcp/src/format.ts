/**
 * Turning entities into what an agent reads.
 *
 * Tools return ids alongside names because an agent needs the id to act and the
 * name to reason, and label ids are resolved to names because an agent asked to
 * "find my focus tasks" cannot be expected to join two tables first.
 *
 * Durations are given in both seconds and a human form for the same reason: one
 * is for arithmetic, the other for explaining itself back to the user.
 */

import type { Label, Project, Section, Task } from "@light/core";
import type { ToolContext } from "./context.js";

export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function projectPath(store: ToolContext["store"], projectId: string): string {
  const names: string[] = [];
  let current: Project | null = store.get("project", projectId);
  let guard = 0;
  while (current !== null && guard < 20) {
    names.unshift(current.name);
    current = current.parentId === null ? null : store.get("project", current.parentId);
    guard += 1;
  }
  return names.join(" / ");
}

export function formatTask(context: ToolContext, task: Task) {
  const labels = task.labelIds
    .map((id) => context.store.get("label", id))
    .filter((label): label is Label => label !== null)
    .map((label) => label.name);

  const section: Section | null =
    task.sectionId === null ? null : context.store.get("section", task.sectionId);
  const focus = context.ops.focusStatsForTask(task.id);

  return {
    id: task.id,
    content: task.content,
    description: task.description === "" ? undefined : task.description,
    project: { id: task.projectId, path: projectPath(context.store, task.projectId) },
    section: section === null ? undefined : { id: section.id, name: section.name },
    parentId: task.parentId ?? undefined,
    priority: task.priority,
    priorityLabel: `p${task.priority}`,
    due: task.due === null ? undefined : {
      date: task.due.date,
      recurring: task.due.isRecurring,
      phrase: task.due.text ?? undefined,
    },
    // Kept distinct from `due` on purpose: when you plan to work on it is not
    // the same question as when it is owed.
    deadline: task.deadline?.date,
    duration: task.duration ?? undefined,
    labels,
    completed: task.isCompleted,
    focus: focus.sessions === 0 ? undefined : {
      sessions: focus.sessions,
      focusedSeconds: focus.focusedSeconds,
      focused: humanDuration(focus.focusedSeconds),
      interruptions: focus.interruptions,
      lastSessionAt: focus.lastSessionAt ?? undefined,
    },
  };
}

export function formatProject(store: ToolContext["store"], project: Project) {
  return {
    id: project.id,
    name: project.name,
    path: projectPath(store, project.id),
    parentId: project.parentId ?? undefined,
    isFavorite: project.isFavorite || undefined,
    isArchived: project.isArchived || undefined,
    isInbox: project.isInbox || undefined,
    openTasks: store.all("task").filter((t) => t.projectId === project.id && !t.isCompleted).length,
  };
}

/** Wraps a payload in the content shape MCP expects, plus the structured form. */
export function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

export function failure(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
