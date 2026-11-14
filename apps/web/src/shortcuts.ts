/**
 * Which key means what, and when it is allowed to mean anything.
 *
 * The decision is kept out of the component and made a pure function of the
 * event and two facts about the page, because the one thing that must never go
 * wrong here is a shortcut firing while someone is typing: `q` or `j` eaten
 * from a task title is not a missing feature but lost work. That rule is the
 * whole feature, so it is the part with its own tests.
 *
 * The set is seven and is meant to stay seven. It is a table (`SHORTCUTS`) that
 * the `?` sheet renders and the tests walk, so the sheet cannot list a key that
 * does nothing or leave one out.
 */

export type Shortcut =
  | "quick-add"
  | "search"
  | "edit"
  | "next"
  | "previous"
  | "complete"
  | "escape"
  | "help";

/** What the `?` sheet lists. `keys` are drawn as `.dn-kbd`, one per entry. */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["q"], label: "Add a task" },
  { keys: ["/"], label: "Search" },
  { keys: ["e"], label: "Edit the selected task" },
  { keys: ["j", "k"], label: "Select the next or previous task" },
  { keys: ["Enter"], label: "Complete the selected task" },
  { keys: ["Esc"], label: "Close what is open" },
  { keys: ["?"], label: "Show these shortcuts" },
];

/** The corner of an `Element` the guard reads, so tests need no DOM. */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
}

/** The corner of a `KeyboardEvent` the resolver reads. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: EventTarget | TargetLike | null;
}

/** What the page looks like at the moment of the key, read by the caller. */
export interface PageState {
  /** Any `.dn-sheet` that is not hidden — including one still closing. */
  sheetOpen: boolean;
  /** A `RowMenu` with its list showing. */
  menuOpen: boolean;
}

/**
 * Whether keys belong to this element rather than to the app.
 *
 * Every `input`, whatever its type, and not only the text ones: a date field
 * takes digits and arrows, a checkbox takes Space, and a person who has just
 * clicked a field is mid-gesture. The cost is that a focused checkbox swallows
 * the shortcuts until focus moves, which is a small price against the other
 * kind of mistake. `select` joins them because it eats letters for type-ahead.
 */
export function isTypingTarget(target: EventTarget | TargetLike | null): boolean {
  const el = target as TargetLike | null;
  if (el === null || typeof el !== "object") return false;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable === true) return true;
  return el.getAttribute?.("role") === "textbox";
}

/**
 * Whether the element would act on Enter by itself.
 *
 * Enter on a focused button presses it. If the shortcut also fired, one key
 * would do two things — complete the selected task and, say, open that row's
 * priority menu. So Enter is only the app's when nothing focused claims it,
 * which in practice means focus is on the page itself.
 */
function claimsEnter(target: EventTarget | TargetLike | null): boolean {
  const el = target as TargetLike | null;
  if (el === null || typeof el.closest !== "function") return false;
  return el.closest('a[href], button, summary, [role="button"], [role^="menuitem"], [tabindex]') !== null;
}

function insideSheet(target: EventTarget | TargetLike | null): boolean {
  const el = target as TargetLike | null;
  return el !== null && typeof el.closest === "function" && el.closest(".dn-sheet") !== null;
}

/**
 * The shortcut this key press is, or null when it is not one.
 *
 * Order matters and is the point:
 *
 * 1. Anything already handled, a composition in progress, or a modifier held
 *    (Cmd+K, Ctrl+J and friends belong to the browser) is not ours.
 * 2. Escape is decided before the typing rule, because it is the one key that
 *    is allowed to act on a focused field — it only lets go of the field,
 *    which costs no one any text — but not before the open-thing rules: a menu
 *    has already taken it, and inside a sheet the library closes the sheet
 *    itself (`fluid.mjs` listens on the sheet), so we must not close it twice.
 * 3. With a sheet or menu open, nothing else fires: `j` must not move a
 *    selection that is behind the editor.
 * 4. With a field focused, nothing fires.
 */
export function resolveShortcut(event: KeyLike, page: PageState): Shortcut | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  if (event.key === "Escape") {
    if (page.menuOpen) return null;
    if (insideSheet(event.target)) return null;
    return "escape";
  }

  if (page.sheetOpen || page.menuOpen) return null;
  if (isTypingTarget(event.target)) return null;

  // Caps Lock turns `j` into `J` without Shift; Shift held on a letter is a
  // chord nobody asked for. `/` and `?` already say what they are, and some
  // layouts need Shift to reach `/`.
  const key = event.key.length === 1 && !event.shiftKey ? event.key.toLowerCase() : event.key;
  if (event.shiftKey && key.length === 1 && key !== "?" && key !== "/") return null;

  // Holding `j` should keep moving; holding Enter must not flip a task between
  // done and not done twenty times a second.
  if (event.repeat && key !== "j" && key !== "k") return null;

  switch (key) {
    case "q":
      return "quick-add";
    case "/":
      return "search";
    case "e":
      return "edit";
    case "j":
      return "next";
    case "k":
      return "previous";
    case "Enter":
      return claimsEnter(event.target) ? null : "complete";
    case "?":
      return "help";
    default:
      return null;
  }
}

/**
 * Where the selection goes on j / k.
 *
 * A selection that is not in the list — the view changed under it, or the task
 * was completed elsewhere — starts again from the top (j) or the bottom (k)
 * rather than doing nothing. At either end it stays put: wrapping would make
 * the end of a list look like its beginning.
 */
export function moveSelection(
  ids: readonly string[],
  current: string | null,
  direction: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at === -1) return direction === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, at + direction))]!;
}

/**
 * Where the selection lands once the selected task has been completed.
 *
 * The neighbour below, or above when it was last, so that a run of Enters
 * works down a list — the reason to have the key at all.
 */
export function selectionAfterRemoval(ids: readonly string[], removed: string): string | null {
  const at = ids.indexOf(removed);
  if (at === -1) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}
