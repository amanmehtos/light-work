/**
 * The Light Week domain model.
 *
 * Shaped for full Todoist parity, because an import that silently drops fields
 * is worse than no import at all. Two details worth knowing before reading on:
 *
 * - `priority` is 1..4 with **1 highest**, matching the p1..p4 a user sees.
 *   Todoist's API inverts this internally (4 is urgent); the importer converts.
 * - A task carries both a `due` and a `deadline`. Todoist treats these as
 *   different things — when you intend to work on it versus when it is actually
 *   owed — and collapsing them into one field loses real information.
 */

/** User-facing priority. 1 is urgent, 4 is none. */
export type Priority = 1 | 2 | 3 | 4;

export type ProjectView = "list" | "board" | "calendar";

export type DurationUnit = "minute" | "day";

export interface Duration {
  amount: number;
  unit: DurationUnit;
}

/**
 * When a task is scheduled.
 *
 * `text` is the authoritative form for recurring tasks: "every monday" cannot be
 * reconstructed from a resolved date, so completing a recurrence re-reads the
 * text rather than guessing the next occurrence from `date`.
 */
export interface Due {
  /** `YYYY-MM-DD` when all-day, full ISO 8601 instant when timed. */
  date: string;
  hasTime: boolean;
  /** The phrase the user typed, when there was one. */
  text: string | null;
  /** IANA zone, when the task is pinned to a specific one. */
  timezone: string | null;
  isRecurring: boolean;
}

/** When a task is actually owed. Always all-day. */
export interface Deadline {
  /** `YYYY-MM-DD`. */
  date: string;
}

export type ReminderKind = "relative" | "absolute" | "location";

export interface Reminder {
  id: string;
  taskId: string;
  kind: ReminderKind;
  /** For `relative`: minutes before the task's due time. */
  offsetMinutes: number | null;
  /** For `absolute`: the ISO instant to fire at. */
  fireAt: string | null;
  /** For `location`: where, and whether on arriving or leaving. */
  place: { name: string; latitude: number; longitude: number; radiusMetres: number } | null;
  trigger: "arrive" | "leave" | null;
}

export interface Project {
  id: string;
  /** Nesting. Todoist allows real hierarchies and the import depends on it. */
  parentId: string | null;
  name: string;
  color: string;
  /** Fractional index among siblings. */
  order: string;
  view: ProjectView;
  isFavorite: boolean;
  isArchived: boolean;
  /** Exactly one project per account is the inbox; it cannot be deleted. */
  isInbox: boolean;
  isCollapsed: boolean;
  description: string;
}

export interface Section {
  id: string;
  projectId: string;
  name: string;
  /** Todoist sections carry long-form markdown; several of yours hold the plan. */
  description: string;
  order: string;
  isArchived: boolean;
  isCollapsed: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  sectionId: string | null;
  /** Subtasks. Nests arbitrarily deep. */
  parentId: string | null;
  content: string;
  /** Markdown. */
  description: string;
  priority: Priority;
  /** Fractional index among siblings within the section. */
  order: string;
  /** Separate ordering for the Today / Upcoming views, which users rearrange independently. */
  dayOrder: string | null;
  due: Due | null;
  deadline: Deadline | null;
  duration: Duration | null;
  labelIds: string[];
  isCompleted: boolean;
  completedAt: string | null;
  isCollapsed: boolean;
  /** Set once sharing lands; null means "mine" today. */
  assigneeId: string | null;
  addedById: string | null;
  createdAt: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  order: string;
  isFavorite: boolean;
}

export interface Comment {
  id: string;
  /** A comment hangs off exactly one of these. */
  taskId: string | null;
  projectId: string | null;
  content: string;
  attachment: Attachment | null;
  postedById: string | null;
  postedAt: string;
}

export interface Attachment {
  fileName: string;
  fileType: string;
  fileUrl: string;
  fileSize: number | null;
}

/** A saved query, in the same filter syntax Todoist uses. */
export interface Filter {
  id: string;
  name: string;
  query: string;
  color: string;
  order: string;
  isFavorite: boolean;
}

/**
 * A block of intentional focus, written by Light Minute and read by Light Week.
 *
 * This is the join between the two apps and the reason the suite exists: tasks
 * accumulate real attention data, which the MCP server then hands to an agent so
 * it can plan against where attention actually went.
 */
export interface FocusSession {
  id: string;
  /** Null for a session started without picking a task. */
  taskId: string | null;
  projectId: string | null;
  startedAt: string;
  endedAt: string | null;
  /** What the timer was set to. */
  plannedSeconds: number;
  /** What was actually spent, excluding paused time. */
  focusedSeconds: number;
  kind: "focus" | "short_break" | "long_break";
  outcome: "running" | "completed" | "abandoned";
  /** How many times the session was paused or the app left. */
  interruptions: number;
  /** Which app wrote it, e.g. `light-minute-ios`. */
  source: string;
  note: string | null;
}

export const ENTITY_KINDS = [
  "project",
  "section",
  "task",
  "label",
  "comment",
  "reminder",
  "filter",
  "focusSession",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface EntityByKind {
  project: Project;
  section: Section;
  task: Task;
  label: Label;
  comment: Comment;
  reminder: Reminder;
  filter: Filter;
  focusSession: FocusSession;
}

export type Entity = EntityByKind[EntityKind];

export function isEntityKind(value: string): value is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(value);
}

/** The default colour palette, mirroring Todoist's named colours. */
export const COLORS = [
  "berry_red", "red", "orange", "yellow", "olive_green", "lime_green",
  "green", "mint_green", "teal", "sky_blue", "light_blue", "blue",
  "grape", "violet", "lavender", "magenta", "salmon", "charcoal",
  "grey", "taupe",
] as const;

export type Color = (typeof COLORS)[number];

export const DEFAULT_COLOR: Color = "charcoal";
