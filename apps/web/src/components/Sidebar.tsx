/**
 * Views and the project tree.
 *
 * Projects nest arbitrarily deep — the account this was built against goes
 * three levels — so the tree renders recursively rather than assuming a depth.
 */

import type { Project } from "@light/core";
import { compareOrder } from "@light/core";
import type { LightStore } from "@light/client-sdk";
import { Heading, NavItem, Text } from "@light/diurnal";

export type View =
  | { kind: "today" }
  | { kind: "upcoming" }
  | { kind: "all" }
  | { kind: "completed" }
  | { kind: "project"; projectId: string };

export function Sidebar({
  store,
  view,
  onSelect,
  counts,
}: {
  store: LightStore;
  view: View;
  onSelect: (view: View) => void;
  counts: { today: number; upcoming: number; all: number; completed: number };
}) {
  const projects = store.all("project").filter((project) => !project.isArchived);
  const byParent = new Map<string | null, Project[]>();
  for (const project of projects) {
    const siblings = byParent.get(project.parentId) ?? [];
    siblings.push(project);
    byParent.set(project.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => compareOrder(a.order, b.order));
  }

  const openCount = (projectId: string): number =>
    store.all("task").filter((task) => task.projectId === projectId && !task.isCompleted).length;

  function renderTree(parentId: string | null, depth: number) {
    const siblings = byParent.get(parentId) ?? [];
    if (siblings.length === 0) return null;
    return (
      <ul className="tree" role="group">
        {siblings.map((project) => (
          <li key={project.id}>
            <NavItem
              label={project.name}
              count={openCount(project.id)}
              depth={depth}
              selected={view.kind === "project" && view.projectId === project.id}
              onClick={() => onSelect({ kind: "project", projectId: project.id })}
            />
            {renderTree(project.id, depth + 1)}
          </li>
        ))}
      </ul>
    );
  }

  const views: { view: View; label: string; count: number }[] = [
    { view: { kind: "today" }, label: "Today", count: counts.today },
    { view: { kind: "upcoming" }, label: "Upcoming", count: counts.upcoming },
    { view: { kind: "all" }, label: "All tasks", count: counts.all },
    // Without this, imported history — a Todoist account brings in hundreds of
    // completed tasks — would be synced but unreachable.
    { view: { kind: "completed" }, label: "Completed", count: counts.completed },
  ];

  return (
    <nav className="sidebar" aria-label="Views and projects">
      <ul className="tree">
        {views.map((entry) => (
          <li key={entry.label}>
            <NavItem
              label={entry.label}
              count={entry.count}
              selected={view.kind === entry.view.kind}
              onClick={() => onSelect(entry.view)}
            />
          </li>
        ))}
      </ul>

      <Heading level={3} className="sidebar-heading">
        Projects
      </Heading>
      {renderTree(null, 0) ?? (
        <Text tone="soft" size="small" className="pad">
          No projects yet.
        </Text>
      )}
    </nav>
  );
}
