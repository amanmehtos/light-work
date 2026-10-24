/**
 * Domain operations.
 *
 * One place where "complete a task" or "move a task" is defined, so the web app,
 * the desktop app, the iPhone app and the MCP server cannot disagree about what
 * those mean. Each operation stages ops on the store and returns them; the
 * caller hands them to the sync client.
 */

import {
  DEFAULT_COLOR,
  type Due,
  type FocusSession,
  type Label,
  type Op,
  type Priority,
  type Project,
  type Section,
  type Task,
  compareOrder,
  newId,
} from "@light/core";
import { nextOccurrence, parseRecurrence } from "./recurrence.js";
import type { LightStore } from "./store.js";

export interface Staged<T> {
  result: T;
  ops: Op[];
}

export class Operations {
  constructor(private readonly store: LightStore) {}

  /* ---------------------------------------------------------- */
  /* ordering helpers                                           */
  /* ---------------------------------------------------------- */

  /** Siblings of a task, in order, within whatever list it belongs to. */
  private siblings(task: Pick<Task, "projectId" | "sectionId" | "parentId">): Task[] {
    return this.store
      .all("task")
      .filter(
        (candidate) =>
          candidate.parentId === task.parentId &&
          candidate.sectionId === task.sectionId &&
          candidate.projectId === task.projectId,
      )
      .sort((a, b) => compareOrder(a.order, b.order));
  }

  private orderAtEnd(of: Pick<Task, "projectId" | "sectionId" | "parentId">): string {
    const siblings = this.siblings(of);
    const last = siblings[siblings.length - 1];
    return this.store.orderBetween(last?.order ?? null, null);
  }

  /* ---------------------------------------------------------- */
  /* projects, sections, labels                                 */
  /* ---------------------------------------------------------- */

  createProject(input: {
    name: string;
    parentId?: string | null;
    color?: string;
    view?: Project["view"];
    isFavorite?: boolean;
    description?: string;
  }): Staged<Project> {
    const parentId = input.parentId ?? null;
    const siblings = this.store
      .all("project")
      .filter((project) => project.parentId === parentId)
      .sort((a, b) => compareOrder(a.order, b.order));

    const project: Project = {
      id: newId(),
      parentId,
      name: input.name,
      color: input.color ?? DEFAULT_COLOR,
      order: this.store.orderBetween(siblings[siblings.length - 1]?.order ?? null, null),
      view: input.view ?? "list",
      isFavorite: input.isFavorite ?? false,
      isArchived: false,
      isInbox: false,
      isCollapsed: false,
      description: input.description ?? "",
    };
    return { result: project, ops: [this.store.mutate("project", project.id, project)] };
  }

  createSection(input: {
    projectId: string;
    name: string;
    description?: string;
  }): Staged<Section> {
    const siblings = this.store
      .all("section")
      .filter((section) => section.projectId === input.projectId)
      .sort((a, b) => compareOrder(a.order, b.order));

    const section: Section = {
      id: newId(),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? "",
      order: this.store.orderBetween(siblings[siblings.length - 1]?.order ?? null, null),
      isArchived: false,
      isCollapsed: false,
    };
    return { result: section, ops: [this.store.mutate("section", section.id, section)] };
  }

  createLabel(input: { name: string; color?: string }): Staged<Label> {
    const existing = this.store.all("label").find((label) => label.name === input.name);
    if (existing !== undefined) return { result: existing, ops: [] };

    const siblings = this.store.ordered("label");
    const label: Label = {
      id: newId(),
      name: input.name,
      color: input.color ?? DEFAULT_COLOR,
      order: this.store.orderBetween(siblings[siblings.length - 1]?.order ?? null, null),
      isFavorite: false,
    };
    return { result: label, ops: [this.store.mutate("label", label.id, label)] };
  }

  /* ---------------------------------------------------------- */
  /* tasks                                                      */
  /* ---------------------------------------------------------- */

  createTask(input: {
    projectId: string;
    content: string;
    description?: string;
    sectionId?: string | null;
    parentId?: string | null;
    priority?: Priority;
    due?: Due | null;
    deadline?: { date: string } | null;
    duration?: Task["duration"];
    labelNames?: string[];
  }): Staged<Task> {
    const ops: Op[] = [];
    const labelIds: string[] = [];
    for (const name of input.labelNames ?? []) {
      const staged = this.createLabel({ name });
      ops.push(...staged.ops);
      labelIds.push(staged.result.id);
    }

    const placement = {
      projectId: input.projectId,
      sectionId: input.sectionId ?? null,
      parentId: input.parentId ?? null,
    };

    const task: Task = {
      id: newId(),
      ...placement,
      content: input.content,
      description: input.description ?? "",
      priority: input.priority ?? 4,
      order: this.orderAtEnd(placement),
      dayOrder: null,
      due: input.due ?? null,
      deadline: input.deadline ?? null,
      duration: input.duration ?? null,
      labelIds,
      isCompleted: false,
      completedAt: null,
      isCollapsed: false,
      assigneeId: null,
      addedById: null,
      createdAt: new Date().toISOString(),
    };
    ops.push(this.store.mutate("task", task.id, task));
    return { result: task, ops };
  }

  updateTask(
    id: string,
    changes: Partial<
      Pick<
        Task,
        "content" | "description" | "priority" | "due" | "deadline" | "duration" | "labelIds"
      >
    >,
  ): Staged<Task | null> {
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };
    const op = this.store.mutate("task", id, changes);
    return { result: this.store.get("task", id), ops: [op] };
  }

  /**
   * Completes a task.
   *
   * A recurring task is not completed but rescheduled, which is what Todoist
   * does and what users rely on. When the recurrence phrase cannot be parsed the
   * task is completed normally and `rescheduled` is false, so the caller can say
   * so rather than quietly dropping the repeat.
   */
  completeTask(
    id: string,
    completedOn: string = new Date().toISOString().slice(0, 10),
  ): Staged<{ task: Task | null; rescheduled: boolean; recurrenceUnderstood: boolean }> {
    const task = this.store.get("task", id);
    if (task === null) {
      return { result: { task: null, rescheduled: false, recurrenceUnderstood: true }, ops: [] };
    }

    if (task.due !== null && task.due.isRecurring) {
      const recurrence = parseRecurrence(task.due.text);
      if (recurrence !== null) {
        const next = nextOccurrence(recurrence, task.due.date, completedOn);
        const op = this.store.mutate("task", id, {
          due: { ...task.due, date: next },
        });
        return {
          result: { task: this.store.get("task", id), rescheduled: true, recurrenceUnderstood: true },
          ops: [op],
        };
      }
      // Unparsable recurrence: complete it, and let the caller report that the
      // repeat was lost rather than inventing a date.
      const op = this.store.mutate("task", id, {
        isCompleted: true,
        completedAt: new Date().toISOString(),
      });
      return {
        result: { task: this.store.get("task", id), rescheduled: false, recurrenceUnderstood: false },
        ops: [op],
      };
    }

    const op = this.store.mutate("task", id, {
      isCompleted: true,
      completedAt: new Date().toISOString(),
    });
    return {
      result: { task: this.store.get("task", id), rescheduled: false, recurrenceUnderstood: true },
      ops: [op],
    };
  }

  uncompleteTask(id: string): Staged<Task | null> {
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };
    const op = this.store.mutate("task", id, { isCompleted: false, completedAt: null });
    return { result: this.store.get("task", id), ops: [op] };
  }

  deleteTask(id: string): Staged<{ deleted: string[] }> {
    const ops: Op[] = [];
    const deleted: string[] = [];

    // Subtasks go with the parent, depth first, or they are left orphaned.
    const collect = (parentId: string): void => {
      for (const child of this.store.all("task").filter((t) => t.parentId === parentId)) {
        collect(child.id);
        ops.push(this.store.remove("task", child.id));
        deleted.push(child.id);
      }
    };
    collect(id);

    if (this.store.get("task", id) !== null) {
      ops.push(this.store.remove("task", id));
      deleted.push(id);
    }
    return { result: { deleted }, ops };
  }

  /** Moves a task to another project, section or parent, placing it last. */
  moveTask(
    id: string,
    target: { projectId?: string; sectionId?: string | null; parentId?: string | null },
  ): Staged<Task | null> {
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };

    const placement = {
      projectId: target.projectId ?? task.projectId,
      sectionId: target.sectionId === undefined ? task.sectionId : target.sectionId,
      parentId: target.parentId === undefined ? task.parentId : target.parentId,
    };

    // A task cannot become its own ancestor; that would detach the subtree.
    if (placement.parentId !== null && this.isDescendant(placement.parentId, id)) {
      throw new Error("cannot move a task beneath one of its own subtasks");
    }

    const op = this.store.mutate("task", id, {
      ...placement,
      order: this.orderAtEnd(placement),
    });
    return { result: this.store.get("task", id), ops: [op] };
  }

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    let current = this.store.get("task", candidateId);
    let guard = 0;
    while (current !== null && guard < 1000) {
      if (current.id === ancestorId) return true;
      if (current.parentId === null) return false;
      current = this.store.get("task", current.parentId);
      guard += 1;
    }
    return false;
  }

  /**
   * Reorders a task within its list, placing it directly after `afterId`.
   *
   * Passing `null` moves it to the head. Only the moved task is written — this
   * is the whole point of fractional indexing, and it is what lets two devices
   * reorder different items without conflicting.
   */
  reorderTask(id: string, afterId: string | null): Staged<Task | null> {
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };

    const siblings = this.siblings(task).filter((sibling) => sibling.id !== id);

    let before: string | null = null;
    let after: string | null = siblings[0]?.order ?? null;

    if (afterId !== null) {
      const index = siblings.findIndex((sibling) => sibling.id === afterId);
      if (index === -1) throw new Error(`${afterId} is not a sibling of ${id}`);
      before = siblings[index]!.order;
      after = siblings[index + 1]?.order ?? null;
    }

    const op = this.store.mutate("task", id, { order: this.store.orderBetween(before, after) });
    return { result: this.store.get("task", id), ops: [op] };
  }

  addLabel(taskId: string, name: string): Staged<Task | null> {
    const task = this.store.get("task", taskId);
    if (task === null) return { result: null, ops: [] };

    const staged = this.createLabel({ name });
    if (task.labelIds.includes(staged.result.id)) {
      return { result: task, ops: staged.ops };
    }
    const op = this.store.mutate("task", taskId, {
      labelIds: [...task.labelIds, staged.result.id],
    });
    return { result: this.store.get("task", taskId), ops: [...staged.ops, op] };
  }

  removeLabel(taskId: string, name: string): Staged<Task | null> {
    const task = this.store.get("task", taskId);
    if (task === null) return { result: null, ops: [] };
    const label = this.store.all("label").find((candidate) => candidate.name === name);
    if (label === undefined) return { result: task, ops: [] };

    const op = this.store.mutate("task", taskId, {
      labelIds: task.labelIds.filter((id) => id !== label.id),
    });
    return { result: this.store.get("task", taskId), ops: [op] };
  }

  /* ---------------------------------------------------------- */
  /* focus — the Light Minute bridge                            */
  /* ---------------------------------------------------------- */

  /**
   * Records a block of focus against a task.
   *
   * Written by Light Minute when a timer finishes, and by an agent through MCP
   * when reconstructing a session after the fact. This is the data that makes
   * Light Week more than a task list: planning can be informed by where
   * attention actually went.
   */
  logFocusSession(input: {
    taskId?: string | null;
    projectId?: string | null;
    startedAt: string;
    endedAt?: string | null;
    plannedSeconds: number;
    focusedSeconds: number;
    kind?: FocusSession["kind"];
    outcome?: FocusSession["outcome"];
    interruptions?: number;
    source: string;
    note?: string | null;
  }): Staged<FocusSession> {
    const session: FocusSession = {
      id: newId(),
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      plannedSeconds: input.plannedSeconds,
      focusedSeconds: input.focusedSeconds,
      kind: input.kind ?? "focus",
      outcome: input.outcome ?? "completed",
      interruptions: input.interruptions ?? 0,
      source: input.source,
      note: input.note ?? null,
    };
    return { result: session, ops: [this.store.mutate("focusSession", session.id, session)] };
  }

  /** Total focused time and session count for a task. */
  focusStatsForTask(taskId: string): {
    sessions: number;
    focusedSeconds: number;
    interruptions: number;
    lastSessionAt: string | null;
  } {
    const sessions = this.store
      .all("focusSession")
      .filter((session) => session.taskId === taskId && session.kind === "focus");

    let focusedSeconds = 0;
    let interruptions = 0;
    let lastSessionAt: string | null = null;
    for (const session of sessions) {
      focusedSeconds += session.focusedSeconds;
      interruptions += session.interruptions;
      if (lastSessionAt === null || session.startedAt > lastSessionAt) {
        lastSessionAt = session.startedAt;
      }
    }
    return { sessions: sessions.length, focusedSeconds, interruptions, lastSessionAt };
  }
}
