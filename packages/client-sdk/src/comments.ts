/**
 * Comments on a task, read the one way.
 *
 * The web's editor and the MCP `list_comments` tool both call this, for the
 * reason `searchTasks` exists: an agent reading a task's thread and a person
 * opening that task should see the same comments in the same order.
 *
 * Oldest first, as a conversation reads. The key is when it was posted, then
 * the id — the id only because two comments can share a timestamp (an import
 * stamps what Todoist gave it, and a missing date is stamped with the epoch),
 * and a list that reshuffles between renders is worse than one that is
 * arbitrarily but stably ordered.
 *
 * Deliberately only comments *on a task*. A comment can also hang off a
 * project (`projectId` set, `taskId` null — the importer keeps those), and
 * they are not here: there is no project page to put them on, and the plan
 * puts the thread on the task's own sheet. See `docs/todoist-parity-plan.md`,
 * Phase 6.
 */

import type { Comment } from "@light/core";
import type { LightStore } from "./store.js";

/**
 * When the comment was posted, as a time, or null when the row does not say.
 *
 * The importer writes the epoch for a comment Todoist gave no date, which is a
 * placeholder and not a claim that it was written in 1970; showing "1 January
 * 1970" under someone's note would be a lie that looks like data. A date that
 * will not parse is the same case.
 */
export function postedTime(comment: Pick<Comment, "postedAt">): number | null {
  const time = Date.parse(comment.postedAt);
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** Oldest first, ties settled the same way on every device. */
function oldestFirst(a: Comment, b: Comment): number {
  return (postedTime(a) ?? 0) - (postedTime(b) ?? 0) || a.id.localeCompare(b.id);
}

/** The comments on one task, oldest first. */
export function commentsOnTask(store: LightStore, taskId: string): Comment[] {
  return store
    .all("comment")
    .filter((comment) => comment.taskId === taskId)
    .sort(oldestFirst);
}

/**
 * The comments on the project itself, oldest first.
 *
 * Todoist lets a note hang off a project rather than an item, and the importer
 * keeps those: `taskId` null, `projectId` set. Nothing read them. They were
 * synced, served and reachable by neither a person nor an agent — the same
 * state the sections were in, and the one thing §1 of the plan singles out as
 * worse than a missing feature, because it is the user's own writing.
 *
 * A comment carries only one of the two, so a task thread and a project thread
 * can never show the same row twice.
 */
export function commentsOnProject(store: LightStore, projectId: string): Comment[] {
  return store
    .all("comment")
    .filter((comment) => comment.taskId === null && comment.projectId === projectId)
    .sort(oldestFirst);
}
