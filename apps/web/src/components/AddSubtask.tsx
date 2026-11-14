/**
 * The line that adds a subtask, drawn under the row it adds to.
 *
 * The interaction is "Add subtask" on the task itself, as Todoist's task menu
 * has it, rather than indenting an existing task under the one above it. See
 * `TaskRow`'s button for why; in short, this is the only gesture that is the
 * same in every list a row appears in, and the only one that makes a task rather
 * than rearranging one.
 *
 * A title and nothing else. Quick Add's shorthand is deliberately not read here:
 * it is safe on the add-task line because the chips show what was read before
 * Enter, and this field has none. A date wanted on a subtask is the row's own
 * date chip, once it exists.
 *
 * Enter adds it and keeps the field for the next — subtasks come in runs — and
 * what has been added is listed beneath, because the new row may not be on this
 * page: in Today or a label's view a subtask with no date and no label is not in
 * the list, though its parent's `2/5` chip has already counted it. Escape closes.
 * A plain input, so the typing guard keeps the seven shortcuts out of it.
 */

import { useId, useState } from "react";

export function AddSubtask({
  parentTitle,
  onAdd,
  onClose,
}: {
  parentTitle: string;
  onAdd: (content: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [added, setAdded] = useState<string[]>([]);

  function submit() {
    const trimmed = title.trim();
    if (trimmed === "") return;
    onAdd(trimmed);
    setAdded((current) => [...current, trimmed]);
    setTitle("");
  }

  return (
    <form
      className="add-subtask"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="dn-label dn-sr-only" htmlFor={id}>
        Subtask of {parentTitle}
      </label>
      <input
        id={id}
        className="dn-input"
        value={title}
        autoFocus
        autoComplete="off"
        placeholder="Add a subtask"
        onChange={(event) => setTitle(event.target.value)}
      />
      <button type="submit" className="dn-btn dn-btn--sm" disabled={title.trim() === ""}>
        Add
      </button>
      <button type="button" className="dn-btn dn-btn--ghost dn-btn--sm" onClick={onClose}>
        Done
      </button>
      {added.length > 0 && (
        <p className="dn-hint add-subtask__added" aria-live="polite">
          Added: {added.join(", ")}
        </p>
      )}
    </form>
  );
}
