/**
 * One task, as a flat card on the page.
 *
 * Diurnal is monochrome — "ink, paper and greys, nothing else; emphasis comes
 * from contrast and elevation" — so priority is carried by badge weight rather
 * than by colour: solid for urgent, outlined for high, plain for medium,
 * nothing at all for none. An earlier version of this file used red, amber and
 * blue, which is precisely what the library exists not to do.
 *
 * The date and the priority are buttons: each opens a small menu, so
 * rescheduling or reprioritising a task is one pick and never opens the editor.
 */

import type { Label, Priority, Task } from "@light/core";
import type { LightStore, Operations, RescheduleTarget } from "@light/client-sdk";
import { Draggable } from "./Draggable.js";
import { RowMenu, type MenuItem } from "./RowMenu.js";

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

/**
 * What to suggest the timer be set to, in seconds.
 *
 * A task estimated in days is a body of work rather than a sitting, so it gets
 * the default instead: proposing an eight-hour block would be worse than
 * proposing nothing. Only advice for this one session — Light Minute floors it
 * at a minute and never writes it back to the user's own focus length.
 */
const DEFAULT_PLANNED_SECONDS = 1500;

function plannedSeconds(task: Task): number {
  return task.duration !== null && task.duration.unit === "minute"
    ? task.duration.amount * 60
    : DEFAULT_PLANNED_SECONDS;
}

/**
 * The link that starts a Light Minute session already counting against a task.
 *
 * Exported for its own test. `taskId` is all the recording needs; the title and
 * project ride along so the timer can say on screen what it is counting,
 * without a round trip or even a signed-in app at the other end.
 *
 * Built by hand rather than with URLSearchParams, which spells a space "+".
 * The other end reads the query with URLComponents, and that leaves a "+"
 * standing — a task would arrive titled "Ready+the+deck".
 */
export function focusLink(task: Task, projectName: string | null): string {
  const fields: [string, string][] = [
    ["taskId", task.id],
    ["title", task.content],
  ];
  if (projectName !== null) fields.push(["projectName", projectName]);
  fields.push(["projectId", task.projectId]);
  fields.push(["planned", String(plannedSeconds(task))]);

  const query = fields.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&");
  return `com.lightminute.app:/focus?${query}`;
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

/** What the date menu offers, in the order it offers it. */
const WHEN: { target: RescheduleTarget; label: string }[] = [
  { target: "today", label: "Today" },
  { target: "tomorrow", label: "Tomorrow" },
  { target: "weekend", label: "This weekend" },
  { target: "next-week", label: "Next week" },
  { target: null, label: "No date" },
];

const PRIORITIES: Priority[] = [1, 2, 3, 4];

/**
 * Controls that keep their own press. A press that starts on anything marked
 * `data-no-drag` never starts a drag; see `mountDrag` for why React's own
 * `stopPropagation` cannot do this.
 */
const NO_DRAG = "[data-no-drag]";

export function TaskRow({
  task,
  store,
  ops,
  today,
  parentTitle = null,
  selected,
  onComplete,
  onSelect,
  onEdit,
  onMoveUp,
  onMoveDown,
  onReschedule,
  onPickDay,
  onPriority,
  onDrop,
}: {
  task: Task;
  store: LightStore;
  ops: Operations;
  today: string;
  /** Set when this is a subtask shown away from its parent; see `foldSubtasks`. */
  parentTitle?: string | null;
  selected: boolean;
  onComplete: () => void;
  onSelect: () => void;
  onEdit: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onReschedule: (target: RescheduleTarget) => void;
  /** A day picked from the calendar, `YYYY-MM-DD`. */
  onPickDay: (day: string) => void;
  onPriority: (priority: Priority) => void;
  /**
   * Where a drag of this row was let go. Absent where dragging would mean
   * nothing — a list ordered by date or by when it was finished — and the row
   * is then not draggable at all.
   */
  onDrop?: (event: PointerEvent) => void;
}) {
  const labels = task.labelIds
    .map((id) => store.get("label", id))
    .filter((label): label is Label => label !== null);

  const focus = ops.focusStatsForTask(task.id);
  const overdue = task.due !== null && task.due.date.slice(0, 10) < today;
  // Carried in the focus link so Light Minute can say which project it is
  // counting against, without asking the server.
  const project = store.get("project", task.projectId);

  const dateItems: MenuItem[] = WHEN.map(({ target, label }) => ({
    key: target ?? "none",
    label,
    onSelect: () => onReschedule(target),
  }));
  const priorityItems: MenuItem[] = PRIORITIES.map((priority) => ({
    key: String(priority),
    label: `p${priority} ${PRIORITY_NAME[priority]}`,
    checked: task.priority === priority,
    onSelect: () => onPriority(priority),
  }));

  const card = (
    <>
      {onDrop !== undefined && (
        // The handle is what a finger takes hold of: it alone is
        // `touch-action: none`, so the rest of the row still scrolls the page.
        // A mouse can take the row anywhere that is not a control.
        <span className="row-grip" aria-hidden="true" title="Drag to reorder">
          ⋮⋮
        </span>
      )}

      {/* Large on purpose: finishing something is the most common act in
          this app, and it is also how you put a task back — a completed row
          stays in place with the box filled, so clicking it again is the
          obvious way to reopen rather than something to go looking for. */}
      <label className="dn-check check-big" data-no-drag>
        <input
          type="checkbox"
          checked={task.isCompleted}
          aria-label={task.isCompleted ? `Reopen ${task.content}` : `Complete ${task.content}`}
          onChange={onComplete}
        />
      </label>

      {/* A div, not a button: the date and priority are buttons now, and a
          button cannot hold buttons. The title is the keyboard way in, and a
          click anywhere else on the body selects, as it always did. */}
      <div className="dn-row__body" onClick={onSelect}>
        <button type="button" className="row-title">
          <span className={task.isCompleted ? "title done" : "title"}>{task.content}</span>
        </button>

        <span className="meta">
          {task.priority < 4 ? (
            <RowMenu
              label={`Priority of ${task.content}: p${task.priority}`}
              triggerClassName={`${PRIORITY_BADGE[task.priority]} row-chip`}
              trigger={`p${task.priority} ${PRIORITY_NAME[task.priority]}`}
              items={priorityItems}
            />
          ) : (
            // Nothing on the row says "none", so the way in is a quiet chip
            // that only shows when the row is looked at.
            <RowMenu
              label={`Set priority of ${task.content}`}
              triggerClassName="dn-badge dn-badge--outline row-chip row-chip--add"
              trigger="priority"
              items={priorityItems}
            />
          )}

          <RowMenu
            label={
              task.due === null
                ? `Schedule ${task.content}`
                : `Reschedule ${task.content}, now ${formatDay(task.due.date, today)}`
            }
            triggerClassName={
              task.due === null
                ? "dn-badge dn-badge--outline row-chip row-chip--add"
                : `${overdue ? "dn-badge dn-badge--danger" : "dn-badge"} row-chip`
            }
            trigger={
              task.due === null ? (
                "date"
              ) : (
                <>
                  {formatDay(task.due.date, today)}
                  {task.due.isRecurring && <i title={task.due.text ?? ""} />}
                </>
              )
            }
            items={dateItems}
            footer={(close) => (
              <label className="row-menu__pick">
                <span className="dn-hint">Pick a date</span>
                <input
                  type="date"
                  className="dn-input"
                  aria-label={`Pick a date for ${task.content}`}
                  onChange={(event) => {
                    if (event.target.value === "") return;
                    onPickDay(event.target.value);
                    close();
                  }}
                />
              </label>
            )}
          />

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

          {/* Shown on the row because it is the point: the reward is what
              makes finishing worth starting. */}
          {task.reward !== null && task.reward !== "" && (
            <span className="dn-badge dn-badge--outline reward" title="What finishing this earns">
              ★ {task.reward}
            </span>
          )}

          {focus.sessions > 0 && (
            <span className="dn-badge dn-badge--outline" title={`${focus.sessions} focus session(s)`}>
              focused {humanDuration(focus.focusedSeconds)}
            </span>
          )}
        </span>

        {/* A subtask on its own would read as an unrelated task, so it says
            whose it is. */}
        {parentTitle !== null && <span className="dn-hint description">Subtask of {parentTitle}</span>}

        {task.description !== "" && <span className="dn-hint description">{task.description}</span>}
      </div>

      <span className="dn-row__aside" data-no-drag>
        {/* Rendered on every platform, deliberately. On an iPhone this hands
            the task to Light Minute; in a desktop browser the scheme resolves
            to nothing and the click does nothing, which is honest and costs
            nothing. Reading the user agent to hide it would be guesswork that
            breaks on the next device. */}
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm"
          aria-label={`Edit ${task.content}`}
          onClick={onEdit}
        >
          Edit
        </button>
        {!task.isCompleted && (
          <a
            className="dn-btn dn-btn--ghost dn-btn--sm"
            aria-label={`Focus on ${task.content}`}
            href={focusLink(task, project === null ? null : project.name)}
          >
            Focus
          </a>
        )}
        {/* These stay beside the drag. They are the same act for the keyboard
            and for a screen reader, which cannot drag — but they are not worth
            two permanent buttons on every row, so they wait for a pointer or
            for focus. See `.reorder` in styles.css. */}
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm reorder"
          aria-label={`Move ${task.content} up`}
          onClick={onMoveUp}
        >
          ↑
        </button>
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm reorder"
          aria-label={`Move ${task.content} down`}
          onClick={onMoveDown}
        >
          ↓
        </button>
      </span>
    </>
  );

  // Selecting a task lifts it off the page — elevation is how this system says
  // "this one". It is a class rather than an inline style because a drag in
  // hand sets `--dn-elev` on the element and clears it again on the way out,
  // which would take an inline one with it.
  const className = `dn-row task${selected ? " selected" : ""}`;

  return (
    <li data-task-id={task.id}>
      {onDrop === undefined ? (
        <div className={`dn-card ${className}`}>{card}</div>
      ) : (
        <Draggable
          baseClass="dn-card"
          className={`${className} row-draggable`}
          ignore={NO_DRAG}
          onLand={onDrop}
        >
          {card}
        </Draggable>
      )}
    </li>
  );
}
