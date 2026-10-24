/**
 * One task, as a card resting on the desk.
 *
 * Each row is its own low panel rather than a line in a list, because that is
 * what makes Diurnal visible: a dozen cards all throwing the same shadow in
 * the same direction reads as objects on a surface, which a bordered list does
 * not. The elevation is kept low so a long list does not turn into soup.
 */

import type { Label, Task } from "@light/core";
import type { LightStore, Operations } from "@light/client-sdk";
import { Button, Checkbox, Chip, Inline, Panel, Text } from "@light/diurnal";

/** `r g b` triples, matching the priority colours in the stylesheet. */
const PRIORITY_TINT: Record<number, string | undefined> = {
  1: "192 57 43",
  2: "204 122 40",
  3: "63 124 172",
  4: undefined,
};

const PRIORITY_NAME = ["", "Urgent", "High", "Medium", "None"];

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
    <li>
      {/* Selecting a task lifts it off the desk. */}
      <Panel level={selected ? 1.6 : 0.6} flush className={selected ? "task selected" : "task"}>
        <Checkbox
          tint={PRIORITY_TINT[task.priority]}
          checked={task.isCompleted}
          aria-label={`Complete ${task.content}`}
          onChange={onComplete}
        />

        <button className="task-body" onClick={onSelect}>
          <Text className="title" strike={task.isCompleted}>
            {task.content}
          </Text>

          <Inline gap={1} className="meta">
            {task.priority < 4 && (
              <Chip tint={PRIORITY_TINT[task.priority]}>
                p{task.priority} {PRIORITY_NAME[task.priority]}
              </Chip>
            )}

            {task.due !== null && (
              <Chip tone={overdue ? "danger" : "neutral"}>
                {formatDay(task.due.date, today)}
                {task.due.isRecurring && <span title={task.due.text ?? ""}>↻</span>}
              </Chip>
            )}

            {/* Outlined, so a deadline never reads as the same kind of thing
                as the due date sitting next to it. */}
            {task.deadline !== null && (
              <Chip tone="outline" title="Deadline — when this is actually owed">
                due by {formatDay(task.deadline.date, today)}
              </Chip>
            )}

            {task.duration !== null && (
              <Chip>
                {task.duration.amount}
                {task.duration.unit === "minute" ? "m" : "d"}
              </Chip>
            )}

            {labels.map((label) => (
              <Chip key={label.id}>@{label.name}</Chip>
            ))}

            {focus.sessions > 0 && (
              <Chip tone="accent" title={`${focus.sessions} focus session(s)`}>
                ◴ {humanDuration(focus.focusedSeconds)}
              </Chip>
            )}
          </Inline>

          {task.description !== "" && (
            <Text tone="soft" size="small" className="description">
              {task.description}
            </Text>
          )}
        </button>

        <span className="reorder">
          <Button variant="quiet" aria-label={`Move ${task.content} up`} onClick={onMoveUp}>
            ↑
          </Button>
          <Button variant="quiet" aria-label={`Move ${task.content} down`} onClick={onMoveDown}>
            ↓
          </Button>
        </span>
      </Panel>
    </li>
  );
}
