/**
 * A section's heading in a project: a fold chevron, the name, how many tasks it
 * holds, and a menu.
 *
 * Todoist's sections are the user's own structure — the imported account has
 * thirty-eight of them, several holding the plan in their notes — so the
 * heading shows the notes too, clamped, rather than treating them as metadata.
 *
 * The whole heading is a drop target (`data-section-id`; see `headingUnder`):
 * a task let go over it is filed in the section. The menu is a `RowMenu`, which
 * is not a second sheet and so cannot fight the editor over Escape.
 *
 * Monochrome and from the library's classes: a ghost button, a badge, an
 * eyebrow. Nothing here has a colour of its own.
 */

import { useState } from "react";
import type { Section } from "@light/core";
import { RowMenu, type MenuItem } from "./RowMenu.js";

export function SectionHeading({
  section,
  count,
  onToggle,
  onRename,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  section: Section;
  /** Tasks in it, including any folded under a parent and any hidden by this fold. */
  count: number;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Absent at the ends of the list, where there is nowhere to go. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(section.name);

  function commit() {
    const name = draft.trim();
    setRenaming(false);
    // An empty name is not a rename; it keeps the old one rather than leaving a
    // heading with nothing to read.
    if (name !== "" && name !== section.name) onRename(name);
  }

  const items: MenuItem[] = [
    {
      key: "rename",
      label: "Rename",
      onSelect: () => {
        setDraft(section.name);
        setRenaming(true);
      },
    },
    ...(onMoveUp === undefined ? [] : [{ key: "up", label: "Move up", onSelect: onMoveUp }]),
    ...(onMoveDown === undefined ? [] : [{ key: "down", label: "Move down", onSelect: onMoveDown }]),
    // Says what it does to the tasks, because that is the question anyone has
    // about deleting a heading.
    { key: "delete", label: "Delete section (tasks stay)", onSelect: onDelete },
  ];

  return (
    <div className="section-heading" data-section-id={section.id}>
      <div className="section-heading__bar">
        <button
          type="button"
          className="row-fold__btn"
          aria-expanded={!section.isCollapsed}
          aria-label={`${section.isCollapsed ? "Show" : "Hide"} the tasks in ${section.name}`}
          onClick={onToggle}
        >
          {section.isCollapsed ? "▸" : "▾"}
        </button>

        {renaming ? (
          <input
            className="dn-input section-heading__input"
            value={draft}
            autoFocus
            aria-label={`Rename ${section.name}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                // Let go without renaming. Stopped here so the page's own
                // Escape (which would also blur the field) does not run a
                // second time and commit through `onBlur`.
                event.stopPropagation();
                setDraft(section.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h2 className="section-heading__name">{section.name}</h2>
        )}

        <span className="dn-badge" title={`${count} task${count === 1 ? "" : "s"}`}>
          {count}
        </span>
        {section.isArchived && <span className="dn-badge dn-badge--outline">archived</span>}

        <span className="spacer" />
        <RowMenu
          label={`Section ${section.name}`}
          triggerClassName="dn-btn dn-btn--ghost dn-btn--sm"
          trigger="⋯"
          items={items}
        />
      </div>

      {!section.isCollapsed && section.description !== "" && (
        <p className="dn-hint section-heading__notes">{section.description}</p>
      )}
    </div>
  );
}
