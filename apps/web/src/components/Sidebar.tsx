/**
 * Views and the project tree.
 *
 * The nav is eight things and is meant to stay eight: Inbox, Today, Day,
 * Upcoming, Search, Labels, Completed, and Projects. "All tasks" was the ninth
 * and has gone — it was every open task in one column, which Search answers better
 * and no view of the account is the worse for losing. Anything that wants to be a
 * place in this list is a view of one of these (a label is one of Labels), not
 * another entry.
 *
 * Projects nest arbitrarily deep — the account this was built against goes
 * three levels — so the tree renders recursively rather than assuming a depth.
 *
 * `.dn-nav` is one of the three things Light Week needs that Diurnal does not
 * have yet; it is defined in `diurnal-additions.css`, in the library's idiom,
 * ready to move upstream.
 */

import { useState } from "react";
import type { Project } from "@light/core";
import { compareOrder } from "@light/core";
import type { LightStore } from "@light/client-sdk";

export type View =
  | { kind: "today" }
  | { kind: "day"; day: string }
  | { kind: "upcoming" }
  | { kind: "completed" }
  // Not a place so much as a question; `/` is the usual way in. It renders the
  // same rows as every other list, from the query that App holds.
  | { kind: "search" }
  // The open tasks that carry one label, across every project.
  | { kind: "label"; labelId: string }
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
  labelCounts,
  today,
  rewardsEnabled,
}: {
  store: LightStore;
  view: View;
  onSelect: (view: View) => void;
  counts: { today: number; upcoming: number; completed: number };
  /**
   * Open tasks per label, as the label's own view lists them. Passed in, not
   * recounted here: they are the length of the rows that view renders, so the
   * badge cannot say a different number.
   */
  labelCounts: ReadonlyMap<string, number>;
  today: string;
  /** With rewards off the trophy cabinet is hidden, not deleted. */
  rewardsEnabled: boolean;
}) {
  const [labelsOpen, setLabelsOpen] = useState(false);
  // Unfolded whenever one label is the view, so the entry that is current is
  // never hidden inside a closed list.
  const labelsShown = labelsOpen || view.kind === "label";

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
    { view: { kind: "search" }, label: "Search", count: 0 },
  ];

  // After the label entry: Completed, which without this — a Todoist account
  // brings in hundreds of completed tasks — would be synced but unreachable.
  const completed = { view: { kind: "completed" } as View, label: "Completed", count: counts.completed };

  const labels = store.ordered("label");

  const entry = (item: { view: View; label: string; count: number; selected?: boolean }) => (
    <li key={item.label}>
      <NavItem
        label={item.label}
        count={item.count}
        selected={item.selected ?? view.kind === item.view.kind}
        onClick={() => onSelect(item.view)}
      />
    </li>
  );

  return (
    <nav className="sidebar" aria-label="Views and projects">
      <ul className="dn-nav">
        {views.map(entry)}

        {/* Labels is a place that opens onto the labels, not a view with a page
            of its own: pressing it unfolds them beneath it, one entry each, and
            a label is the view. That keeps it one line in the nav however many
            labels there are, and no label can add a ninth. */}
        <li>
          <button
            type="button"
            className="dn-nav__item"
            aria-expanded={labelsShown}
            onClick={() => setLabelsOpen(!labelsOpen)}
          >
            <span className="dn-nav__label">Labels</span>
            <span className="dn-nav__count" aria-hidden="true">
              {labelsShown ? "▾" : "▸"}
            </span>
          </button>
          {labelsShown && (
            <ul className="dn-nav" role="group" aria-label="Labels">
              {labels.length === 0 ? (
                <li className="dn-hint pad">No labels yet. Type @name on a task.</li>
              ) : (
                labels.map((label) => (
                  <li key={label.id}>
                    <NavItem
                      label={`@${label.name}`}
                      count={labelCounts.get(label.id) ?? 0}
                      depth={1}
                      selected={view.kind === "label" && view.labelId === label.id}
                      onClick={() => onSelect({ kind: "label", labelId: label.id })}
                    />
                  </li>
                ))
              )}
            </ul>
          )}
        </li>

        {entry(completed)}
      </ul>

      <div className="dn-eyebrow sidebar-heading">Projects</div>
      {renderTree(null, 0) ?? <p className="dn-hint pad">No projects yet.</p>}
    </nav>
  );
}
