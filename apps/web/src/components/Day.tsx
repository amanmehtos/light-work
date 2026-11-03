/**
 * The day, as hours you can drop a task into.
 *
 * Two surfaces side by side: a rail of everything waiting, and a column of the
 * day's hours. Dragging between them is the whole feature — a task in the rail
 * has a day but no time, and one in the grid has both.
 *
 * Dragging uses `drag()` from `motion.mjs`, the library's own pointer helper,
 * rather than HTML5 drag-and-drop. HTML5 drags cannot move an element 1:1 with
 * the pointer — you get the browser's ghost image and its cursor — which would
 * look like a different application next to everything else here. `drag()`
 * also waits for a threshold before claiming the pointer, so a plain click on
 * a block still opens it.
 *
 * Where a block lands is worked out from the pointer against the grid's own
 * bounding box, not from the distance dragged, so it is right regardless of
 * where in the block you took hold of it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Op, Task } from "@light/core";
import type { LightStore, Operations } from "@light/client-sdk";
import { drag } from "diurnal-ui/motion.mjs";
import {
  SNAP_MINUTES,
  atDay,
  atTime,
  blockMinutes,
  clock,
  dueDay,
  dueMinutes,
  shiftDay,
  snap,
} from "../schedule.js";

/** Pixels per hour. Twelve to the quarter hour: enough to aim at. */
const HOUR_HEIGHT = 48;
const MINUTE_HEIGHT = HOUR_HEIGHT / 60;

const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

/** Where a drop landed: a time on the day, or the rail, or nowhere. */
type Landing = { kind: "slot"; minutes: number } | { kind: "rail" } | null;

/**
 * Overlap, resolved into columns.
 *
 * Two tasks at the same hour cannot both have the full width or one would be
 * invisible. Blocks are laid out left to right in the first column whose last
 * block has already finished — the standard calendar sweep — and every block
 * in a run of overlaps then shares the width of that run.
 */
export function layOut(
  blocks: { id: string; start: number; end: number }[],
): Map<string, { column: number; columns: number }> {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const placed = new Map<string, { column: number; columns: number }>();

  let run: { id: string; start: number; end: number; column: number }[] = [];
  let runEnd = -1;

  const flush = (): void => {
    const columns = run.reduce((most, block) => Math.max(most, block.column + 1), 1);
    for (const block of run) placed.set(block.id, { column: block.column, columns });
    run = [];
    runEnd = -1;
  };

  for (const block of sorted) {
    // A block starting after everything so far has ended begins a new run, and
    // the previous run's width is settled.
    if (block.start >= runEnd) flush();

    const taken = new Set(run.filter((other) => other.end > block.start).map((o) => o.column));
    let column = 0;
    while (taken.has(column)) column += 1;

    run.push({ ...block, column });
    runEnd = Math.max(runEnd, block.end);
  }
  flush();

  return placed;
}

/** A task in the rail, or a block in the grid: the same card, dragged. */
function Draggable({
  className,
  style,
  children,
  onLand,
  onOpen,
}: {
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  /** Decides what the pointer was over when it was let go. */
  onLand: (event: PointerEvent) => Landing;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const landRef = useRef(onLand);
  const openRef = useRef(onOpen);
  landRef.current = onLand;
  openRef.current = onOpen;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    drag(el, {
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
      onTap: () => openRef.current(),
    });
    // `drag` has no teardown, and the element dies with its listeners, so
    // there is nothing to return. Mount once: re-registering on every render
    // would stack handlers on the same node.
  }, []);

  return (
    <div ref={ref} className={`dn-card day-drag ${className}`} style={style}>
      {children}
    </div>
  );
}

export function Day({
  day,
  store,
  ops,
  commit,
  onDayChange,
  onOpen,
  onComplete,
  today,
  revision,
}: {
  day: string;
  store: LightStore;
  ops: Operations;
  commit: (ops: Op[]) => void;
  onDayChange: (day: string) => void;
  onOpen: (task: Task) => void;
  onComplete: (task: Task) => void;
  today: string;
  /** Bumps on every store change; what makes this recompute. */
  revision: number;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());

  // The "now" line, which is the one thing on this screen that moves by
  // itself. A minute is as precise as a 48px hour can show.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { timed, waiting } = useMemo(() => {
    const open = store.all("task").filter((task) => !task.isCompleted);
    const onDay = open.filter((task) => dueDay(task.due) === day);
    return {
      timed: onDay
        .filter((task) => dueMinutes(task.due) !== null)
        .sort((a, b) => (dueMinutes(a.due) ?? 0) - (dueMinutes(b.due) ?? 0)),
      // The rail is this day's untimed tasks first, then the genuinely
      // unscheduled — both are things you could decide to do today.
      waiting: [
        ...onDay.filter((task) => dueMinutes(task.due) === null),
        ...open.filter((task) => task.due === null),
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, day, revision]);

  const columns = useMemo(
    () =>
      layOut(
        timed.map((task) => {
          const start = dueMinutes(task.due) ?? 0;
          return { id: task.id, start, end: start + blockMinutes(task.duration) };
        }),
      ),
    [timed],
  );

  /** What the pointer was over when it was released. */
  function landingAt(event: PointerEvent): Landing {
    const rail = railRef.current?.getBoundingClientRect();
    if (
      rail !== undefined &&
      event.clientX >= rail.left &&
      event.clientX <= rail.right &&
      event.clientY >= rail.top &&
      event.clientY <= rail.bottom
    ) {
      return { kind: "rail" };
    }

    const grid = gridRef.current?.getBoundingClientRect();
    if (grid === undefined) return null;
    if (event.clientX < grid.left || event.clientX > grid.right) return null;
    if (event.clientY < grid.top || event.clientY > grid.bottom) return null;

    // Measured against the grid itself, so it stays right however far the
    // page has been scrolled.
    return { kind: "slot", minutes: snap((event.clientY - grid.top) / MINUTE_HEIGHT) };
  }

  function land(task: Task, landing: Landing) {
    if (landing === null) return;
    const due =
      landing.kind === "rail" ? atDay(day, task.due) : atTime(day, landing.minutes, task.due);
    // Nothing to say if it came back to where it started.
    if (task.due?.date === due.date && task.due.hasTime === due.hasTime) return;
    commit(ops.updateTask(task.id, { due }).ops);
  }

  const nowMinutes = day === today ? now.getHours() * 60 + now.getMinutes() : null;

  return (
    <div className="day">
      <header className="day-head">
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm"
          aria-label="Previous day"
          onClick={() => onDayChange(shiftDay(day, -1))}
        >
          ←
        </button>
        <strong className="day-title">{longDay(day)}</strong>
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm"
          aria-label="Next day"
          onClick={() => onDayChange(shiftDay(day, 1))}
        >
          →
        </button>
        {day !== today && (
          <button type="button" className="dn-btn dn-btn--sm" onClick={() => onDayChange(today)}>
            Today
          </button>
        )}
      </header>

      <div className="day-split">
        <div className="dn-card dn-card--flat day-rail" ref={railRef}>
          <div className="dn-eyebrow">Waiting</div>
          {waiting.length === 0 ? (
            <p className="dn-hint pad">Nothing waiting. Drag a block here to unschedule it.</p>
          ) : (
            waiting.map((task) => (
              <Draggable
                key={task.id}
                className="day-card"
                onLand={(event) => {
                  const landing = landingAt(event);
                  land(task, landing);
                  return landing;
                }}
                onOpen={() => onOpen(task)}
              >
                <Check task={task} onComplete={() => onComplete(task)} />
                <span className="day-card__title">{task.content}</span>
              </Draggable>
            ))
          )}
        </div>

        <div className="dn-card dn-card--flat day-sheet">
          <div className="day-hours" aria-hidden="true">
            {HOURS.map((hour) => (
              <div className="day-hour" key={hour} style={{ height: HOUR_HEIGHT }}>
                <span className="dn-hint">{clock(hour * 60)}</span>
              </div>
            ))}
          </div>

          <div
            className="day-grid"
            ref={gridRef}
            style={{ height: HOUR_HEIGHT * 24 }}
            role="list"
            aria-label={`Timed tasks on ${longDay(day)}`}
          >
            {HOURS.map((hour) => (
              <div
                className="day-slot"
                key={hour}
                style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }}
              />
            ))}

            {nowMinutes !== null && (
              <div className="day-now" style={{ top: nowMinutes * MINUTE_HEIGHT }} aria-hidden="true" />
            )}

            {timed.map((task) => {
              const start = dueMinutes(task.due) ?? 0;
              const length = blockMinutes(task.duration);
              const place = columns.get(task.id) ?? { column: 0, columns: 1 };
              const width = 100 / place.columns;
              return (
                <Draggable
                  key={task.id}
                  className="day-block"
                  style={{
                    top: start * MINUTE_HEIGHT,
                    height: Math.max(SNAP_MINUTES * MINUTE_HEIGHT, length * MINUTE_HEIGHT),
                    left: `${place.column * width}%`,
                    width: `${width}%`,
                  }}
                  onLand={(event) => {
                    const landing = landingAt(event);
                    land(task, landing);
                    return landing;
                  }}
                  onOpen={() => onOpen(task)}
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
        </div>
      </div>
    </div>
  );
}

/**
 * The checkbox, inside a draggable card.
 *
 * `stopPropagation` on pointerdown is what keeps the two apart: without it the
 * drag helper claims the pointer and the click that would have ticked the box
 * is swallowed as the end of a drag.
 */
function Check({ task, onComplete }: { task: Task; onComplete: () => void }) {
  return (
    <label className="dn-check check-big" onPointerDown={(event) => event.stopPropagation()}>
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
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
