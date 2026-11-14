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
  | { kind: "day"; day: string }
  | { kind: "upcoming" }
  | { kind: "all" }
  | { kind: "completed" }
  // Not a place so much as a question; `/` is the usual way in. It renders the
  // same rows as every other list, from the query that App holds.
  | { kind: "search" }
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
  today,
  rewardsEnabled,
}: {
  store: LightStore;
  view: View;
  onSelect: (view: View) => void;
  counts: { today: number; upcoming: number; all: number; completed: number };
  today: string;
  /** With rewards off the trophy cabinet is hidden, not deleted. */
  rewardsEnabled: boolean;
}) {
  const projects = store
    .all("project")
    .filter((project) => !project.isArchived)
    .filter((project) => rewardsEnabled || !project.isRewards);

  // The inbox is a place you go, like Today, not a project you organise, so it
  // gets its own entry above the views and is left out of the tree. Which one
  // is by flag, never by name: a project merely called "Inbox" is not it.
  const inbox = projects.find((project) => project.isInbox) ?? null;
  const byParent = new Map<string | null, Project[]>();
  for (const project of projects) {
    // Every flagged inbox, not just the one the nav entry chose. Duplicates
    // should not exist — `ensureInbox` keeps one — but a cold-start race on
    // two devices can still mint a second, and when that happens the sidebar
    // showing "Inbox" twice is how the user finds out. One entry at the top,
    // and the strays stay out of the tree rather than advertising the bug.
    if (project.isInbox) continue;
    // Anything filed under the inbox rises to the top level instead, because
    // the inbox no longer draws a branch to hang it from, and a project that
    // cannot be reached from the sidebar is worse than one that moved up.
    const parentId = inbox !== null && project.parentId === inbox.id ? null : project.parentId;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(project);
    byParent.set(parentId, siblings);
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

  const views: { view: View; label: string; count: number; selected?: boolean }[] = [
    // First, above Today: capture lands here, and it is the list to empty. It
    // is an ordinary project view underneath, so there is no new kind of view
    // to route or remember.
    ...(inbox === null
      ? []
      : [
          {
            view: { kind: "project", projectId: inbox.id } as View,
            label: "Inbox",
            count: openCount(inbox.id),
            selected: view.kind === "project" && view.projectId === inbox.id,
          },
        ]),
    { view: { kind: "today" }, label: "Today", count: counts.today },
    // The planning surface, as opposed to the list: same tasks, laid out
    // against the hours they are meant to happen in.
    { view: { kind: "day", day: today }, label: "Day", count: counts.today },
    { view: { kind: "upcoming" }, label: "Upcoming", count: counts.upcoming },
    { view: { kind: "all" }, label: "All tasks", count: counts.all },
    // Without this, imported history — a Todoist account brings in hundreds of
    // completed tasks — would be synced but unreachable.
    { view: { kind: "completed" }, label: "Completed", count: counts.completed },
    { view: { kind: "search" }, label: "Search", count: 0 },
  ];

  return (
    <nav className="sidebar" aria-label="Views and projects">
      <ul className="dn-nav">
        {views.map((entry) => (
          <li key={entry.label}>
            <NavItem
              label={entry.label}
              count={entry.count}
              selected={entry.selected ?? view.kind === entry.view.kind}
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
