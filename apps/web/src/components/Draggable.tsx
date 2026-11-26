/**
 * A card that can be picked up, and what happens when it is put down.
 *
 * Lifted out of the day view so a task row in a list can be dragged the same
 * way: the library's own pointer helper, 1:1 with the pointer, a 6px threshold
 * before a press becomes a drag, and a plain tap still opens the task. The
 * reasoning for `drag()` over HTML5 drag-and-drop is in `Week.tsx`. The move was
 * made verbatim first and checked against the day view before anything here
 * changed; the teardown and the row options came after.
 */

import { useEffect, useRef } from "react";
import { mountDrag } from "../mount-drag.js";

/**
 * A task in the rail, a block in the grid, or a row in a list: the same card,
 * dragged.
 *
 * The optional props exist for rows and for Light Week, and default to a card
 * that only moves and lands, so neither pays for what the other needs.
 */
export function Draggable({
  className,
  style,
  children,
  onLand,
  onOpen,
  baseClass = "dn-card day-drag",
  ignore,
  onPress,
  onDrag,
  onCancel,
  drift,
}: {
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  /** Decides what the pointer was over when it was let go. */
  onLand: (event: PointerEvent) => unknown;
  /**
   * What a tap does. Left out by a row, whose own body already handles its
   * click — wiring both would run the click twice.
   */
  onOpen?: () => void;
  /**
   * What the card is dressed in. A row replaces `day-drag`, which sets
   * `touch-action: none` for the whole card: right for a block on a canvas,
   * wrong for a row in a page, where it would stop a finger scrolling the list.
   */
  baseClass?: string;
  /** Controls inside that keep their own press; see `mountDrag`. */
  ignore?: string;
  /** The press that may become a drag, for working out where it took hold. */
  onPress?: (event: PointerEvent) => void;
  /**
   * Every move once it is a drag. What lets the week show where the card
   * would land, and make room for it, while it is still in hand.
   */
  onDrag?: (event: PointerEvent) => void;
  /**
   * Escape, mid-drag. When given, Escape puts the card back and the drop that
   * follows lands nothing; left out, Escape does nothing, as it always has.
   */
  onCancel?: () => void;
  /**
   * How far the card's own surface has scrolled since it was picked up. The
   * card is translated from where it started, so a surface that scrolls under
   * it would carry it away from the pointer; this is added back.
   */
  drift?: () => { x: number; y: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const landRef = useRef(onLand);
  const openRef = useRef(onOpen);
  const pressRef = useRef(onPress);
  const dragRef = useRef(onDrag);
  const cancelRef = useRef(onCancel);
  const driftRef = useRef(drift);
  landRef.current = onLand;
  openRef.current = onOpen;
  pressRef.current = onPress;
  dragRef.current = onDrag;
  cancelRef.current = onCancel;
  driftRef.current = drift;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // `drag()` has no way to be told a drag is over before the pointer is
    // let go, so a cancelled one is remembered here and its end ignored.
    let cancelled = false;
    let held = false;
    const putBack = () => {
      el.style.transform = "";
      el.style.removeProperty("--dn-elev");
      el.style.zIndex = "";
      el.classList.remove("is-held");
    };
    const onKey = (event: KeyboardEvent) => {
      if (!held || event.key !== "Escape" || cancelRef.current === undefined) return;
      // Ours alone: the page's own Escape would otherwise also close or
      // deselect something behind the card.
      event.preventDefault();
      event.stopPropagation();
      cancelled = true;
      held = false;
      putBack();
      cancelRef.current();
    };
    window.addEventListener("keydown", onKey, true);

    const stop = mountDrag(el, {
      axis: "both",
      threshold: 6,
      onStart: (event) => {
        cancelled = false;
        pressRef.current?.(event);
      },
      onMove: ({ dx, dy, e }) => {
        if (cancelled) return;
        held = true;
        const drift = driftRef.current?.() ?? { x: 0, y: 0 };
        // 1:1 with the pointer, and lifted off the page while it is in hand.
        el.style.transform = `translate(${dx + drift.x}px, ${dy + drift.y}px)`;
        el.style.setProperty("--dn-elev", "24px");
        el.style.zIndex = "5";
        el.classList.add("is-held");
        dragRef.current?.(e);
      },
      onEnd: ({ e }) => {
        held = false;
        putBack();
        if (cancelled) return;
        landRef.current(e);
      },
      onTap: () => openRef.current?.(),
    }, ignore);
    // Torn down, where it used to be left to die with the element. A row mounts
    // and unmounts with every filter change, and StrictMode mounts everything
    // twice in development; without this each of those stacked another set of
    // handlers on the node. The styles are put back too, in case it goes away
    // with a card in hand.
    return () => {
      stop();
      window.removeEventListener("keydown", onKey, true);
      putBack();
    };
    // Mount once: the callbacks are read through refs, so there is nothing to
    // re-register when a render hands in new ones. `ignore` is a constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={ref} className={`${baseClass} ${className}`} style={style}>
      {children}
    </div>
  );
}
