/**
 * The task editor.
 *
 * Until this existed, a task could be created and completed but never changed:
 * `Operations.updateTask` had no caller anywhere in the repo. Everything here
 * was already on `Task` — priority, due, deadline, duration, labels — and
 * simply had no way in.
 *
 * It is a form with local state and one Save, rather than a field-by-field
 * live edit. Sync merges per field, so a live edit would be correct, but it
 * would also mean a round of ops for every keystroke and no way to change your
 * mind. Cancel has to mean something.
 *
 * The form opens from whatever the task says now (`useEffect` on the id), so
 * reopening after a cancel does not show the abandoned draft.
 */

import { useEffect, useState } from "react";
import type { Label, Priority, Project, Task } from "@light/core";
import type { LightStore, Operations } from "@light/client-sdk";
import type { Op } from "@light/core";
import { Sheet } from "../diurnal.js";
import { atDay, atTime, clock, dueDay, dueMinutes } from "../schedule.js";

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: 1, label: "p1 — urgent" },
  { value: 2, label: "p2 — high" },
  { value: 3, label: "p3 — medium" },
  { value: 4, label: "p4 — none" },
];

/** The labels on a task, as the text the field shows. */
function labelText(task: Task, store: LightStore): string {
  return task.labelIds
    .map((id) => store.get("label", id))
    .filter((label): label is Label => label !== null)
    .map((label) => label.name)
    .join(", ");
}

/** Label names out of a typed line, `@` optional and duplicates dropped. */
function parseLabels(input: string): string[] {
  const names = input
    .split(/[,\s]+/)
    .map((name) => name.replace(/^@/, "").trim())
    .filter((name) => name !== "");
  return [...new Set(names)];
}

interface Draft {
  content: string;
  description: string;
  priority: Priority;
  /** `YYYY-MM-DD`, or empty for unscheduled. */
  dueDate: string;
  /** `HH:MM`, or empty for all-day. */
  dueTime: string;
  deadline: string;
  /** Minutes, as typed; empty means no estimate. */
  duration: string;
  labels: string;
  reward: string;
  projectId: string;
}

function draftOf(task: Task, store: LightStore): Draft {
  const minutes = dueMinutes(task.due);
  return {
    content: task.content,
    description: task.description,
    priority: task.priority,
    dueDate: dueDay(task.due) ?? "",
    dueTime: minutes === null ? "" : clock(minutes),
    deadline: task.deadline?.date ?? "",
    duration:
      task.duration !== null && task.duration.unit === "minute" ? String(task.duration.amount) : "",
    labels: labelText(task, store),
    reward: task.reward ?? "",
    projectId: task.projectId,
  };
}

/** `HH:MM` to minutes past midnight, or null if it is not a time. */
function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function TaskEditor({
  task,
  store,
  ops,
  commit,
  rewardsEnabled,
  onClose,
}: {
  /** Null when nothing is being edited; the sheet stays mounted either way. */
  task: Task | null;
  store: LightStore;
  ops: Operations;
  commit: (ops: Op[]) => void;
  rewardsEnabled: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);

  // Reload from the store whenever a different task is opened — including
  // reopening the same one after a cancel, which is why the whole task is the
  // dependency rather than just its id.
  useEffect(() => {
    setDraft(task === null ? null : draftOf(task, store));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task === null]);

  const projects = store
    .all("project")
    .filter((project) => !project.isArchived)
    .sort((a, b) => a.name.localeCompare(b.name));

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
  }

  function save() {
    if (task === null || draft === null) return;
    const content = draft.content.trim();
    if (content === "") return;

    const staged: Op[] = [];

    // A date with a readable time is a timed task; a date on its own is an
    // all-day one; no date at all is unscheduled. Unreadable time text falls
    // back to all-day rather than throwing the date away.
    const minutes = parseClock(draft.dueTime);
    const due =
      draft.dueDate === ""
        ? null
        : minutes === null
          ? atDay(draft.dueDate, task.due)
          : atTime(draft.dueDate, minutes, task.due);

    const amount = Number(draft.duration);
    const duration =
      draft.duration.trim() === "" || !Number.isFinite(amount) || amount <= 0
        ? null
        : { amount: Math.round(amount), unit: "minute" as const };

    staged.push(
      ...ops.updateTask(task.id, {
        content,
        description: draft.description,
        priority: draft.priority,
        due,
        deadline: draft.deadline === "" ? null : { date: draft.deadline },
        duration,
        // Empty is not null: it means a reward was set and then cleared, and
        // the model keeps that distinction deliberately.
        reward: draft.reward.trim() === "" ? (task.reward === null ? null : "") : draft.reward.trim(),
      }).ops,
    );

    // Labels go through add/remove rather than `labelIds`, because those are
    // what create a label the account has not seen before.
    const wanted = parseLabels(draft.labels);
    const current = parseLabels(labelText(task, store));
    for (const name of wanted.filter((name) => !current.includes(name))) {
      staged.push(...ops.addLabel(task.id, name).ops);
    }
    for (const name of current.filter((name) => !wanted.includes(name))) {
      staged.push(...ops.removeLabel(task.id, name).ops);
    }

    // Moving is its own operation: it has to re-place the task in the target
    // list's ordering, which a field patch cannot do.
    if (draft.projectId !== task.projectId) {
      staged.push(...ops.moveTask(task.id, { projectId: draft.projectId }).ops);
    }

    commit(staged);
    onClose();
  }

  return (
    <Sheet open={task !== null} title="Edit task" onClose={onClose}>
      {draft === null ? null : (
        <form
          className="editor"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <h2 className="editor-title">Edit task</h2>

          <div className="dn-field">
            <label className="dn-label" htmlFor="editor-content">
              Task
            </label>
            <input
              id="editor-content"
              className="dn-input"
              value={draft.content}
              autoFocus
              onChange={(event) => set("content", event.target.value)}
            />
          </div>

          <div className="dn-field">
            <label className="dn-label" htmlFor="editor-description">
              Notes
            </label>
            <textarea
              id="editor-description"
              className="dn-textarea"
              rows={3}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
            />
          </div>

          <div className="editor-row">
            <div className="dn-field">
              <label className="dn-label" htmlFor="editor-priority">
                Priority
              </label>
              <select
                id="editor-priority"
                className="dn-select"
                value={draft.priority}
                onChange={(event) => set("priority", Number(event.target.value) as Priority)}
              >
                {PRIORITIES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="dn-field">
              <label className="dn-label" htmlFor="editor-project">
                Project
              </label>
              <select
                id="editor-project"
                className="dn-select"
                value={draft.projectId}
                onChange={(event) => set("projectId", event.target.value)}
              >
                {projects.map((project: Project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="editor-row">
            <div className="dn-field">
              <label className="dn-label" htmlFor="editor-due">
                When you will do it
              </label>
              <input
                id="editor-due"
                className="dn-input"
                type="date"
                value={draft.dueDate}
                onChange={(event) => set("dueDate", event.target.value)}
              />
            </div>

            <div className="dn-field">
              <label className="dn-label" htmlFor="editor-due-time">
                At (optional)
              </label>
              <input
                id="editor-due-time"
                className="dn-input"
                type="time"
                step={900}
                value={draft.dueTime}
                disabled={draft.dueDate === ""}
                onChange={(event) => set("dueTime", event.target.value)}
              />
            </div>
          </div>

          <div className="editor-row">
            <div className="dn-field">
              {/* Named for the difference, because the two dates sitting next
                  to each other is exactly where it gets confusing. */}
              <label className="dn-label" htmlFor="editor-deadline">
                Deadline — when it is owed
              </label>
              <input
                id="editor-deadline"
                className="dn-input"
                type="date"
                value={draft.deadline}
                onChange={(event) => set("deadline", event.target.value)}
              />
            </div>

            <div className="dn-field">
              <label className="dn-label" htmlFor="editor-duration">
                Estimate (minutes)
              </label>
              <input
                id="editor-duration"
                className="dn-input"
                type="number"
                min={1}
                // Step 1, not 5: with min=1 a step of 5 makes the valid values
                // 1, 6, 11 — so 30 and 90, which are the only numbers anyone
                // types here, both fail validation and the form refuses to
                // submit without saying why.
                step={1}
                value={draft.duration}
                placeholder="30"
                onChange={(event) => set("duration", event.target.value)}
              />
            </div>
          </div>

          <div className="dn-field">
            <label className="dn-label" htmlFor="editor-labels">
              Labels
            </label>
            <input
              id="editor-labels"
              className="dn-input"
              value={draft.labels}
              placeholder="deep, admin"
              onChange={(event) => set("labels", event.target.value)}
            />
          </div>

          {rewardsEnabled && (
            <div className="dn-field">
              <label className="dn-label" htmlFor="editor-reward">
                Reward
              </label>
              <input
                id="editor-reward"
                className="dn-input"
                value={draft.reward}
                placeholder="An hour in the sun"
                onChange={(event) => set("reward", event.target.value)}
              />
              <span className="dn-hint">
                Finishing this files the reward in Rewards, to look back on.
              </span>
            </div>
          )}

          <div className="editor-actions">
            <button className="dn-btn dn-btn--primary" type="submit" disabled={draft.content.trim() === ""}>
              Save
            </button>
            <button className="dn-btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <span className="spacer" />
            <button
              className="dn-btn dn-btn--ghost"
              type="button"
              onClick={() => {
                if (task === null) return;
                commit(ops.deleteTask(task.id).ops);
                onClose();
              }}
            >
              Delete
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
