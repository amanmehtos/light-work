/**
 * Light Week: the week, as hours you can drop a task into.
 *
 * Seven days side by side under one column of hours, like a calendar's week.
 * At the top of each day is its all-day strip — "Waiting", what is on the day
 * at no particular time — and below it the day's hours. Dragging between the
 * two is the feature: a task in a strip has a day but no time, and one in the
 * grid has both. A task with no date is not on this page at all; it is not
 * waiting for any of these days, and listing the whole backlog atop each one
 * buried the week.
 *
 * Dragging uses `drag()` from `motion.mjs`, the library's own pointer helper,
 * rather than HTML5 drag-and-drop. HTML5 drags cannot move an element 1:1 with
 * the pointer — you get the browser's ghost image and its cursor — which would
 * look like a different application next to everything else here. `drag()`
 * also waits for a threshold before claiming the pointer, so a plain click on
 * a block still opens it.
 *
 * While a card is in hand it follows the pointer exactly, and a second, flat
 * card — the landing — shows where it would go if let go now, snapped to the
 * quarter hour and labelled with the time. The day under the pointer is laid
 * out again around that landing on every move (`previewDay`, then `layOut`),
 * so the blocks already there step aside into columns before the drop rather
 * than after it. That is what makes it feel like putting something down among
 * other things instead of on top of them.
 *
 * Where a card lands is worked out from the pointer against each day's own
 * bounding box, not from the distance dragged, so it is right however the
 * sheet has been scrolled and wherever in the card you took hold of it.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Op, Task } from "@light/core";
import type { LightStore, Operations } from "@light/client-sdk";
import { Draggable } from "./Draggable.js";
import { SNAP_MINUTES, atDay, atTime, blockMinutes, clock, dueMinutes, shiftDay } from "../schedule.js";
import {
  type Landing,
  bucketWeek,
  columnLabel,
  layOut,
  previewDay,
  slotAt,
  spanOf,
  weekDays,
  weekTitle,
} from "../week.js";

/** Pixels per hour. Twelve to the quarter hour: enough to aim at. */
const HOUR_HEIGHT = 48;
const MINUTE_HEIGHT = HOUR_HEIGHT / 60;

const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

/** Where the sheet opens: the start of a working day, not midnight. */
const FIRST_HOUR_SHOWN = 7;

/** How close to the sheet's edge a card in hand starts it scrolling. */
const EDGE = 36;

/** The card in hand, from the moment it became a drag. */
interface Held {
  id: string;
  length: number;
  /** Minutes between the card's top and where it was taken hold of. */
  grab: number;
  /** A strip card sits in the sticky head, which does not scroll vertically. */
  inStrip: boolean;
  scrollTop: number;
  scrollLeft: number;
}

export function Week({
  start,
  store,
  ops,
  commit,
  onWeekChange,
  onOpen,
  onComplete,
  today,
  revision,
}: {
  /** The week's first day, `YYYY-MM-DD`. */
  start: string;
  store: LightStore;
  ops: Operations;
  commit: (ops: Op[]) => void;
  /** Any day of the week to go to; App turns it into that week's start. */
  onWeekChange: (day: string) => void;
  onOpen: (task: Task) => void;
  onComplete: (task: Task) => void;
  today: string;
  /** Bumps on every store change; what makes this recompute. */
  revision: number;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const stripRefs = useRef(new Map<string, HTMLDivElement>());
  /** Where the last press took hold, before it is known to be a drag. */
  const pressed = useRef<{ grab: number; inStrip: boolean } | null>(null);
  // State for drawing, and a ref for the handlers: pointer moves arrive faster
  // than renders, and a handler reading a stale `held` would pick the card up
  // a second time with the wrong scroll offsets.
  const [held, setHeldState] = useState<Held | null>(null);
  const heldRef = useRef<Held | null>(null);
  const setHeld = (next: Held | null) => {
    heldRef.current = next;
    setHeldState(next);
  };
  const [landing, setLanding] = useState<Landing>(null);
  const [now, setNow] = useState(() => new Date());

  // The "now" line, which is the one thing on this screen that moves by
  // itself. A minute is as precise as a 48px hour can show.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Opened on the working day rather than at midnight, once per mount: paging
  // between weeks keeps wherever the person has scrolled to.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (sheet !== null) sheet.scrollTop = FIRST_HOUR_SHOWN * HOUR_HEIGHT;
  }, []);

  const days = useMemo(() => weekDays(start), [start]);

  const byDay = useMemo(
    () => bucketWeek(store.all("task"), days),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, days, revision],
  );

  /** Each day's blocks as they are, and as they would be with the card let go. */
  const placement = useMemo(() => {
    const moving = held === null ? null : { id: held.id, length: held.length };
    return new Map(
      days.map((day) => {
        const spans = (byDay.get(day)?.timed ?? []).map(spanOf);
        return [
          day,
          { resting: layOut(spans), live: layOut(previewDay(spans, day, moving, landing)) },
        ] as const;
      }),
    );
  }, [byDay, days, held, landing]);

  /** What the pointer is over: a day's strip, a time on a day, or nowhere. */
  function landingAt(event: PointerEvent, grab: number, length: number): Landing {
    const inside = (rect: DOMRect | undefined) =>
      rect !== undefined &&
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;

    for (const day of days) {
      if (inside(stripRefs.current.get(day)?.getBoundingClientRect())) return { kind: "strip", day };
    }
    // The head covers the top of the hours as they scroll under it; a pointer
    // over a day's name is not over the hour hidden beneath.
    if (inside(headRef.current?.getBoundingClientRect())) return null;
    if (!inside(sheetRef.current?.getBoundingClientRect())) return null;

    for (const day of days) {
      const column = columnRefs.current.get(day)?.getBoundingClientRect();
      if (column === undefined || event.clientX < column.left || event.clientX > column.right) continue;
      // Measured against the column itself, so it stays right however far
      // the sheet has been scrolled.
      const minutes = (event.clientY - column.top) / MINUTE_HEIGHT;
      return { kind: "slot", day, minutes: slotAt(minutes, grab, length) };
    }
    return null;
  }

  /** A press on a card: where in it the pointer took hold. */
  function press(event: PointerEvent, inStrip: boolean) {
    const card = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    // A strip card has no time to keep a hold on, so it lands by its top.
    const grab = inStrip || card === undefined ? 0 : (event.clientY - card.top) / MINUTE_HEIGHT;
    pressed.current = { grab, inStrip };
  }

  function move(task: Task, event: PointerEvent) {
    const sheet = sheetRef.current;
    let current = heldRef.current;
    if (current === null || current.id !== task.id) {
      const from = pressed.current ?? { grab: 0, inStrip: false };
      current = {
        id: task.id,
        length: blockMinutes(task.duration),
        grab: from.grab,
        inStrip: from.inStrip,
        scrollTop: sheet?.scrollTop ?? 0,
        scrollLeft: sheet?.scrollLeft ?? 0,
      };
      setHeld(current);
    }

    // Near the top or bottom of the hours, the sheet scrolls towards the
    // pointer, so a block can be carried to an hour that was not on screen.
    if (sheet !== null) {
      const bottom = sheet.getBoundingClientRect().bottom;
      const top = headRef.current?.getBoundingClientRect().bottom ?? sheet.getBoundingClientRect().top;
      if (event.clientY > bottom - EDGE) sheet.scrollTop += 12;
      else if (event.clientY > top && event.clientY < top + EDGE) sheet.scrollTop -= 12;
    }

    const next = landingAt(event, current.grab, current.length);
    setLanding((was) => (sameLanding(was, next) ? was : next));
  }

  function drift(): { x: number; y: number } {
    const sheet = sheetRef.current;
    const current = heldRef.current;
    if (sheet === null || current === null) return { x: 0, y: 0 };
    return {
      x: sheet.scrollLeft - current.scrollLeft,
      y: current.inStrip ? 0 : sheet.scrollTop - current.scrollTop,
    };
  }

  function letGo() {
    setHeld(null);
    setLanding(null);
    pressed.current = null;
  }

  function land(task: Task, event: PointerEvent) {
    const current = heldRef.current;
    const grab = current?.id === task.id ? current.grab : 0;
    const where = landingAt(event, grab, blockMinutes(task.duration));
    letGo();
    if (where === null) return;
    // A date and no time in a strip; a date and a time in the hours.
    const due = where.kind === "strip" ? atDay(where.day, task.due) : atTime(where.day, where.minutes, task.due);
    // Nothing to say if it came back to where it started.
    if (task.due?.date === due.date && task.due.hasTime === due.hasTime) return;
    commit(ops.updateTask(task.id, { due }).ops);
  }

  /** The props every card shares, in a strip or in the hours. */
  const dragProps = (task: Task, inStrip: boolean) => ({
    onPress: (event: PointerEvent) => press(event, inStrip),
    onDrag: (event: PointerEvent) => move(task, event),
    onLand: (event: PointerEvent) => land(task, event),
    onCancel: letGo,
    drift,
    onOpen: () => onOpen(task),
  });

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const thisWeek = days.includes(today);

  return (
    <div className="week">
      <header className="day-head">
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm"
          aria-label="Previous week"
          onClick={() => onWeekChange(shiftDay(start, -7))}
        >
          ←
        </button>
        <strong className="day-title">{weekTitle(start)}</strong>
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm"
          aria-label="Next week"
          onClick={() => onWeekChange(shiftDay(start, 7))}
        >
          →
        </button>
        {!thisWeek && (
          <button type="button" className="dn-btn dn-btn--sm" onClick={() => onWeekChange(today)}>
            This week
          </button>
        )}
      </header>

      <div
        className={`dn-card dn-card--flat week-sheet${held !== null ? " is-dragging" : ""}`}
        ref={sheetRef}
        role="region"
        aria-label={`Light Week, ${weekTitle(start)}`}
      >
        <div className="week-head" ref={headRef}>
          <div className="week-corner" />
          {days.map((day) => {
            const label = columnLabel(day);
            return (
              <div className="week-colhead" key={day} aria-current={day === today ? "date" : undefined}>
                <span className="dn-hint">{label.weekday}</span>
                <span className="week-date">{label.date}</span>
              </div>
            );
          })}

          <div className="week-corner week-corner--strip dn-hint">Waiting</div>
          {days.map((day) => {
            const waiting = byDay.get(day)?.waiting ?? [];
            const target = landing?.kind === "strip" && landing.day === day;
            return (
              <div
                className={`week-strip${target ? " is-target" : ""}`}
                key={day}
                ref={(el) => {
                  if (el === null) stripRefs.current.delete(day);
                  else stripRefs.current.set(day, el);
                }}
                role="list"
                aria-label={`Waiting on ${longDay(day)}`}
              >
                {waiting.map((task) => (
                  <Draggable key={task.id} className="day-card week-chip" {...dragProps(task, true)}>
                    <Check task={task} onComplete={() => onComplete(task)} />
                    <span className="day-card__title">{task.content}</span>
                  </Draggable>
                ))}
                {target && held !== null && (
                  <div className="week-ghost week-ghost--strip" aria-hidden="true">
                    All day
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="week-body">
          <div className="day-hours" aria-hidden="true">
            {HOURS.map((hour) => (
              <div className="day-hour" key={hour} style={{ height: HOUR_HEIGHT }}>
                {hour > 0 && <span className="dn-hint">{clock(hour * 60)}</span>}
              </div>
            ))}
          </div>

          {days.map((day) => {
            const timed = byDay.get(day)?.timed ?? [];
            const places = placement.get(day);
            const target = landing?.kind === "slot" && landing.day === day ? landing : null;
            const ghost = target !== null && held !== null ? places?.live.get(held.id) : undefined;
            return (
              <div
                className={`week-col${day === today ? " is-today" : ""}`}
                key={day}
                ref={(el) => {
                  if (el === null) columnRefs.current.delete(day);
                  else columnRefs.current.set(day, el);
                }}
                style={{ height: HOUR_HEIGHT * 24 }}
                role="list"
                aria-label={`Timed tasks on ${longDay(day)}`}
              >
                {HOURS.map((hour) => (
                  <div className="day-slot" key={hour} style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }} />
                ))}

                {day === today && (
                  <div className="day-now" style={{ top: nowMinutes * MINUTE_HEIGHT }} aria-hidden="true" />
                )}

                {target !== null && ghost !== undefined && held !== null && (
                  <div className="week-ghost" style={blockStyle(target.minutes, held.length, ghost)} aria-hidden="true">
                    {clock(target.minutes)} – {clock(target.minutes + held.length)}
                  </div>
                )}

                {timed.map((task) => {
                  const start = dueMinutes(task.due) ?? 0;
                  const length = blockMinutes(task.duration);
                  // The card in hand keeps the place it was picked up from: it
                  // is translated from there, and a place that moved under it
                  // would carry it off the pointer. Everything else takes the
                  // live layout, which is what makes room for the landing.
                  const inHand = held?.id === task.id;
                  const place = (inHand ? places?.resting : places?.live)?.get(task.id) ?? { column: 0, columns: 1 };
                  return (
                    <Draggable
                      key={task.id}
                      className="day-block"
                      style={blockStyle(start, length, place)}
                      {...dragProps(task, false)}
                    >
                      <Check task={task} onComplete={() => onComplete(task)} />
                      <span className="day-block__body">
                        <span className="day-card__title">{task.content}</span>
                        <span className="dn-hint">
                          {clock(start)} – {clock(start + length)}
                        </span>
                      </span>
                    </Draggable>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function blockStyle(start: number, length: number, place: { column: number; columns: number }): React.CSSProperties {
  const width = 100 / place.columns;
  return {
    top: start * MINUTE_HEIGHT,
    height: Math.max(SNAP_MINUTES * MINUTE_HEIGHT, length * MINUTE_HEIGHT),
    left: `${place.column * width}%`,
    width: `${width}%`,
  };
}

function sameLanding(a: Landing, b: Landing): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.day !== b.day) return false;
  return a.kind === "strip" || (b.kind === "slot" && a.minutes === b.minutes);
}

/**
 * The checkbox, inside a draggable card.
 *
 * `stopPropagation` on pointerdown is what keeps the two apart: without it the
 * drag helper claims the pointer and the click that would have ticked the box
 * is swallowed as the end of a drag. The library's own size, not the lists'
 * larger one: a seventh of a page has no width to spare for it.
 */
function Check({ task, onComplete }: { task: Task; onComplete: () => void }) {
  return (
    <label className="dn-check week-check" onPointerDown={(event) => event.stopPropagation()}>
      <input
        type="checkbox"
        checked={task.isCompleted}
        aria-label={`Complete ${task.content}`}
        onChange={onComplete}
      />
    </label>
  );
}

function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}
