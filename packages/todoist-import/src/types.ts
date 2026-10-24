/**
 * The two Todoist export shapes this importer accepts.
 *
 * `SyncExport` is the full-fidelity path: the body of a `POST /api/v1/sync`
 * with `sync_token: "*"`, which returns every active resource in one document.
 * Field names there are snake_case.
 *
 * `ConnectorExport` is the normalised camelCase shape returned by the Todoist
 * MCP connector. It is lower fidelity — no reminders, no `day_order`, labels as
 * names only — but it needs no API token, so it is the easy path.
 *
 * Everything here is deliberately loose. A Todoist account that has been open
 * for years accumulates fields that no longer appear in the documentation, and
 * an importer that throws on an unexpected shape is an importer that loses your
 * data. Readers coerce, and anything unrecognised is recorded in the report
 * rather than dropped silently.
 */

export interface SyncProject {
  id: string;
  name: string;
  color?: string;
  parent_id?: string | null;
  child_order?: number;
  collapsed?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  is_favorite?: boolean;
  inbox_project?: boolean;
  view_style?: string;
  description?: string;
}

export interface SyncSection {
  id: string;
  name: string;
  project_id: string;
  section_order?: number;
  collapsed?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  description?: string;
}

export interface SyncDue {
  date?: string;
  timezone?: string | null;
  string?: string;
  lang?: string;
  is_recurring?: boolean;
}

export interface SyncDeadline {
  date?: string;
  lang?: string;
}

export interface SyncDuration {
  amount?: number;
  unit?: string;
}

export interface SyncItem {
  id: string;
  project_id: string;
  section_id?: string | null;
  parent_id?: string | null;
  content: string;
  description?: string;
  /** Todoist's own scale: 4 is urgent, 1 is none. Inverted on import. */
  priority?: number;
  child_order?: number;
  day_order?: number;
  collapsed?: boolean;
  due?: SyncDue | null;
  deadline?: SyncDeadline | null;
  duration?: SyncDuration | null;
  /** Label *names*, not ids. */
  labels?: string[];
  checked?: boolean;
  completed_at?: string | null;
  is_deleted?: boolean;
  added_at?: string;
  added_by_uid?: string | null;
  responsible_uid?: string | null;
}

export interface SyncLabel {
  id: string;
  name: string;
  color?: string;
  item_order?: number;
  is_deleted?: boolean;
  is_favorite?: boolean;
}

export interface SyncNote {
  id: string;
  item_id?: string | null;
  project_id?: string | null;
  content?: string;
  posted_at?: string;
  posted_uid?: string | null;
  is_deleted?: boolean;
  file_attachment?: {
    file_name?: string;
    file_type?: string;
    file_url?: string;
    file_size?: number;
  } | null;
}

export interface SyncFilter {
  id: string;
  name: string;
  query?: string;
  color?: string;
  item_order?: number;
  is_deleted?: boolean;
  is_favorite?: boolean;
}

export interface SyncReminder {
  id: string;
  item_id: string;
  type?: string;
  minute_offset?: number | null;
  due?: SyncDue | null;
  name?: string;
  loc_lat?: string | number | null;
  loc_long?: string | number | null;
  radius?: number | null;
  loc_trigger?: string | null;
  is_deleted?: boolean;
}

/** A `POST /api/v1/sync` response with `sync_token: "*"`. */
export interface SyncExport {
  full_sync?: boolean;
  sync_token?: string;
  projects?: SyncProject[];
  sections?: SyncSection[];
  items?: SyncItem[];
  labels?: SyncLabel[];
  notes?: SyncNote[];
  filters?: SyncFilter[];
  reminders?: SyncReminder[];
  user?: { id?: string; full_name?: string; email?: string; tz_info?: { timezone?: string } };
}

/* ------------------------------------------------------------------ */
/* The MCP connector's normalised shape.                               */
/* ------------------------------------------------------------------ */

export interface ConnectorProject {
  id: string;
  name: string;
  parentId?: string | null;
  childOrder?: number;
  color?: string;
  isFavorite?: boolean;
  isArchived?: boolean;
  isInboxProject?: boolean;
  description?: string;
  sections?: ConnectorSection[];
  children?: ConnectorProject[];
}

export interface ConnectorSection {
  id: string;
  name: string;
  projectId?: string;
  sectionOrder?: number;
  description?: string;
}

export interface ConnectorTask {
  id: string;
  content: string;
  description?: string;
  projectId: string;
  sectionId?: string | null;
  parentId?: string | null;
  /** `"p1"`..`"p4"`, already in user-facing order. */
  priority?: string;
  dueDate?: string;
  dueDatetime?: string;
  dueString?: string;
  recurring?: boolean;
  deadlineDate?: string;
  duration?: { amount?: number; unit?: string } | null;
  labels?: string[];
  checked?: boolean;
  completedAt?: string | null;
  addedAt?: string;
  childOrder?: number;
}

export interface ConnectorLabel {
  id: string;
  name: string;
  color?: string;
  order?: number;
  isFavorite?: boolean;
}

export interface ConnectorFilter {
  id: string;
  name: string;
  query?: string;
  color?: string;
  itemOrder?: number;
  isFavorite?: boolean;
}

export interface ConnectorComment {
  id: string;
  taskId?: string | null;
  projectId?: string | null;
  content?: string;
  postedAt?: string;
}

export interface ConnectorExport {
  projects?: ConnectorProject[];
  tasks?: ConnectorTask[];
  labels?: ConnectorLabel[];
  /** Label names seen on shared tasks that have no personal label record. */
  sharedLabels?: string[];
  filters?: ConnectorFilter[];
  comments?: ConnectorComment[];
}
