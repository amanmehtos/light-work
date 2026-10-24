import type { EntityKind } from "@light/core";

export type WarningCode =
  | "missing_project_parent"
  | "missing_task_parent"
  | "missing_section"
  | "missing_task_project"
  | "label_minted_from_task"
  | "priority_out_of_range"
  | "unknown_duration_unit"
  | "unparsable_date"
  | "orphan_comment"
  | "unsupported_reminder"
  | "skipped_deleted";

export interface Warning {
  code: WarningCode;
  /** The Todoist id the warning is about, so it can be looked up in the export. */
  sourceId: string;
  detail: string;
}

export interface ImportReport {
  source: "sync-api" | "connector";
  counts: Record<EntityKind, number>;
  /** Tasks that came in already completed. Included in `counts.task`. */
  completedTasks: number;
  /** Labels created from a name found on a task, with no label record of their own. */
  mintedLabels: string[];
  warnings: Warning[];
  /** Fields present in the export that this importer does not yet carry over. */
  unmappedFields: string[];
}

export function emptyCounts(): Record<EntityKind, number> {
  return {
    project: 0,
    section: 0,
    task: 0,
    label: 0,
    comment: 0,
    reminder: 0,
    filter: 0,
    focusSession: 0,
  };
}

export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(`Imported from ${report.source}:`);
  for (const [kind, count] of Object.entries(report.counts)) {
    if (count > 0) lines.push(`  ${kind.padEnd(14)} ${count}`);
  }
  if (report.completedTasks > 0) {
    lines.push(`  (of which ${report.completedTasks} already completed)`);
  }
  if (report.mintedLabels.length > 0) {
    lines.push("");
    lines.push(
      `Created ${report.mintedLabels.length} label(s) found only on tasks: ${report.mintedLabels.join(", ")}`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push("");
    const byCode = new Map<string, number>();
    for (const w of report.warnings) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
    lines.push(`${report.warnings.length} warning(s):`);
    for (const [code, count] of byCode) lines.push(`  ${code.padEnd(26)} ${count}`);
  }
  if (report.unmappedFields.length > 0) {
    lines.push("");
    lines.push(`Not carried over: ${report.unmappedFields.join(", ")}`);
  }
  return lines.join("\n");
}
