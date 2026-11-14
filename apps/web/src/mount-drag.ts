/**
 * `drag()` from Diurnal, with the teardown it does not have.
 *
 * `drag(el, options)` adds four listeners to `el` and returns nothing, so
 * there is no way to take them off again. That was harmless for day blocks,
 * which live as long as the view, and it is not harmless anywhere an element
 * can be mounted twice. `StrictMode` does exactly that in development — mount,
 * clean up, mount — which stacked a second set of handlers on every block, so
 * one drop ran its landing twice. Rows in a list make it worse: they mount and
 * unmount whenever a filter changes.
 *
 * The library lives in a submodule that is kept pristine, so it is not edited.
 * Instead the element's `addEventListener` is shadowed for the length of the
 * `drag()` call so that every listener it registers is tied to one
 * `AbortController`; aborting it removes them all. The shadow is deleted again
 * before this returns, so nothing else ever sees it. The alternative, a flag
 * that makes stale handlers do nothing, was rejected: the listeners would stay
 * on the node, and the helper's own click-swallowing would still run.
 */

import { drag } from "diurnal-ui/motion.mjs";

type DragOptions = Parameters<typeof drag>[1];

/**
 * Starts dragging `el`. Returns the function that stops it.
 *
 * `ignore` is a selector for controls inside `el` that must keep their own
 * press: a press that starts on one never reaches `drag()`. It exists because
 * React's `stopPropagation` on a control's `onPointerDown` cannot do this job.
 * React hears events at the root, after `el`'s own native listener has already
 * run, so by the time a handler says "stop", the drag helper has taken the
 * pointer. The stop has to happen on `el` itself, in the capture phase, ahead
 * of `drag()`. Left unset, nothing is ignored — which is how the day view, whose
 * cards have always been mounted this way, still behaves.
 */
export function mountDrag(
  el: HTMLElement,
  options: DragOptions,
  ignore?: string,
): () => void {
  const controller = new AbortController();
  const original = el.addEventListener.bind(el) as (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => void;

  // `drag()` passes `true` for its capture-phase click listener and nothing
  // for the rest; both shapes have to keep their meaning when a signal joins.
  (el as { addEventListener: unknown }).addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    opts?: boolean | AddEventListenerOptions,
  ): void => {
    const base = typeof opts === "boolean" ? { capture: opts } : (opts ?? {});
    original(type, listener, { ...base, signal: controller.signal });
  };
  try {
    if (ignore !== undefined) {
      // Registered first, so it runs first. A press on a control stops here and
      // `drag()` never sees it; everything else carries on as normal.
      el.addEventListener("pointerdown", (event) => {
        const target = event.target as Element | null;
        // Immediate, so `drag()`'s own listener on this same node is skipped
        // too, not only the ones further down the tree.
        if (target?.closest?.(ignore) != null) event.stopImmediatePropagation();
      }, true);
    }
    drag(el, options);
  } finally {
    delete (el as { addEventListener?: unknown }).addEventListener;
  }

  return () => controller.abort();
}
