/**
 * A project's rows, under the section headings they belong to.
 *
 * Todoist's layout, which is also what the imported account was built in:
 * tasks with no section sit above the first heading, then each section in its
 * `order` with its own tasks beneath it.
 *
 * A section is a heading, not a container of record (see
 * `Operations.deleteSection`), and this follows the same stance on the way in:
 * a task is never made unreachable by what its section is doing.
 *
 * - A task whose `sectionId` names a section that is not there — deleted on
 *   another device before this one heard — is drawn with the unsectioned rows,
 *   not dropped.
 * - An archived section is hidden, unless it still holds open work, in which
 *   case it is shown. Hiding a heading must not hide a task.
 * - A collapsed section keeps its rows in the group; the page leaves them out.
 *   The count is the section's own, so the heading says what is folded in it.
 *
 * Which section a row belongs to is decided by its root: a subtask is drawn
 * with its parent whatever its own `sectionId` says, because it is drawn
 * beneath it.
 */

import type { Section } from "@light/core";
import { compareOrder } from "@light/core";
import type { Row } from "./subtasks.js";

export interface Group {
  /** Null for the rows above the first heading. */
  section: Section | null;
  rows: Row[];
}

export function groupBySection(rows: readonly Row[], sections: readonly Section[]): Group[] {
  const ordered = [...sections].sort((a, b) => compareOrder(a.order, b.order));
  const known = new Set(ordered.map((section) => section.id));

  const root: Group = { section: null, rows: [] };
  const bySection = new Map<string, Group>(
    ordered.map((section) => [section.id, { section, rows: [] }]),
  );

  let current = root;
  for (const row of rows) {
    // A root row picks the group; the rows beneath it follow it.
    if (row.depth === 0) {
      const id = row.task.sectionId;
      current = id !== null && known.has(id) ? bySection.get(id)! : root;
    }
    current.rows.push(row);
  }

  const groups: Group[] = [root];
  for (const section of ordered) {
    const group = bySection.get(section.id)!;
    if (section.isArchived && group.rows.length === 0) continue;
    groups.push(group);
  }
  return groups;
}

/** The rows that are on the page: not folded under a task, nor inside a folded section. */
export function onPage(groups: readonly Group[]): Row[] {
  return groups.flatMap((group) =>
    group.section !== null && group.section.isCollapsed ? [] : group.rows.filter((row) => !row.hidden),
  );
}
