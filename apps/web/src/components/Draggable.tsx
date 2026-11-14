/**
 * A card that can be picked up, and what happens when it is put down.
 *
 * Lifted out of the day view so a task row in a list can be dragged the same
 * way: the library's own pointer helper, 1:1 with the pointer, a 6px threshold
 * before a press becomes a drag, and a plain tap still opens the task. The
 * reasoning for `drag()` over HTML5 drag-and-drop is in `Day.tsx`. The move was
 * made verbatim first and checked against the day view before anything here
 * changed; the teardown and the row options came after.
 */

import { useEffect, useRef } from "react";
import { mountDrag } from "../mount-drag.js";

/**
 * A task in the rail, a block in the grid, or a row in a list: the same card,
 * dragged.
 *
 * The three optional props exist for rows and default to what the day view has
 * always had, so the day view passes none of them.
 */
export function Draggable({
  className,
  style,
  children,
  onLand,
  onOpen,
  baseClass = "dn-card day-drag",
  ignore,
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
}) {
  const ref = useRef<HTMLDivElement>(null);
  const landRef = useRef(onLand);
  const openRef = useRef(onOpen);
  landRef.current = onLand;
  openRef.current = onOpen;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const stop = mountDrag(el, {
      axis: "both",
      threshold: 6,
      onMove: ({ dx, dy }) => {
        // 1:1 with the pointer, and lifted off the page while it is in hand.
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.setProperty("--dn-elev", "24px");
        el.style.zIndex = "5";
      },
      onEnd: ({ e }) => {
        el.style.transform = "";
        el.style.removeProperty("--dn-elev");
        el.style.zIndex = "";
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
      el.style.transform = "";
      el.style.removeProperty("--dn-elev");
      el.style.zIndex = "";
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
