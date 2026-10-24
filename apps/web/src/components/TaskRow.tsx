/**
 * One task, as a flat card on the page.
 *
 * Diurnal is monochrome — "ink, paper and greys, nothing else; emphasis comes
 * from contrast and elevation" — so priority is carried by badge weight rather
 * than by colour: solid for urgent, outlined for high, plain for medium,
 * nothing at all for none. An earlier version of this file used red, amber and
 * blue, which is precisely what the library exists not to do.
 */

import type { Label, Task } from "@light/core";
import type { LightStore, Operations } from "@light/client-sdk";

const PRIORITY_NAME = ["", "urgent", "high", "medium", "none"];

/** Weight, not hue: the only axis a monochrome system has. */
const PRIORITY_BADGE: Record<number, string> = {
  1: "dn-badge dn-badge--solid",
  2: "dn-badge dn-badge--outline",
  3: "dn-badge",
};

function humanDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function formatDay(iso: string, today: string): string {
  const day = iso.slice(0, 10);
  if (day === today) return "today";
  const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (day === tomorrow) return "tomorrow";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function TaskRow({
  task,
  store,
  ops,
  today,
  selected,
  onComplete,
  onSelect,
  onMoveUp,
  onMoveDown,
}: {
  task: Task;
  store: LightStore;
  ops: Operations;
  today: string;
  selected: boolean;
  onComplete: () => void;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const labels = task.labelIds
    .map((id) => store.get("label", id))
    .filter((label): label is Label => label !== null);

  const focus = ops.focusStatsForTask(task.id);
  const overdue = task.due !== null && task.due.date.slice(0, 10) < today;

  return (
    <li>
      {/* Selecting a task lifts it off the page — elevation is how this system
          says "this one". */}
      <div className={`dn-card dn-row task${selected ? " selected" : ""}`} style={selected ? { ["--dn-elev" as string]: "18px" } : undefined}>
        <label className="dn-check">
          <input
            type="checkbox"
            checked={task.isCompleted}
            aria-label={`Complete ${task.content}`}
            onChange={onComplete}
          />
        </label>

        <button className="dn-row__body" onClick={onSelect}>
          <span className={task.isCompleted ? "title done" : "title"}>{task.content}</span>

          <span className="meta">
            {task.priority < 4 && (
              <span className={PRIORITY_BADGE[task.priority]}>
                p{task.priority} {PRIORITY_NAME[task.priority]}
              </span>
            )}

            {task.due !== null && (
              <span className={overdue ? "dn-badge dn-badge--danger" : "dn-badge"}>
                {formatDay(task.due.date, today)}
                {task.due.isRecurring && <i title={task.due.text ?? ""} />}
              </span>
            )}

            {/* Outlined, so a deadline never reads as the same kind of thing
                as the due date sitting next to it. */}
            {task.deadline !== null && (
              <span className="dn-badge dn-badge--outline" title="Deadline — when this is actually owed">
                due by {formatDay(task.deadline.date, today)}
              </span>
            )}

            {task.duration !== null && (
              <span className="dn-badge">
                {task.duration.amount}
                {task.duration.unit === "minute" ? "m" : "d"}
              </span>
            )}

            {labels.map((label) => (
              <span key={label.id} className="dn-badge">
                @{label.name}
              </span>
            ))}

            {focus.sessions > 0 && (
              <span className="dn-badge dn-badge--outline" title={`${focus.sessions} focus session(s)`}>
                focused {humanDuration(focus.focusedSeconds)}
              </span>
            )}
          </span>

          {task.description !== "" && <span className="dn-hint description">{task.description}</span>}
        </button>

        <span className="dn-row__aside">
          <button
            type="button"
            className="dn-btn dn-btn--ghost dn-btn--sm"
            aria-label={`Move ${task.content} up`}
            onClick={onMoveUp}
          >
            ↑
          </button>
          <button
            type="button"
            className="dn-btn dn-btn--ghost dn-btn--sm"
            aria-label={`Move ${task.content} down`}
            onClick={onMoveDown}
          >
            ↓
          </button>
        </span>
      </div>
    </li>
  );
}
