/**
 * The tools an agent gets.
 *
 * The read tools are shaped around the questions an agent actually asks when
 * arranging work — "what is due this week", "where has my attention gone" —
 * rather than mirroring the database. `get_week_plan` in particular exists
 * because the alternative is an agent making a dozen calls and assembling the
 * same view itself, badly.
 *
 * Every tool that writes returns the entity it wrote, so an agent can chain
 * without a follow-up read.
 */

import { compareOrder, type Due, type Priority, type Task } from "@light/core";
import { parseRecurrence } from "@light/client-sdk";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { failure, formatProject, formatTask, humanDuration, projectPath, result } from "./format.js";

/* ------------------------------------------------------------------ */
/* shared shapes                                                      */
/* ------------------------------------------------------------------ */

const prioritySchema = z
  .number()
  .int()
  .min(1)
  .max(4)
  .describe("1 is urgent, 4 is none. Matches the p1..p4 shown in the app.");

const dueSchema = z
  .object({
    date: z.string().describe("YYYY-MM-DD, or a full ISO instant when it has a time."),
    recurring: z.boolean().optional(),
    phrase: z
      .string()
      .optional()
      .describe(
        'The recurrence in words, e.g. "every monday". Required for a recurring task: ' +
          "completing one re-reads this to find the next occurrence.",
      ),
    timezone: z.string().optional(),
  })
  .describe("When you intend to work on the task.");

function buildDue(input: z.infer<typeof dueSchema> | undefined): Due | null {
  if (input === undefined) return null;
  return {
    date: input.date,
    hasTime: input.date.includes("T"),
    text: input.phrase ?? null,
    timezone: input.timezone ?? null,
    isRecurring: input.recurring ?? false,
  };
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(day: string, delta: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* the registry                                                       */
/* ------------------------------------------------------------------ */

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** True for tools that only read, which hosts may run without confirmation. */
  readOnly: boolean;
  handler: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ReturnType<typeof result> | ReturnType<typeof failure>>;
}

export function buildTools(): ToolDefinition[] {
  return [
    /* ---------------------------- reads ---------------------------- */
    {
      name: "list_projects",
      title: "List projects",
      description:
        "Every project, with its full nested path and a count of open tasks. Start here to " +
        "learn the shape of the account before arranging anything.",
      readOnly: true,
      inputSchema: {
        includeArchived: z.boolean().optional().default(false),
      },
      handler: async (args, context) => {
        const includeArchived = args.includeArchived === true;
        const projects = context.store
          .ordered("project")
          .filter((project) => includeArchived || !project.isArchived)
          .map((project) => formatProject(context.store, project));
        return result({ projects, total: projects.length });
      },
    },

    {
      name: "list_tasks",
      title: "List tasks",
      description:
        "Tasks, narrowed by any combination of project, section, label, priority and due " +
        "window. Completed tasks are excluded unless asked for.",
      readOnly: true,
      inputSchema: {
        projectId: z.string().optional(),
        sectionId: z.string().optional(),
        label: z.string().optional().describe("Label name, not id."),
        priority: prioritySchema.optional(),
        dueBefore: z.string().optional().describe("YYYY-MM-DD, inclusive."),
        dueAfter: z.string().optional().describe("YYYY-MM-DD, inclusive."),
        overdueOnly: z.boolean().optional().default(false),
        includeCompleted: z.boolean().optional().default(false),
        search: z.string().optional().describe("Case-insensitive substring of the title."),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
      handler: async (args, context) => {
        const today = context.today();
        const labelId =
          typeof args.label === "string"
            ? context.store.all("label").find((l) => l.name === args.label)?.id
            : undefined;
        if (typeof args.label === "string" && labelId === undefined) {
          return failure(`No label named "${args.label}".`);
        }

        const search = typeof args.search === "string" ? args.search.toLowerCase() : undefined;

        const tasks = context.store
          .all("task")
          .filter((task) => {
            if (!(args.includeCompleted === true) && task.isCompleted) return false;
            if (typeof args.projectId === "string" && task.projectId !== args.projectId) return false;
            if (typeof args.sectionId === "string" && task.sectionId !== args.sectionId) return false;
            if (labelId !== undefined && !task.labelIds.includes(labelId)) return false;
            if (typeof args.priority === "number" && task.priority !== args.priority) return false;
            if (search !== undefined && !task.content.toLowerCase().includes(search)) return false;

            const due = task.due === null ? null : dayOf(task.due.date);
            if (args.overdueOnly === true && (due === null || due >= today)) return false;
            if (typeof args.dueBefore === "string" && (due === null || due > args.dueBefore)) return false;
            if (typeof args.dueAfter === "string" && (due === null || due < args.dueAfter)) return false;
            return true;
          })
          .sort((a, b) => compareOrder(a.order, b.order))
          .slice(0, typeof args.limit === "number" ? args.limit : 100)
          .map((task) => formatTask(context, task));

        return result({ tasks, total: tasks.length });
      },
    },

    {
      name: "get_task",
      title: "Get a task",
      description: "One task in full, with its subtasks and its accumulated focus time.",
      readOnly: true,
      inputSchema: { taskId: z.string() },
      handler: async (args, context) => {
        const task = context.store.get("task", String(args.taskId));
        if (task === null) return failure(`No task with id ${String(args.taskId)}.`);

        const subtasks = context.store
          .all("task")
          .filter((candidate) => candidate.parentId === task.id)
          .sort((a, b) => compareOrder(a.order, b.order))
          .map((candidate) => formatTask(context, candidate));

        return result({ task: formatTask(context, task), subtasks });
      },
    },

    {
      name: "list_labels",
      title: "List labels",
      description: "Every label, with how many open tasks carry it.",
      readOnly: true,
      inputSchema: {},
      handler: async (_args, context) => {
        const tasks = context.store.all("task").filter((task) => !task.isCompleted);
        const labels = context.store.ordered("label").map((label) => ({
          id: label.id,
          name: label.name,
          openTasks: tasks.filter((task) => task.labelIds.includes(label.id)).length,
        }));
        return result({ labels });
      },
    },

    {
      name: "get_week_plan",
      title: "Get the week's plan",
      description:
        "Everything bearing on the next seven days: overdue tasks, each day's scheduled " +
        "work, deadlines falling in the window, and unscheduled p1/p2 tasks that arguably " +
        "belong somewhere. Use this before proposing a rearrangement — it is the one call " +
        "that gives the whole picture, including how much focus each task has already had.",
      readOnly: true,
      inputSchema: {
        startDate: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
        days: z.number().int().min(1).max(31).optional().default(7),
      },
      handler: async (args, context) => {
        const start = typeof args.startDate === "string" ? args.startDate : context.today();
        const days = typeof args.days === "number" ? args.days : 7;
        const end = addDays(start, days - 1);

        const open = context.store.all("task").filter((task) => !task.isCompleted);
        const describe = (task: Task) => formatTask(context, task);

        const overdue = open
          .filter((task) => task.due !== null && dayOf(task.due.date) < start)
          .sort((a, b) => dayOf(a.due!.date).localeCompare(dayOf(b.due!.date)))
          .map(describe);

        const schedule: { date: string; tasks: ReturnType<typeof describe>[] }[] = [];
        for (let i = 0; i < days; i++) {
          const date = addDays(start, i);
          schedule.push({
            date,
            tasks: open
              .filter((task) => task.due !== null && dayOf(task.due.date) === date)
              .sort((a, b) => a.priority - b.priority)
              .map(describe),
          });
        }

        const deadlines = open
          .filter(
            (task) =>
              task.deadline !== null && task.deadline.date >= start && task.deadline.date <= end,
          )
          .sort((a, b) => a.deadline!.date.localeCompare(b.deadline!.date))
          .map(describe);

        // Unscheduled but important: the most useful thing to surface when asked
        // to fill a week, and invisible to a plain due-date query.
        const unscheduledImportant = open
          .filter((task) => task.due === null && task.priority <= 2)
          .sort((a, b) => a.priority - b.priority)
          .map(describe);

        const focusedSeconds = context.store
          .all("focusSession")
          .filter((session) => session.kind === "focus" && dayOf(session.startedAt) >= start)
          .reduce((total, session) => total + session.focusedSeconds, 0);

        return result({
          window: { start, end, days },
          counts: {
            overdue: overdue.length,
            scheduled: schedule.reduce((n, day) => n + day.tasks.length, 0),
            deadlines: deadlines.length,
            unscheduledImportant: unscheduledImportant.length,
          },
          focusInWindow: { seconds: focusedSeconds, human: humanDuration(focusedSeconds) },
          overdue,
          schedule,
          deadlines,
          unscheduledImportant,
        });
      },
    },

    {
      name: "get_focus_stats",
      title: "Get focus statistics",
      description:
        "Where attention actually went, from focus sessions logged by Light Minute. " +
        "Scope to a task or a project, or omit both for the whole account. This is the " +
        "signal that distinguishes a task someone has been grinding at from one they " +
        "have been avoiding, which is usually the interesting question when replanning.",
      readOnly: true,
      inputSchema: {
        taskId: z.string().optional(),
        projectId: z.string().optional(),
        since: z.string().optional().describe("YYYY-MM-DD, inclusive."),
      },
      handler: async (args, context) => {
        if (typeof args.taskId === "string") {
          const task = context.store.get("task", args.taskId);
          if (task === null) return failure(`No task with id ${args.taskId}.`);
          const stats = context.ops.focusStatsForTask(task.id);
          return result({
            scope: "task",
            task: { id: task.id, content: task.content },
            ...stats,
            focused: humanDuration(stats.focusedSeconds),
          });
        }

        const since = typeof args.since === "string" ? args.since : null;
        const sessions = context.store.all("focusSession").filter((session) => {
          if (session.kind !== "focus") return false;
          if (since !== null && dayOf(session.startedAt) < since) return false;
          if (typeof args.projectId === "string") {
            if (session.projectId === args.projectId) return true;
            if (session.taskId === null) return false;
            return context.store.get("task", session.taskId)?.projectId === args.projectId;
          }
          return true;
        });

        const byTask = new Map<string, { content: string; seconds: number; sessions: number }>();
        let total = 0;
        let abandoned = 0;
        for (const session of sessions) {
          total += session.focusedSeconds;
          if (session.outcome === "abandoned") abandoned += 1;
          if (session.taskId === null) continue;
          const task = context.store.get("task", session.taskId);
          if (task === null) continue;
          const entry = byTask.get(task.id) ?? { content: task.content, seconds: 0, sessions: 0 };
          entry.seconds += session.focusedSeconds;
          entry.sessions += 1;
          byTask.set(task.id, entry);
        }

        const topTasks = [...byTask.entries()]
          .sort((a, b) => b[1].seconds - a[1].seconds)
          .slice(0, 20)
          .map(([id, entry]) => ({
            taskId: id,
            content: entry.content,
            sessions: entry.sessions,
            focusedSeconds: entry.seconds,
            focused: humanDuration(entry.seconds),
          }));

        return result({
          scope: typeof args.projectId === "string" ? "project" : "account",
          ...(typeof args.projectId === "string"
            ? { project: { id: args.projectId, path: projectPath(context.store, args.projectId) } }
            : {}),
          since: since ?? undefined,
          sessions: sessions.length,
          abandonedSessions: abandoned,
          focusedSeconds: total,
          focused: humanDuration(total),
          topTasks,
        });
      },
    },

    /* ---------------------------- writes --------------------------- */
    {
      name: "create_task",
      title: "Create a task",
      description: "Adds a task to a project, optionally under a section or another task.",
      readOnly: false,
      inputSchema: {
        projectId: z.string(),
        content: z.string().min(1),
        description: z.string().optional(),
        sectionId: z.string().optional(),
        parentId: z.string().optional().describe("Makes this a subtask."),
        priority: prioritySchema.optional(),
        due: dueSchema.optional(),
        deadlineDate: z.string().optional().describe("YYYY-MM-DD. When the task is owed."),
        durationMinutes: z.number().int().min(1).optional(),
        labels: z.array(z.string()).optional().describe("Label names; unknown ones are created."),
      },
      handler: async (args, context) => {
        if (context.store.get("project", String(args.projectId)) === null) {
          return failure(`No project with id ${String(args.projectId)}.`);
        }
        const due = buildDue(args.due as z.infer<typeof dueSchema> | undefined);
        if (due !== null && due.isRecurring && parseRecurrence(due.text) === null) {
          return failure(
            `Cannot read the recurrence "${due.text ?? ""}". Supported forms include ` +
              '"every day", "every 3 days", "every monday", "every mon, wed", "every weekday", ' +
              '"every month", "every 15th" and "every! 3 days".',
          );
        }

        const staged = context.ops.createTask({
          projectId: String(args.projectId),
          content: String(args.content),
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.sectionId === "string" ? { sectionId: args.sectionId } : {}),
          ...(typeof args.parentId === "string" ? { parentId: args.parentId } : {}),
          ...(typeof args.priority === "number" ? { priority: args.priority as Priority } : {}),
          due,
          ...(typeof args.deadlineDate === "string"
            ? { deadline: { date: args.deadlineDate } }
            : {}),
          ...(typeof args.durationMinutes === "number"
            ? { duration: { amount: args.durationMinutes, unit: "minute" as const } }
            : {}),
          ...(Array.isArray(args.labels) ? { labelNames: args.labels as string[] } : {}),
        });
        await context.flush(staged.ops);
        return result({ task: formatTask(context, staged.result) });
      },
    },

    {
      name: "update_task",
      title: "Update a task",
      description:
        "Changes only the fields given. Omitted fields are untouched, so two agents or " +
        "devices editing different fields of one task do not overwrite each other.",
      readOnly: false,
      inputSchema: {
        taskId: z.string(),
        content: z.string().optional(),
        description: z.string().optional(),
        priority: prioritySchema.optional(),
        due: dueSchema.nullable().optional().describe("Pass null to unschedule."),
        deadlineDate: z.string().nullable().optional(),
        durationMinutes: z.number().int().min(1).nullable().optional(),
      },
      handler: async (args, context) => {
        const task = context.store.get("task", String(args.taskId));
        if (task === null) return failure(`No task with id ${String(args.taskId)}.`);

        const changes: Parameters<typeof context.ops.updateTask>[1] = {};
        if (typeof args.content === "string") changes.content = args.content;
        if (typeof args.description === "string") changes.description = args.description;
        if (typeof args.priority === "number") changes.priority = args.priority as Priority;
        if (args.due !== undefined) {
          changes.due = args.due === null ? null : buildDue(args.due as z.infer<typeof dueSchema>);
          if (changes.due !== null && changes.due.isRecurring && parseRecurrence(changes.due.text) === null) {
            return failure(`Cannot read the recurrence "${changes.due.text ?? ""}".`);
          }
        }
        if (args.deadlineDate !== undefined) {
          changes.deadline = args.deadlineDate === null ? null : { date: String(args.deadlineDate) };
        }
        if (args.durationMinutes !== undefined) {
          changes.duration =
            args.durationMinutes === null
              ? null
              : { amount: Number(args.durationMinutes), unit: "minute" };
        }

        const staged = context.ops.updateTask(task.id, changes);
        await context.flush(staged.ops);
        return result({ task: staged.result === null ? null : formatTask(context, staged.result) });
      },
    },

    {
      name: "complete_task",
      title: "Complete a task",
      description:
        "Completes a task, or reschedules it to its next occurrence when it recurs. The " +
        "response says which happened, and warns if a recurrence phrase could not be read.",
      readOnly: false,
      inputSchema: { taskId: z.string() },
      handler: async (args, context) => {
        const staged = context.ops.completeTask(String(args.taskId), context.today());
        if (staged.result.task === null) return failure(`No task with id ${String(args.taskId)}.`);
        await context.flush(staged.ops);
        return result({
          task: formatTask(context, staged.result.task),
          rescheduled: staged.result.rescheduled,
          ...(staged.result.recurrenceUnderstood
            ? {}
            : {
                warning:
                  "The task recurred but its schedule could not be read, so it was completed " +
                  "rather than rescheduled. The repeat is lost unless you set a new due date.",
              }),
        });
      },
    },

    {
      name: "delete_task",
      title: "Delete a task",
      description: "Deletes a task and all of its subtasks. Not recoverable through this tool.",
      readOnly: false,
      inputSchema: { taskId: z.string() },
      handler: async (args, context) => {
        const task = context.store.get("task", String(args.taskId));
        if (task === null) return failure(`No task with id ${String(args.taskId)}.`);
        const staged = context.ops.deleteTask(task.id);
        await context.flush(staged.ops);
        return result({ deleted: staged.result.deleted, count: staged.result.deleted.length });
      },
    },

    {
      name: "move_task",
      title: "Move a task",
      description:
        "Moves a task to another project, section or parent. It lands at the end of its new " +
        "list; use reorder_tasks to place it precisely.",
      readOnly: false,
      inputSchema: {
        taskId: z.string(),
        projectId: z.string().optional(),
        sectionId: z.string().nullable().optional(),
        parentId: z.string().nullable().optional(),
      },
      handler: async (args, context) => {
        const target: { projectId?: string; sectionId?: string | null; parentId?: string | null } = {};
        if (typeof args.projectId === "string") target.projectId = args.projectId;
        if (args.sectionId !== undefined) target.sectionId = args.sectionId as string | null;
        if (args.parentId !== undefined) target.parentId = args.parentId as string | null;

        try {
          const staged = context.ops.moveTask(String(args.taskId), target);
          if (staged.result === null) return failure(`No task with id ${String(args.taskId)}.`);
          await context.flush(staged.ops);
          return result({ task: formatTask(context, staged.result) });
        } catch (error) {
          return failure(error instanceof Error ? error.message : "move failed");
        }
      },
    },

    {
      name: "reorder_tasks",
      title: "Reorder tasks",
      description:
        "Puts sibling tasks into the order given. The listed tasks are placed in that " +
        "order at the top of their list, and any sibling you leave out keeps its relative " +
        "position after them — so pass the whole list when you care where everything " +
        "lands. Only the tasks that move are written, which is what lets two devices " +
        "reorder different lists without conflicting.",
      readOnly: false,
      inputSchema: {
        taskIds: z
          .array(z.string())
          .min(1)
          .describe("Sibling task ids, in the desired order. All must share one list."),
      },
      handler: async (args, context) => {
        const ids = args.taskIds as string[];
        const tasks = ids.map((id) => context.store.get("task", id));
        const missing = ids.filter((_id, index) => tasks[index] === null);
        if (missing.length > 0) return failure(`Unknown task ids: ${missing.join(", ")}.`);

        const first = tasks[0]!;
        const mismatched = tasks.filter(
          (task) =>
            task!.projectId !== first.projectId ||
            task!.sectionId !== first.sectionId ||
            task!.parentId !== first.parentId,
        );
        if (mismatched.length > 0) {
          return failure(
            "All tasks must be siblings in the same project, section and parent. " +
              "Use move_task first if you need to bring them together.",
          );
        }

        const staged = [];
        let previous: string | null = null;
        for (const id of ids) {
          const step = context.ops.reorderTask(id, previous);
          staged.push(...step.ops);
          previous = id;
        }
        await context.flush(staged);

        const ordered = context.store
          .all("task")
          .filter(
            (task) =>
              task.projectId === first.projectId &&
              task.sectionId === first.sectionId &&
              task.parentId === first.parentId,
          )
          .sort((a, b) => compareOrder(a.order, b.order))
          .map((task) => ({ id: task.id, content: task.content }));

        return result({ reordered: staged.length, list: ordered });
      },
    },

    {
      name: "create_project",
      title: "Create a project",
      description: "Adds a project, optionally nested under another.",
      readOnly: false,
      inputSchema: {
        name: z.string().min(1),
        parentId: z.string().optional(),
        color: z.string().optional(),
        isFavorite: z.boolean().optional(),
        description: z.string().optional(),
      },
      handler: async (args, context) => {
        if (typeof args.parentId === "string" && context.store.get("project", args.parentId) === null) {
          return failure(`No project with id ${args.parentId}.`);
        }
        const staged = context.ops.createProject({
          name: String(args.name),
          ...(typeof args.parentId === "string" ? { parentId: args.parentId } : {}),
          ...(typeof args.color === "string" ? { color: args.color } : {}),
          ...(typeof args.isFavorite === "boolean" ? { isFavorite: args.isFavorite } : {}),
          ...(typeof args.description === "string" ? { description: args.description } : {}),
        });
        await context.flush(staged.ops);
        return result({ project: formatProject(context.store, staged.result) });
      },
    },

    {
      name: "delete_project",
      title: "Delete a project",
      description:
        "Deletes a project, its sections and all of its tasks. Child projects are left alone " +
        "unless recursive is set, so a parent cannot take a whole subtree with it by " +
        "accident. The inbox cannot be deleted. Not recoverable through this tool.",
      readOnly: false,
      inputSchema: { projectId: z.string(), recursive: z.boolean().optional() },
      handler: async (args, context) => {
        const id = String(args.projectId);
        const project = context.store.get("project", id);
        if (project === null) return failure(`No project with id ${id}.`);
        if (project.isInbox) return failure("The inbox cannot be deleted.");

        const children = context.store.all("project").filter((p) => p.parentId === id);
        if (children.length > 0 && args.recursive !== true) {
          return failure(
            `${project.name} has ${String(children.length)} child project(s). Pass recursive ` +
              "to delete the whole subtree, or move them elsewhere first.",
          );
        }

        const staged = context.ops.deleteProject(id, {
          ...(args.recursive === true ? { recursive: true } : {}),
        });
        await context.flush(staged.ops);
        return result({
          deleted: {
            projects: staged.result.projects.length,
            sections: staged.result.sections.length,
            tasks: staged.result.tasks.length,
          },
          projectIds: staged.result.projects,
        });
      },
    },

    {
      name: "create_section",
      title: "Create a section",
      description:
        "Adds a section to a project. The description is markdown and is a good place for " +
        "the intent behind a phase, which later planning can read back.",
      readOnly: false,
      inputSchema: {
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
      },
      handler: async (args, context) => {
        if (context.store.get("project", String(args.projectId)) === null) {
          return failure(`No project with id ${String(args.projectId)}.`);
        }
        const staged = context.ops.createSection({
          projectId: String(args.projectId),
          name: String(args.name),
          ...(typeof args.description === "string" ? { description: args.description } : {}),
        });
        await context.flush(staged.ops);
        return result({ section: staged.result });
      },
    },

    {
      name: "log_focus_session",
      title: "Log a focus session",
      description:
        "Records a block of focus against a task. Light Minute writes these itself; use " +
        "this to backfill a session that happened away from the timer.",
      readOnly: false,
      inputSchema: {
        taskId: z.string().optional(),
        projectId: z.string().optional(),
        startedAt: z.string().describe("ISO instant."),
        endedAt: z.string().optional(),
        plannedMinutes: z.number().int().min(1),
        focusedMinutes: z.number().int().min(0),
        interruptions: z.number().int().min(0).optional(),
        outcome: z.enum(["completed", "abandoned"]).optional(),
        note: z.string().optional(),
      },
      handler: async (args, context) => {
        if (typeof args.taskId === "string" && context.store.get("task", args.taskId) === null) {
          return failure(`No task with id ${args.taskId}.`);
        }
        const staged = context.ops.logFocusSession({
          ...(typeof args.taskId === "string" ? { taskId: args.taskId } : {}),
          ...(typeof args.projectId === "string" ? { projectId: args.projectId } : {}),
          startedAt: String(args.startedAt),
          ...(typeof args.endedAt === "string" ? { endedAt: args.endedAt } : {}),
          plannedSeconds: Number(args.plannedMinutes) * 60,
          focusedSeconds: Number(args.focusedMinutes) * 60,
          ...(typeof args.interruptions === "number" ? { interruptions: args.interruptions } : {}),
          ...(typeof args.outcome === "string"
            ? { outcome: args.outcome as "completed" | "abandoned" }
            : {}),
          ...(typeof args.note === "string" ? { note: args.note } : {}),
          source: "mcp",
        });
        await context.flush(staged.ops);
        return result({ session: staged.result });
      },
    },
  ];
}
