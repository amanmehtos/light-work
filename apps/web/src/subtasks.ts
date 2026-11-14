/**
 * How a list of tasks is arranged around the subtasks in it.
 *
 * This replaces `foldSubtasks`, which was the Phase 0 stopgap. Today, Upcoming
 * and All are filters over every open task, and a filter has no idea that one
 * task belongs to another, so a parent and its subtask both passed and both
 * appeared as roots — the subtask looking like an unrelated task with a
 * confusingly similar name. The stopgap dropped the subtask whenever its parent
 * was in the same list, on the promise that it would be drawn beneath its
 * parent "once rows can nest". Rows can now nest, so nothing is dropped: the
 * subtask is drawn under its parent, indented.
 *
 * The rule, in one place for every view:
 *
 * - A task whose parent is in the list is a child of it, drawn beneath it, one
 *   step in. Children keep the order the list gave them.
 * - A task whose parent is *not* in the list — due another day, in another
 *   view's scope, completed — is a root. It carries its parent's title so it
 *   reads as a piece of something rather than a task of its own.
 * - Nothing is ever left out. `arrangeSubtasks(list).length === list.length`,
 *   always, and that is the property the sidebar's counts rest on: they are the
 *   length of this function's result, so a count and the rows it stands for
 *   cannot drift apart the way they did when one was folded and the other not.
 *
 * Collapsing hides rows, it does not remove them. A collapsed parent's
 * descendants stay in the result with `hidden` set, so the count does not move
 * when a chevron is clicked, and the parent's own `2/5` chip says what is
 * inside. Only the rendered list and keyboard selection skip hidden rows.
 */

import type { Task } from "@light/core";

/** Every task the account holds, indexed once for the lookups an arrangement needs. */
export interface TaskIndex {
  get(id: string): Task | null;
  /** Direct subtasks of a task, whatever their state — the `2/5` counts finished ones too. */
  childrenOf(id: string): readonly Task[];
}

export function indexTasks(all: readonly Task[]): TaskIndex {
  const byId = new Map<string, Task>();
  const children = new Map<string, Task[]>();
  for (const task of all) {
    byId.set(task.id, task);
    if (task.parentId !== null) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    }
  }
  return { get: (id) => byId.get(id) ?? null, childrenOf: (id) => children.get(id) ?? [] };
}

export interface Row {
  task: Task;
  /** 0 for a root; one more for each parent above it that is in the list. */
  depth: number;
  /** Set on a root that is a subtask — its parent is somewhere else. */
  parentTitle: string | null;
  /** Finished over all, among its direct subtasks; null when it has none. */
  subtasks: { done: number; total: number } | null;
  /** Whether any of its subtasks are in this list, and so there is something to fold. */
  hasChildren: boolean;
  /** Folded, with children to hide. A flag on a task with none to hide is not folded. */
  collapsed: boolean;
  /** Inside a collapsed ancestor: present in the result, absent from the page. */
  hidden: boolean;
}

function chip(task: Task, index: TaskIndex): Row["subtasks"] {
  const kids = index.childrenOf(task.id);
  if (kids.length === 0) return null;
  return { done: kids.filter((kid) => kid.isCompleted).length, total: kids.length };
}

export function arrangeSubtasks(list: readonly Task[], index: TaskIndex): Row[] {
  const present = new Set(list.map((task) => task.id));
  const kids = new Map<string, Task[]>();
  const roots: Task[] = [];

  for (const task of list) {
    if (task.parentId !== null && task.parentId !== task.id && present.has(task.parentId)) {
      const siblings = kids.get(task.parentId) ?? [];
      siblings.push(task);
      kids.set(task.parentId, siblings);
    } else {
      roots.push(task);
    }
  }

  const rows: Row[] = [];
  const seen = new Set<string>();

  const visit = (task: Task, depth: number, hidden: boolean): void => {
    if (seen.has(task.id)) return;
    seen.add(task.id);

    const children = kids.get(task.id) ?? [];
    const collapsed = task.isCollapsed && children.length > 0;
    // A root that is a subtask. A parent that cannot be found (deleted, or not
    // synced yet) gives no hint rather than a made-up one.
    const parent = depth === 0 && task.parentId !== null ? index.get(task.parentId) : null;

    rows.push({
      task,
      depth,
      parentTitle: parent === null ? null : parent.content,
      subtasks: chip(task, index),
      hasChildren: children.length > 0,
      collapsed,
      hidden,
    });
    for (const child of children) visit(child, depth + 1, hidden || collapsed);
  };

  for (const root of roots) visit(root, 0, false);
  // A parent cycle in bad data leaves every member with a parent that is
  // present, so none is a root and the walk above never reaches them. They are
  // drawn rather than lost: "nothing is ever left out" has to hold for bad data
  // too, or the count would be wrong exactly when something is.
  for (const task of list) visit(task, 0, false);

  return rows;
}

/**
 * Rows for a list that does not nest: Completed, which is a record rather than
 * a plan, and search, where a subtask that matched is the thing that matched
 * and stands alone. Same shape, so one renderer draws both; a subtask says whose
 * it is, since its parent is not beside it to say so.
 */
export function flatRows(list: readonly Task[], index: TaskIndex): Row[] {
  return list.map((task) => {
    const parent = task.parentId === null ? null : index.get(task.parentId);
    return {
      task,
      depth: 0,
      parentTitle: parent === null ? null : parent.content,
      subtasks: null,
      hasChildren: false,
      collapsed: false,
      hidden: false,
    };
  });
}

/** Every task a collapsed `ancestorId` hides, for moving a selection out of it. */
export function descendantIds(rows: readonly Row[], ancestorId: string): Set<string> {
  const at = rows.findIndex((row) => row.task.id === ancestorId);
  const out = new Set<string>();
  if (at === -1) return out;
  const depth = rows[at]!.depth;
  for (let i = at + 1; i < rows.length && rows[i]!.depth > depth; i++) out.add(rows[i]!.task.id);
  return out;
}
