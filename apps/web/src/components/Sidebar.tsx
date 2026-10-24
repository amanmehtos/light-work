/**
 * Views and the project tree.
 *
 * Projects nest arbitrarily deep — the account this was built against goes
 * three levels — so the tree renders recursively rather than assuming a depth.
 *
 * `.dn-nav` is one of the three things Light Week needs that Diurnal does not
 * have yet; it is defined in `diurnal-additions.css`, in the library's idiom,
 * ready to move upstream.
 */

import type { Project } from "@light/core";
import { compareOrder } from "@light/core";
import type { LightStore } from "@light/client-sdk";

export type View =
  | { kind: "today" }
  | { kind: "upcoming" }
  | { kind: "all" }
  | { kind: "completed" }
  | { kind: "project"; projectId: string };

function NavItem({
  label,
  count,
  selected,
  depth = 0,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  depth?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="dn-nav__item"
      aria-current={selected ? "page" : undefined}
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      onClick={onClick}
    >
      <span className="dn-nav__label">{label}</span>
      {count > 0 && <span className="dn-nav__count">{count}</span>}
    </button>
  );
}

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
      <ul className="dn-nav" role="group">
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
      <ul className="dn-nav">
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

      <div className="dn-eyebrow sidebar-heading">Projects</div>
      {renderTree(null, 0) ?? <p className="dn-hint pad">No projects yet.</p>}
    </nav>
  );
}
