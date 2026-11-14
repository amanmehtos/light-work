/**
 * The Projects heading in the sidebar, and "add project" beside it.
 *
 * A "+" and not a row. The nav is eight entries and meant to stay eight (see
 * `Sidebar.tsx`); a control on the heading of the tree it adds to is not an
 * entry in the list, so it cannot be the ninth.
 *
 * Opens into a name and a place to file it. The place is a `<select>` listing
 * the tree, indented, with "top level" first — chosen over a "+" on every
 * project row (Todoist's hover control) because the nav rows are single buttons
 * and a button cannot hold one, because a hover-only control is nothing on a
 * touch screen, and because a select reaches a project three levels down as
 * easily as one at the top. It starts at the top level: filing a project under
 * whichever one you happen to be looking at would nest things by accident.
 *
 * Enter adds it and keeps the form open with the same parent, so a run of
 * siblings (or a whole branch, parent first) is a run of Enters. Escape, or the
 * button, closes it. It is plain inputs, so the typing guard keeps the seven
 * shortcuts out of it.
 */

import { useRef, useState } from "react";
import type { ParentChoice } from "../projects.js";

export function ProjectsHeading({
  choices,
  onAdd,
}: {
  choices: readonly ParentChoice[];
  /** `parentId` is null for the top level. */
  onAdd: (name: string, parentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const toggle = useRef<HTMLButtonElement>(null);

  // A parent that went away on another device since it was picked is the top
  // level, as far as this form is concerned: the select would otherwise be
  // showing an option that no longer exists.
  const parent = choices.some((choice) => choice.project.id === parentId) ? parentId : "";

  function close() {
    setOpen(false);
    setName("");
    toggle.current?.focus();
  }

  function submit() {
    const trimmed = name.trim();
    if (trimmed === "") return;
    onAdd(trimmed, parent === "" ? null : parent);
    setName("");
  }

  return (
    <>
      <div className="sidebar-heading-row">
        <div className="dn-eyebrow sidebar-heading">Projects</div>
        <button
          ref={toggle}
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm add-project__toggle"
          aria-label="Add project"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
        >
          +
        </button>
      </div>

      {open && (
        <form
          className="add-project"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <label className="dn-label dn-sr-only" htmlFor="add-project-name">
            Project name
          </label>
          <input
            id="add-project-name"
            className="dn-input"
            value={name}
            autoFocus
            autoComplete="off"
            placeholder="Project name"
            onChange={(event) => setName(event.target.value)}
          />
          <label className="dn-label" htmlFor="add-project-parent">
            Inside
          </label>
          <select
            id="add-project-parent"
            className="dn-select"
            value={parent}
            onChange={(event) => setParentId(event.target.value)}
          >
            <option value="">Top level</option>
            {choices.map(({ project, depth }) => (
              <option key={project.id} value={project.id}>
                {/* A non-breaking indent: a select option collapses ordinary
                    leading spaces. */}
                {"  ".repeat(depth)}
                {project.name}
              </option>
            ))}
          </select>
          <div className="add-project__actions">
            <button type="submit" className="dn-btn dn-btn--sm" disabled={name.trim() === ""}>
              Add
            </button>
            <button type="button" className="dn-btn dn-btn--ghost dn-btn--sm" onClick={close}>
              Done
            </button>
          </div>
        </form>
      )}
    </>
  );
}
