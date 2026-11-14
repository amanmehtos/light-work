/**
 * "Add section", at the foot of a project.
 *
 * A button that becomes a one-line field, because a section is a name and
 * nothing more at the moment of making it; its notes are written elsewhere (the
 * agent does most of that). Enter adds it and keeps the field open for the next,
 * Escape or leaving the field empty closes it — the same grammar as the add-task
 * line.
 *
 * It is a plain input, so the typing guard keeps every shortcut out of it.
 */

import { useState } from "react";

export function AddSection({ onAdd }: { onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  if (!open) {
    return (
      <button type="button" className="dn-btn dn-btn--ghost dn-btn--sm add-section" onClick={() => setOpen(true)}>
        + Add section
      </button>
    );
  }

  function submit() {
    const trimmed = name.trim();
    if (trimmed === "") return;
    onAdd(trimmed);
    setName("");
  }

  return (
    <form
      className="add-section add-section--open"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="dn-label dn-sr-only" htmlFor="add-section-name">
        Section name
      </label>
      <input
        id="add-section-name"
        className="dn-input"
        value={name}
        autoFocus
        autoComplete="off"
        placeholder="Section name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setName("");
            setOpen(false);
          }
        }}
      />
      <button type="submit" className="dn-btn dn-btn--sm" disabled={name.trim() === ""}>
        Add
      </button>
    </form>
  );
}
