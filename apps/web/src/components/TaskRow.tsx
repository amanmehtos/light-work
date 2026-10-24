/**
 * One task.
 *
 * Shows the two date fields distinctly, because conflating "when I'll work on
 * it" with "when it's owed" is the main way a Todoist clone loses information
 * the user put in deliberately.
 */

import type { Label, Task } from "@light/core";
import type { LightStore, Operations } from "@light/client-sdk";

const PRIORITY_LABEL = ["", "Urgent", "High", "Medium", "None"];

function humanDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function formatDay(iso: string, today: string): string {
  const day = iso.slice(0, 10);
  if (day === today) return "Today";
  const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (day === tomorrow) return "Tomorrow";
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
    <li className={selected ? "task selected" : "task"}>
      <input
        type="checkbox"
        className={`check p${task.priority}`}
        checked={task.isCompleted}
        aria-label={`Complete ${task.content}`}
        onChange={onComplete}
      />

      <button className="task-body" onClick={onSelect}>
        <span className={task.isCompleted ? "title done" : "title"}>{task.content}</span>

        <span className="meta">
          {task.priority < 4 && (
            <span className={`chip priority p${task.priority}`}>
              p{task.priority} {PRIORITY_LABEL[task.priority]}
            </span>
          )}

          {task.due !== null && (
            <span className={overdue ? "chip due overdue" : "chip due"}>
              {formatDay(task.due.date, today)}
              {task.due.isRecurring && <span className="recurring" title={task.due.text ?? ""}> ↻</span>}
            </span>
          )}

          {/* Deliberately distinct from the due date. */}
          {task.deadline !== null && (
            <span className="chip deadline" title="Deadline — when this is actually owed">
              due by {formatDay(task.deadline.date, today)}
            </span>
          )}

          {task.duration !== null && (
            <span className="chip">
              {task.duration.amount}
              {task.duration.unit === "minute" ? "m" : "d"}
            </span>
          )}

          {labels.map((label) => (
            <span key={label.id} className="chip label">
              @{label.name}
            </span>
          ))}

          {focus.sessions > 0 && (
            <span className="chip focus" title={`${focus.sessions} focus session(s)`}>
              ◴ {humanDuration(focus.focusedSeconds)}
            </span>
          )}
        </span>

        {task.description !== "" && <span className="description">{task.description}</span>}
      </button>

      <span className="reorder">
        <button aria-label={`Move ${task.content} up`} onClick={onMoveUp}>
          ↑
        </button>
        <button aria-label={`Move ${task.content} down`} onClick={onMoveDown}>
          ↓
        </button>
      </span>
    </li>
  );
}
