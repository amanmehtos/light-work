/**
 * Where a dragged row goes, in terms `Operations.reorderTask` understands.
 *
 * `reorderTask(id, afterId)` places a task directly after one of its siblings,
 * or at the head for `null`. A drop, though, is "over that row, on its upper or
 * lower half". This turns the second into the first, and decides when the drop
 * means nothing.
 *
 * Only tasks in the same list as the one being moved count. Today and All show
 * tasks from many projects in one column, and an order key only means something
 * among the tasks that share a project, section and parent; a row dropped on a
 * neighbour from another project has no position to take, so it is a no-op
 * rather than a guess. The ↑/↓ buttons make the same restriction by throwing
 * and being caught.
 *
 * Neighbours are read from the list as it is shown, not from every sibling the
 * store holds: a completed or off-view sibling between two visible rows is
 * simply stepped over, so the row lands where the person put it on screen.
 */

import type { Task } from "@light/core";

/** Which half of the row under the pointer the drop was on. */
export type Side = "before" | "after";

type Placement = Pick<Task, "projectId" | "sectionId" | "parentId">;

function sameList(a: Placement, b: Placement): boolean {
  return a.projectId === b.projectId && a.sectionId === b.sectionId && a.parentId === b.parentId;
}

/**
 * What to hand `reorderTask` for this drop, or null when nothing should happen.
 *
 * `visible` is the list in the order it is drawn.
 */
export function planReorder(
  visible: readonly Task[],
  movedId: string,
  targetId: string,
  side: Side,
): { afterId: string | null } | null {
  if (movedId === targetId) return null;
  const moved = visible.find((task) => task.id === movedId);
  if (moved === undefined) return null;

  const list = visible.filter((task) => sameList(task, moved));
  const target = list.findIndex((task) => task.id === targetId);
  if (target === -1) return null;

  // "After the target" is its own id. "Before the target" is after whatever
  // precedes it, which is nothing — the head — for the first row.
  const afterId = side === "after" ? list[target]!.id : (list[target - 1]?.id ?? null);

  // Dropping a row beside where it already is changes nothing, and a write
  // that moves nothing is still a write that syncs.
  if (afterId === movedId) return null;
  const movedAt = list.findIndex((task) => task.id === movedId);
  const currentAfter = list[movedAt - 1]?.id ?? null;
  if (afterId === currentAfter) return null;

  return { afterId };
}

/**
 * The id of the row beside `movedId` that shares its list, or null at the edge.
 *
 * What the ↑/↓ buttons step over. With subtasks drawn indented, the row below a
 * parent is usually its first child, which is not a sibling and not somewhere
 * the parent can land after; the same goes for the first row of the next section.
 * The neighbour is the nearest row in that direction in the same list, however
 * many rows of other lists are between.
 */
export function neighbour(
  visible: readonly Task[],
  movedId: string,
  direction: -1 | 1,
): string | null {
  const moved = visible.find((task) => task.id === movedId);
  if (moved === undefined) return null;
  const list = visible.filter((task) => sameList(task, moved));
  const at = list.findIndex((task) => task.id === movedId);
  return list[at + direction]?.id ?? null;
}

/**
 * Where a row dropped on a row in *another section* goes: into that section,
 * beside the row it was dropped on.
 *
 * `planReorder` refuses this on purpose — an order key means something only
 * among tasks that share a section — so a drop across a heading is a different
 * act: a move (`moveTask`, which lands the task last in the section) followed by
 * a reorder to put it where it was dropped. The caller stages both, so one
 * gesture is one commit.
 *
 * Only root rows in the same project: a subtask moves with its parent and is not
 * dropped into a section by itself, and a row dropped on one from another
 * project has no section of this project to land in.
 *
 * `known` is the sections that exist. A task naming one that does not is drawn
 * with the unsectioned rows (see `groupBySection`) and is treated as unsectioned
 * here too, so that what the drop does matches what is on the screen.
 */
export function planSectionMove(
  visible: readonly Task[],
  movedId: string,
  targetId: string,
  side: Side,
  known: ReadonlySet<string>,
): { sectionId: string | null; afterId: string | null } | null {
  if (movedId === targetId) return null;
  const moved = visible.find((task) => task.id === movedId);
  const target = visible.find((task) => task.id === targetId);
  if (moved === undefined || target === undefined) return null;
  if (moved.parentId !== null || target.parentId !== null) return null;
  if (moved.projectId !== target.projectId) return null;

  const placed = (task: Task): string | null =>
    task.sectionId !== null && known.has(task.sectionId) ? task.sectionId : null;
  const into = placed(target);
  if (placed(moved) === into) return null;

  const list = visible.filter(
    (task) => task.parentId === null && task.projectId === target.projectId && placed(task) === into,
  );
  const at = list.findIndex((task) => task.id === targetId);
  return { sectionId: into, afterId: side === "after" ? targetId : (list[at - 1]?.id ?? null) };
}

/** The section heading under a point, or null. A heading is a drop target; see `Operations.moveTask`. */
export function headingUnder(
  x: number,
  y: number,
  doc: Pick<Document, "elementFromPoint"> = document,
): string | null {
  const heading = doc.elementFromPoint(x, y)?.closest<HTMLElement>("[data-section-id]");
  return heading?.dataset.sectionId ?? null;
}

/** The half of `rect` the pointer is on. Exported with the rest so it is testable without a DOM. */
export function sideOf(pointerY: number, top: number, height: number): Side {
  return pointerY < top + height / 2 ? "before" : "after";
}

/**
 * The row under a point, and which half of it, or null in a gap or off the list.
 *
 * Asked at the moment the pointer is let go. The card in hand has been put back
 * by then (`Draggable` clears its transform before it lands), so what is under
 * the pointer is the layout as the list stands, not the card being dragged.
 */
export function rowUnder(
  x: number,
  y: number,
  doc: Pick<Document, "elementFromPoint"> = document,
): { id: string; side: Side } | null {
  const row = doc.elementFromPoint(x, y)?.closest<HTMLElement>("[data-task-id]");
  const id = row?.dataset.taskId;
  if (row === null || row === undefined || id === undefined) return null;
  const box = row.getBoundingClientRect();
  return { id, side: sideOf(y, box.top, box.height) };
}
