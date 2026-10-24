/**
 * The add-task line.
 *
 * Accepts the shorthand people already have in their fingers from Todoist:
 * `p1` for priority, `@label` for a label, and `//` for a description. Dates
 * are a separate field rather than parsed from the text, because guessing
 * wrong about a date is worse than one extra tab.
 */

import { useState } from "react";
import type { Priority } from "@light/core";
import { Button, TextField } from "@light/diurnal";

export interface ParsedEntry {
  content: string;
  priority: Priority;
  labels: string[];
  description: string;
}

/** Pulls `p1`, `@label` and `// description` out of a line of text. */
export function parseEntry(input: string): ParsedEntry {
  let text = input;
  let description = "";

  const split = text.indexOf("//");
  if (split !== -1) {
    description = text.slice(split + 2).trim();
    text = text.slice(0, split);
  }

  let priority: Priority = 4;
  text = text.replace(/(^|\s)p([1-4])(?=\s|$)/gi, (_match, space: string, digit: string) => {
    priority = Number(digit) as Priority;
    return space === "" ? "" : " ";
  });

  const labels: string[] = [];
  text = text.replace(/(^|\s)@([^\s@]+)/g, (_match, space: string, name: string) => {
    labels.push(name);
    return space === "" ? "" : " ";
  });

  return {
    content: text.replace(/\s+/g, " ").trim(),
    priority,
    labels: [...new Set(labels)],
    description,
  };
}

export function AddTask({
  onAdd,
  disabled,
}: {
  onAdd: (entry: ParsedEntry, dueDate: string | null) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [due, setDue] = useState("");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const entry = parseEntry(text);
    if (entry.content === "") return;
    onAdd(entry, due === "" ? null : due);
    setText("");
    setDue("");
  }

  return (
    <form className="add-task" onSubmit={submit}>
      <TextField
        label="New task"
        labelHidden
        className="add-task-text"
        value={text}
        disabled={disabled}
        placeholder="Add a task —  p1  @label  // notes"
        onChange={(event) => setText(event.target.value)}
      />
      <TextField
        label="Due date"
        labelHidden
        type="date"
        value={due}
        disabled={disabled}
        onChange={(event) => setDue(event.target.value)}
      />
      <Button variant="primary" type="submit" disabled={disabled || parseEntry(text).content === ""}>
        Add
      </Button>
    </form>
  );
}
