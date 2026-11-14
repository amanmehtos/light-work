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
  PREFERENCES_ID,
} from "@light/core";
import {
  parseQuickAdd,
  parseQuickAddStrict,
  type Problem,
  type QuickAddParse,
  type QuickAddSchedule,
} from "./parse.js";
import { placeInDay, tasksOnDay, type DayScope } from "./day-order.js";
import { nextOccurrence, parseRecurrence } from "./recurrence.js";
import type { LightStore } from "./store.js";
import { instantAt } from "./wallclock.js";

export interface Staged<T> {
  result: T;
  ops: Op[];
}

/**
 * A strict Quick Add that would not read a line, and what it could not read.
 *
 * Thrown rather than returned so that nothing can stage an op from a refused
 * parse by forgetting to look: the write simply does not happen. `message`
 * already names every problem, quoting the text, and is meant to be handed
 * straight back to whoever typed the line.
 */
export class QuickAddRefusal extends Error {
  constructor(
    readonly problems: Problem[],
    message: string,
  ) {
    super(message);
    this.name = "QuickAddRefusal";
  }
}

export interface QuickAddInput {
  /** The local calendar day, `YYYY-MM-DD`. Every relative date is read against it. */
  today: string;
  /** Where the task goes when the text names no `#Project`. The inbox when absent. */
  defaultProjectId?: string;
  /** IANA zone a time of day is read in. The machine's own when absent. */
  timezone?: string;
  /** The wall-clock time now, `HH:MM`, on `today`; see `QuickAddOptions.now`. */
  now?: string;
  /**
   * Refuse, rather than proceed, on anything the parser declined or had to
   * assume. For callers with nobody watching — see `parseQuickAddStrict`.
   */
  strict?: boolean;
  /** Token text the person took back; see `QuickAddOptions.ignore`. */
  ignore?: readonly string[];
  /**
   * A day chosen outright, which replaces whatever schedule the text gave. The
   * add-task field's date input is the answer when the parser is wrong, and it
   * has to be able to win.
   */
  dueDate?: string | null;
}

/**
 * Where "reschedule" can send a task. `null` is not a destination but the
 * absence of one: it unschedules, which is why the type is a union with it
 * rather than a fifth word.
 */
export type RescheduleTarget = "today" | "tomorrow" | "next-week" | "weekend" | null;

/**
 * The day a reschedule lands on, as `YYYY-MM-DD`, or null for "no date".
 *
 * Every client rounds through this one function — the web row menu, the phone's
 * swipe, an agent — so "next week" cannot mean a different Monday on each.
 * `today` is the caller's local calendar day, passed in because only the caller
 * knows whose zone it is; it is never read off a clock here. The calendar
 * arithmetic is on the string in UTC, which for a plain date is exact.
 *
 * The two vague words, pinned:
 *
 * - **next week** is the Monday strictly after today. On a Monday it is the
 *   Monday a week away, never today. This is what the Quick Add parser already
 *   reads "next week" as, so typing it and picking it agree.
 * - **weekend** is the first Saturday or Sunday on or after today. Saturday and
 *   Sunday are themselves the weekend, so asking for it then means today.
 *   The alternative, "the next Saturday strictly after today", was rejected
 *   because on a Sunday it would skip a weekend the person is standing in.
 *   Swift's `Schedule.day(for:today:)` is the twin and shares this table.
 */
export function rescheduleDay(target: RescheduleTarget, today: string): string | null {
  if (target === null) return null;
  const shift = (days: number): string =>
    new Date(new Date(`${today}T00:00:00.000Z`).getTime() + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday

  switch (target) {
    case "today":
      return today;
    case "tomorrow":
      return shift(1);
    case "next-week":
      return shift((1 - weekday + 7) % 7 || 7);
    case "weekend":
      // Saturday is 6 and Sunday is 0; from Monday (1) to Friday (5) the
      // distance to Saturday is 6 - weekday.
      return weekday === 0 ? today : shift(weekday === 6 ? 0 : 6 - weekday);
  }
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
    /**
     * Marks the account's inbox. Almost nothing should pass this — `ensureInbox`
     * is the way to get one — and it refuses to make a second.
     */
    isInbox?: boolean;
  }): Staged<Project> {
    // The only-one rule lives here as well as in `ensureInbox`, because this is
    // the door a caller with a flag in hand would use, and every view of the
    // account assumes the inbox is a single place.
    if (input.isInbox === true && this.store.all("project").some((p) => p.isInbox)) {
      throw new Error("the account already has an inbox");
    }
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
      isInbox: input.isInbox ?? false,
      isRewards: false,
      isCollapsed: false,
      description: input.description ?? "",
    };
    return { result: project, ops: [this.store.mutate("project", project.id, project)] };
  }

  /**
   * The account's inbox: where a task goes when nobody said where.
   *
   * Until this existed nothing but the Todoist importer ever set `isInbox`, so
   * an account that had never imported had a project that was merely *named*
   * "Inbox" — one `deleteProject` would happily delete, because the guard keys
   * off the flag and not the name. This makes the flag true for everyone.
   *
   * Three cases, in order. An `isInbox` project is returned as it is. Failing
   * that, a top-level project literally called "Inbox" is adopted rather than
   * joined by a twin: it is what the web app used to create, so for every
   * account that predates this method it *is* the inbox, minus the flag, and
   * flagging it is a one-field edit where a second "Inbox" in the sidebar would
   * be a visible regression. Only when neither exists is one created.
   *
   * "Only ever one" is enforced against what this store can see. Two devices
   * that both open a brand-new account before either has synced can each
   * create one, and nothing here can prevent that; when it happens every
   * device agrees which one to use (the lowest id), so the extra is inert
   * rather than a split-brain.
   */
  ensureInbox(): Staged<Project> {
    const projects = this.store.all("project");

    // Sorted by id, not by `compareOrder`: that compares fractional-index
    // `order` keys, and an id is not one. Ids are time-prefixed, so plain
    // lexicographic order is creation order — which is all this needs, a rule
    // every device will reach the same answer by.
    const byId = (a: Project, b: Project) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    const flagged = projects.filter((project) => project.isInbox).sort(byId);
    if (flagged[0] !== undefined) return { result: flagged[0], ops: [] };

    const named = projects
      .filter(
        (project) =>
          project.name === "Inbox" && project.parentId === null && !project.isRewards,
      )
      .sort(byId);
    if (named[0] !== undefined) {
      const op = this.store.mutate("project", named[0].id, { isInbox: true });
      return { result: this.store.get("project", named[0].id) ?? named[0], ops: [op] };
    }

    return this.createProject({ name: "Inbox", isInbox: true });
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

  /**
   * Renames or re-describes a section, or archives it.
   *
   * Sparse, like `updateTask`: only what is passed is written. Where a section
   * sits and whether it is folded are not here, because each has an operation
   * that knows what it is doing (`reorderSection`, `setCollapsed`).
   */
  updateSection(
    id: string,
    changes: Partial<Pick<Section, "name" | "description" | "isArchived">>,
  ): Staged<Section | null> {
    const section = this.store.get("section", id);
    if (section === null) return { result: null, ops: [] };
    const op = this.store.mutate("section", id, changes);
    return { result: this.store.get("section", id), ops: [op] };
  }

  /**
   * Puts a section directly after `afterId`, or first with `null`.
   *
   * The twin of `reorderTask` and for the same reason: only the moved section is
   * written, so two devices reordering different sections do not conflict.
   * Archived siblings count — they still have an `order`, and skipping them
   * would put the key between the wrong neighbours.
   */
  reorderSection(id: string, afterId: string | null): Staged<Section | null> {
    const section = this.store.get("section", id);
    if (section === null) return { result: null, ops: [] };

    const siblings = this.store
      .all("section")
      .filter((candidate) => candidate.projectId === section.projectId && candidate.id !== id)
      .sort((a, b) => compareOrder(a.order, b.order));

    let before: string | null = null;
    let after: string | null = siblings[0]?.order ?? null;
    if (afterId !== null) {
      const index = siblings.findIndex((sibling) => sibling.id === afterId);
      if (index === -1) throw new Error(`${afterId} is not a section of the same project as ${id}`);
      before = siblings[index]!.order;
      after = siblings[index + 1]?.order ?? null;
    }

    const op = this.store.mutate("section", id, { order: this.store.orderBetween(before, after) });
    return { result: this.store.get("section", id), ops: [op] };
  }

  /**
   * Deletes a section and keeps everything that was in it.
   *
   * A section is a heading, not a container of record: it says where a run of
   * tasks sits, and the tasks are the work. Deleting the heading must not delete
   * the work, so every task that named it (subtasks too, which carry their
   * parent's section) is put back at the project root, after whatever already
   * lives there and in the order it had. This is the opposite of
   * `deleteProject`, which is a container and does take its sections' tasks —
   * and an agent calling `delete_section` gets this behaviour, not that one.
   *
   * The section's own description goes with it; that is the one thing a
   * section holds that a task does not.
   *
   * Ordering is per list, so the new position is worked out per list: roots
   * after the existing roots, and a subtask after its existing siblings under
   * the same parent. Tasks are visited in their old order, which is what keeps
   * their relative order.
   */
  deleteSection(id: string): Staged<{ deleted: boolean; moved: string[] }> {
    const section = this.store.get("section", id);
    if (section === null) return { result: { deleted: false, moved: [] }, ops: [] };

    const stranded = this.store
      .all("task")
      .filter((task) => task.sectionId === id)
      .sort((a, b) => compareOrder(a.order, b.order));

    const ops: Op[] = [];
    const lastIn = new Map<string, string | null>();
    for (const task of stranded) {
      const list = `${task.projectId}\u0000${task.parentId ?? ""}`;
      if (!lastIn.has(list)) {
        const roots = this.siblings({ projectId: task.projectId, sectionId: null, parentId: task.parentId });
        lastIn.set(list, roots[roots.length - 1]?.order ?? null);
      }
      const order = this.store.orderBetween(lastIn.get(list) ?? null, null);
      lastIn.set(list, order);
      ops.push(this.store.mutate("task", task.id, { sectionId: null, order }));
    }

    ops.push(this.store.remove("section", id));
    return { result: { deleted: true, moved: stranded.map((task) => task.id) }, ops };
  }

  /**
   * Folds or unfolds a section or a task's subtasks.
   *
   * Both flags already existed in the model and already synced, which is why
   * this is a write and not a local preference: a section collapsed on the
   * laptop is collapsed on the phone. Writing the value it already has is
   * not a write — it would sync for nothing, and a chevron clicked twice
   * quickly would otherwise queue two ops that cancel out.
   */
  setCollapsed(
    kind: "section" | "task",
    id: string,
    collapsed: boolean,
  ): Staged<Section | Task | null> {
    if (kind === "section") {
      const section = this.store.get("section", id);
      if (section === null) return { result: null, ops: [] };
      if (section.isCollapsed === collapsed) return { result: section, ops: [] };
      const op = this.store.mutate("section", id, { isCollapsed: collapsed });
      return { result: this.store.get("section", id), ops: [op] };
    }
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };
    if (task.isCollapsed === collapsed) return { result: task, ops: [] };
    const op = this.store.mutate("task", id, { isCollapsed: collapsed });
    return { result: this.store.get("task", id), ops: [op] };
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
    reward?: string | null;
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
      reward: input.reward ?? null,
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

  /**
   * Makes a task out of a line of text: `pay rent tomorrow 9am p1 @errand #Home`.
   *
   * This is the single path every Quick Add takes — the web field and the MCP
   * tool — and it ends in `createTask`, so a task made from text is
   * indistinguishable from one made from fields. In particular it routes
   * through `Operations`, which is where the rewards rule lives; a parallel
   * way of making tasks would be a place it silently did not fire.
   *
   * Where it files the task: the project the text names, else
   * `defaultProjectId`, else the inbox (made now if there is none, and staged
   * in the same batch so a first task and its inbox arrive together).
   *
   * Labels are matched to existing ones ignoring case. `createLabel` compares
   * exactly, and "@Errand" next to an existing "errand" should be the same
   * label rather than a second one that differs by a capital.
   *
   * With `strict`, a line the parser declined part of — or read only by
   * assuming — throws `QuickAddRefusal` before anything is staged, no label
   * and no inbox included.
   */
  createTaskFromText(text: string, input: QuickAddInput): Staged<{ task: Task; parse: QuickAddParse }> {
    const projects = this.store
      .all("project")
      .filter((project) => !project.isArchived && !project.isRewards)
      .map((project) => ({ id: project.id, name: project.name }));
    const options = {
      today: input.today,
      projects,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.ignore === undefined ? {} : { ignore: input.ignore }),
    };

    let parse: QuickAddParse;
    if (input.strict === true) {
      const checked = parseQuickAddStrict(text, options);
      if (!checked.ok) throw new QuickAddRefusal(checked.problems, checked.message);
      parse = checked.parse;
    } else {
      parse = parseQuickAdd(text, options);
    }
    if (parse.title === "") {
      throw new Error("a task needs a title, and nothing is left once the shorthand is taken out");
    }

    const ops: Op[] = [];
    let projectId = parse.projectId ?? input.defaultProjectId ?? null;
    if (projectId !== null && this.store.get("project", projectId) === null) {
      throw new Error(`no project with id ${projectId}`);
    }
    if (projectId === null) {
      const inbox = this.ensureInbox();
      ops.push(...inbox.ops);
      projectId = inbox.result.id;
    }

    const known = this.store.all("label");
    const labelNames = parse.labels.map(
      (name) => known.find((label) => label.name.toLowerCase() === name.toLowerCase())?.name ?? name,
    );

    const created = this.createTask({
      projectId,
      content: parse.title,
      ...(parse.description !== "" ? { description: parse.description } : {}),
      ...(parse.priority !== null ? { priority: parse.priority } : {}),
      ...(labelNames.length > 0 ? { labelNames } : {}),
      due: this.dueFromText(parse.schedule, input),
    });
    ops.push(...created.ops);
    return { result: { task: created.result, parse }, ops };
  }

  /**
   * The `Due` for a parsed schedule: an all-day date, a timed instant, or a
   * repeat — in which `text` is the phrase as typed, because completing the
   * task re-reads it to find the next day.
   */
  private dueFromText(schedule: QuickAddSchedule | null, input: QuickAddInput): Due | null {
    if (input.dueDate !== undefined && input.dueDate !== null) {
      return { date: input.dueDate, hasTime: false, text: null, timezone: null, isRecurring: false };
    }
    if (schedule === null) return null;

    let date = schedule.date;
    let hasTime = false;
    if (schedule.time !== null) {
      const [hours, minutes] = schedule.time.split(":").map(Number) as [number, number];
      const instant = instantAt(schedule.date, hours * 60 + minutes, input.timezone);
      if (instant === null) {
        const where = input.timezone === undefined ? "" : ` in ${input.timezone}`;
        throw new Error(`${schedule.time} does not exist on ${schedule.date}${where}, because the clocks change then`);
      }
      date = instant;
      hasTime = true;
    }
    return {
      date,
      hasTime,
      text: schedule.recurrence?.text ?? null,
      timezone: hasTime ? (input.timezone ?? null) : null,
      isRecurring: schedule.recurrence !== null,
    };
  }

  updateTask(
    id: string,
    changes: Partial<
      Pick<
        Task,
        | "content"
        | "description"
        | "priority"
        | "due"
        | "deadline"
        | "duration"
        | "labelIds"
        | "reward"
      >
    >,
  ): Staged<Task | null> {
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };
    const op = this.store.mutate("task", id, changes);
    return { result: this.store.get("task", id), ops: [op] };
  }

  /**
   * Moves a task to a day by name, or takes it off the calendar with `null`.
   *
   * The one-gesture edit behind the row menu and the swipe. It is `updateTask`
   * with the day worked out in one shared place; see `rescheduleDay` for what
   * "next week" and "weekend" mean.
   *
   * The day lands as an all-day date, the way dropping a block in the day view's
   * rail does. A time of day is not carried over: keeping it would mean reading
   * the old instant in some zone, and the web, the phone and a server-side agent
   * are in different ones, so the three would disagree about the result. A
   * repeat survives — its phrase and flag are kept, so a weekly task pushed to
   * tomorrow is still weekly. `null` clears the due date and with it the repeat,
   * which is what "no date" says.
   *
   * `today` is required, unlike `completeTask`'s optional day: that default is
   * the UTC date, which is the wrong day for anyone near midnight, and this
   * operation has nothing else to go on.
   */
  reschedule(id: string, target: RescheduleTarget, today: string): Staged<Task | null> {
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };

    const day = rescheduleDay(target, today);
    const due: Due | null =
      day === null
        ? null
        : {
            date: day,
            hasTime: false,
            text: task.due?.text ?? null,
            timezone: task.due?.timezone ?? null,
            isRecurring: task.due?.isRecurring ?? false,
          };
    return this.updateTask(id, { due });
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
        // A repeating task earns its reward every time it is done. The reward
        // is for doing the thing, not for being finished with it.
        const earned = this.earnReward(task);
        return {
          result: { task: this.store.get("task", id), rescheduled: true, recurrenceUnderstood: true },
          ops: [op, ...earned],
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
        ops: [op, ...this.earnReward(task)],
      };
    }

    const op = this.store.mutate("task", id, {
      isCompleted: true,
      completedAt: new Date().toISOString(),
    });
    return {
      result: { task: this.store.get("task", id), rescheduled: false, recurrenceUnderstood: true },
      ops: [op, ...this.earnReward(task)],
    };
  }

  /* ---------------------------------------------------------- */
  /* rewards                                                    */
  /* ---------------------------------------------------------- */

  /** Whether tasks carry rewards. On unless it has been turned off. */
  rewardsEnabled(): boolean {
    const preference = this.store.get("preference", PREFERENCES_ID);
    return preference?.rewardsEnabled ?? true;
  }

  setRewardsEnabled(enabled: boolean): Staged<boolean> {
    const op = this.store.mutate("preference", PREFERENCES_ID, { rewardsEnabled: enabled });
    return { result: enabled, ops: [op] };
  }

  /** The trophy cabinet, made the first time something is put in it. */
  rewardsProject(): Staged<Project> {
    const existing = this.store.all("project").find((project) => project.isRewards);
    if (existing !== undefined) return { result: existing, ops: [] };

    const staged = this.createProject({ name: "Rewards" });
    const op = this.store.mutate("project", staged.result.id, { isRewards: true });
    return {
      result: this.store.get("project", staged.result.id) ?? staged.result,
      ops: [...staged.ops, op],
    };
  }

  /**
   * Files a task's reward, if it has one and rewards are on.
   *
   * Lives here rather than in the views because the MCP tools complete tasks
   * through this same method: a rule that only fired in the browser would be
   * wrong every time an agent finished something.
   */
  private earnReward(task: Task): Op[] {
    const reward = task.reward?.trim() ?? "";
    if (reward === "" || !this.rewardsEnabled()) return [];

    const project = this.rewardsProject();
    const earned = this.createTask({
      projectId: project.result.id,
      content: reward,
      description: `Earned by finishing “${task.content}”.`,
    });
    return [...project.ops, ...earned.ops];
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

  /**
   * Deletes a project with everything filed under it: its sections, its tasks,
   * and — only when asked — its child projects, depth first.
   *
   * Nothing cascades in storage, because a delete op is a tombstone on a single
   * entity. So every descendant needs an op of its own, or it outlives the
   * project and points at an id that is gone. `deleteTask` is deliberately not
   * reused for the tasks: it walks subtasks to avoid orphaning them, and here
   * every task in the project is going anyway, parent or not.
   */
  deleteProject(
    id: string,
    options: { recursive?: boolean } = {},
  ): Staged<{ projects: string[]; sections: string[]; tasks: string[] }> {
    const ops: Op[] = [];
    const projects: string[] = [];
    const sections: string[] = [];
    const tasks: string[] = [];

    const collect = (projectId: string): void => {
      const project = this.store.get("project", projectId);
      // Guarded here rather than in the caller: every view of the account
      // assumes an inbox exists, so no caller should be able to remove it.
      if (project !== null && project.isInbox) {
        throw new Error("the inbox cannot be deleted");
      }
      // Same reasoning, different cabinet: the trophies are a record of work
      // already done, and nothing else can recreate them.
      if (project !== null && project.isRewards) {
        throw new Error("the rewards project cannot be deleted");
      }

      if (options.recursive === true) {
        for (const child of this.store.all("project").filter((p) => p.parentId === projectId)) {
          collect(child.id);
        }
      }
      for (const task of this.store.all("task").filter((t) => t.projectId === projectId)) {
        ops.push(this.store.remove("task", task.id));
        tasks.push(task.id);
      }
      for (const section of this.store.all("section").filter((s) => s.projectId === projectId)) {
        ops.push(this.store.remove("section", section.id));
        sections.push(section.id);
      }
      if (project !== null) {
        ops.push(this.store.remove("project", projectId));
        projects.push(projectId);
      }
    };
    collect(id);

    return { result: { projects, sections, tasks }, ops };
  }

  /**
   * Moves a task to another project, section or parent, placing it last.
   *
   * A section belongs to the project it was made in, and a parent stays behind
   * when its child leaves the project. So when the project changes and the
   * caller did not say where, the task lands outside any section and without a
   * parent, rather than keeping a pointer into a project it is no longer in —
   * which is how it used to vanish from both lists. A section that is named
   * must exist and must belong to the project the task ends up in.
   *
   * The subtasks come with it. They carry their parent's project and section,
   * and a parent that moved without them would leave them filed somewhere the
   * parent is not; they keep their parent and their order among each other.
   */
  moveTask(
    id: string,
    target: { projectId?: string; sectionId?: string | null; parentId?: string | null },
  ): Staged<Task | null> {
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };

    const projectId = target.projectId ?? task.projectId;
    const leavingProject = projectId !== task.projectId;
    const placement = {
      projectId,
      sectionId:
        target.sectionId === undefined ? (leavingProject ? null : task.sectionId) : target.sectionId,
      parentId:
        target.parentId === undefined ? (leavingProject ? null : task.parentId) : target.parentId,
    };

    // A task cannot become its own ancestor; that would detach the subtree.
    if (placement.parentId !== null && this.isDescendant(placement.parentId, id)) {
      throw new Error("cannot move a task beneath one of its own subtasks");
    }

    if (target.sectionId !== undefined && target.sectionId !== null) {
      const section = this.store.get("section", target.sectionId);
      if (section === null) throw new Error(`no section with id ${target.sectionId}`);
      if (section.projectId !== projectId) {
        throw new Error("that section belongs to a different project");
      }
    }

    const ops = [
      this.store.mutate("task", id, { ...placement, order: this.orderAtEnd(placement) }),
    ];

    if (leavingProject || placement.sectionId !== task.sectionId) {
      // `seen` guards against a parent cycle in bad data, which would otherwise
      // recurse for ever.
      const seen = new Set<string>([id]);
      const follow = (parentId: string): void => {
        for (const child of this.store.all("task").filter((candidate) => candidate.parentId === parentId)) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          ops.push(
            this.store.mutate("task", child.id, {
              projectId: placement.projectId,
              sectionId: placement.sectionId,
            }),
          );
          follow(child.id);
        }
      };
      follow(id);
    }

    return { result: this.store.get("task", id), ops };
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

  /**
   * Puts a task directly after `afterId` in a day's list, or first with `null`.
   *
   * The twin of `reorderTask` for Today and for each day of Upcoming, and the
   * reason `Task.dayOrder` exists: the day's list mixes projects, and arranging it
   * must not rearrange any of them. This writes `dayOrder` and only `dayOrder` —
   * a project's `order` is never touched, so opening the task's project
   * afterwards shows the list as it was.
   *
   * `scope.day` says which list, and `scope.today` whether overdue work is in it
   * (it is, for today and for no other day); see `tasksOnDay`. Both the task and
   * `afterId` have to be on that list, or this throws before staging anything: a
   * drop beside a row that is not in the list has no position to take.
   *
   * Usually one task is written. When the neighbours' keys are equal there is no
   * key to mint between them, so the run of equal keys is re-keyed with it; see
   * `placeInDay`.
   */
  reorderInDay(id: string, afterId: string | null, scope: DayScope): Staged<Task | null> {
    const task = this.store.get("task", id);
    if (task === null) return { result: null, ops: [] };

    const list = tasksOnDay(this.store.all("task"), scope);
    if (!list.some((candidate) => candidate.id === id)) {
      throw new Error(`${id} is not on the list for ${scope.day}`);
    }

    const ops = placeInDay(list, id, afterId).map((placed) =>
      this.store.mutate("task", placed.id, { dayOrder: placed.dayOrder }),
    );
    return { result: this.store.get("task", id), ops };
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
