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
