/**
 * What a flat list does with subtasks.
 *
 * Today, Upcoming and All are filters over every open task, and a filter has no
 * idea that one task belongs to another. So a parent and its subtask both
 * passed, and both appeared as roots — the subtask looking like an unrelated
 * task with a confusingly similar name.
 *
 * One rule, applied the same way in each of those views. A task whose parent is
 * also in the list is dropped from it: the parent is the thing to look at, and
 * the subtask will be drawn beneath it once rows can nest. A task whose parent
 * is *not* in the list — the parent is due another day, say — stays, and
 * carries its parent's title so it reads as a piece of something rather than a
 * task of its own.
 *
 * Until rows can nest, a hidden subtask is not drawn anywhere in these views.
 * That was weighed against showing both and accepted: a subtask standing alone
 * under its own parent is the case the rule exists to remove.
 */

import type { Task } from "@light/core";

export interface FoldedList {
  tasks: Task[];
  /** Parent titles, keyed by subtask id, for the tasks that stayed. */
  parentTitles: Map<string, string>;
}

export function foldSubtasks(list: Task[], parentOf: (id: string) => Task | null): FoldedList {
  const present = new Set(list.map((task) => task.id));
  const tasks: Task[] = [];
  const parentTitles = new Map<string, string>();

  for (const task of list) {
    if (task.parentId === null) {
      tasks.push(task);
      continue;
    }
    if (present.has(task.parentId)) continue;

    tasks.push(task);
    const parent = parentOf(task.parentId);
    // A parent that cannot be found (deleted, or not synced yet) gives no hint
    // rather than a made-up one.
    if (parent !== null) parentTitles.set(task.id, parent.content);
  }
  return { tasks, parentTitles };
}
