/**
 * Listens for the keys in `shortcuts.ts` and hands them on.
 *
 * Precedence, because three things listen for Escape and they must not fight:
 *
 * 1. `RowMenu`, when open, wins. It listens on `document` in the capture
 *    phase and calls `stopPropagation`, so the event never reaches the
 *    listener below at all; `menuOpen` is a second lock in case that changes.
 *    It wins because it is the topmost thing on the page — a menu hangs over
 *    the row and the sheet, if open, is under it.
 * 2. A `Sheet` wins next, on its own terms. `fluid.mjs` closes a sheet from a
 *    keydown listener on the sheet element and `Sheet` tells React afterwards
 *    through a `MutationObserver`. When focus is inside the sheet that is
 *    already the whole job, and `resolveShortcut` returns nothing so this does
 *    not close it a second time. Only when focus has wandered out of an open
 *    sheet (Tab walks out; there is no focus trap) does the library not hear
 *    the key, and then the caller closes it through React state — which is the
 *    path `Sheet`'s `open` effect already supports, never a call into the
 *    library from here.
 * 3. Only if neither is open does this act: let go of a focused field, then
 *    clear the selection, then leave search.
 *
 * Bubble phase, after the target and anything that handled the key first, and
 * `defaultPrevented` is respected. The handler returns whether it acted, and
 * the key's own default (typing a letter, Firefox's quick-find on `/`) is
 * cancelled only then: a key that did nothing must not be swallowed.
 */

import { useEffect, useRef } from "react";
import { resolveShortcut, type Shortcut } from "./shortcuts.js";

export function useShortcuts(
  handle: (shortcut: Shortcut, event: KeyboardEvent, page: { sheetOpen: boolean }) => boolean,
): void {
  // Always the latest closure, without re-registering a document listener on
  // every render (which would also reorder it against `RowMenu`'s).
  const latest = useRef(handle);
  latest.current = handle;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // `:not([hidden])` includes a sheet that is still animating shut, which
      // is deliberate: the half-second after Escape is not a moment to start
      // moving a selection.
      const sheetOpen = document.querySelector(".dn-sheet:not([hidden])") !== null;
      const menuOpen = document.querySelector('.row-menu [aria-expanded="true"]') !== null;

      const shortcut = resolveShortcut(event, { sheetOpen, menuOpen });
      if (shortcut === null) return;
      if (latest.current(shortcut, event, { sheetOpen })) event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
