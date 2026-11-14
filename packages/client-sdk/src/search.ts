/**
 * What "search" means, in one place.
 *
 * The web app's search view and the MCP `list_tasks` tool both call this, and
 * that is the whole reason it lives here rather than in either of them: an
 * agent that searches for "invoice" and a person who types it into the box
 * should be looking at the same tasks in the same order. Before this the agent
 * matched titles only, so a task whose note said "invoice" was findable by
 * neither of them in the same way, and the UI would have been free to drift.
 *
 * A plain case-insensitive substring over the title, the notes and the names
 * of the task's labels, ranked title first. Substring rather than word or
 * fuzzy matching: it is predictable (what you typed is literally there), it is
 * what the agent tool already did, and a smarter matcher is the kind of thing
 * that is wrong in ways nobody can explain. Not word-by-word either: "quick
 * jerky" finds a task containing that phrase, not one that has both words
 * somewhere.
 *
 * It does not filter completed tasks, subtasks or hidden projects. That is the
 * caller's call: the agent has an `includeCompleted` switch, and the app hides
 * the rewards project when rewards are off.
 */

import { compareOrder, type Task } from "@light/core";
import type { LightStore } from "./store.js";

/** Lower is better. Where a task matched decides where it ranks. */
const RANK = { title: 0, label: 1, description: 2 } as const;

/**
 * Tasks matching `query`, best first.
 *
 * An empty or whitespace-only query matches nothing. Substring logic would say
 * it matches everything, but a search box that lists the whole account the
 * moment it is focused is not a search, and "no query" is the caller's cue to
 * show a prompt (or, for the agent tool, to apply no search filter at all).
 * The query is trimmed, so a trailing space typed mid-phrase does not lose the
 * match.
 *
 * Within a rank the order is the tasks' own `order`, then id, so the result is
 * the same on every device however the store happened to be filled.
 */
export function searchTasks(store: LightStore, query: string): Task[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const labelNames = new Map<string, string>();
  for (const label of store.all("label")) labelNames.set(label.id, label.name.toLowerCase());

  const hits: { task: Task; rank: number }[] = [];
  for (const task of store.all("task")) {
    let rank: number | null = null;
    if (task.content.toLowerCase().includes(needle)) {
      rank = RANK.title;
    } else if (task.labelIds.some((id) => labelNames.get(id)?.includes(needle) === true)) {
      rank = RANK.label;
    } else if (task.description.toLowerCase().includes(needle)) {
      rank = RANK.description;
    }
    if (rank !== null) hits.push({ task, rank });
  }

  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      compareOrder(a.task.order, b.task.order) ||
      a.task.id.localeCompare(b.task.id),
  );
  return hits.map((hit) => hit.task);
}
