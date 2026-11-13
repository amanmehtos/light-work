/**
 * The add-task line.
 *
 * One field that reads the shorthand people already have in their fingers from
 * Todoist: `tomorrow 9am`, `every weekday`, `p1`, `@label`, `#project` and
 * `// notes`. Everything it read is drawn as a chip underneath, before you
 * press Enter, and each chip puts its text back in the title when clicked.
 *
 * This used to refuse dates altogether ("guessing wrong about a date is worse
 * than one extra tab"). It reads them now, and what makes that safe is not the
 * parser being clever but it being allowed to say nothing: whatever it is not
 * sure of stays in the title (see `parse.ts`), and whatever it had to assume is
 * drawn outlined with a "?" so it does not look as certain as the rest. The
 * date field stays, and wins. It is the answer when the parser is wrong, and
 * the only way to say a date the parser would not.
 *
 * The parse happens here only to draw it. What gets created is parsed again by
 * `Operations.createTaskFromText` from the same text, the same dismissals and
 * the same day, so the chips and the task cannot differ.
 */

import { useMemo, useState } from "react";
import { clockAt, parseQuickAdd, type ProjectRef } from "@light/client-sdk";
import { chipLabel, chipTitle, reconcileDismissed, type Dismissed } from "../quick-add.js";

export interface AddRequest {
  text: string;
  /** Token text the person took back, which the parser must leave in the title. */
  ignore: string[];
  /** The date field, which replaces anything the text said about when. */
  dueDate: string | null;
  /** The time the chips were drawn at, so the task is made from the same reading. */
  now: string;
}

export function AddTask({
  onAdd,
  disabled,
  today,
  projects,
}: {
  onAdd: (request: AddRequest) => void;
  disabled?: boolean;
  /** The local calendar day every relative date is read against. */
  today: string;
  /** Where a `#Name` can point. */
  projects: readonly ProjectRef[];
}) {
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [dismissed, setDismissed] = useState<Dismissed[]>([]);

  // The parser matches by text; the dismissals are kept by place (see
  // `reconcileDismissed`) so that a new word is never swallowed by an old one.
  const ignore = useMemo(() => dismissed.map((item) => item.text), [dismissed]);

  // `now` is fixed along with the reading, not read again at submit: a repeat
  // typed at 08:59 and sent at 09:00 should be the task the chips described.
  const { parse, now } = useMemo(() => {
    const now = clockAt(new Date());
    return { parse: parseQuickAdd(text, { today, projects, ignore, now }), now };
  }, [text, today, projects, ignore]);

  // When the date field is filled it wins, and the chips that describe a
  // schedule say so rather than quietly lying about what will be created.
  const overridden = due !== "";
  const isSchedule = (kind: string) => kind === "date" || kind === "time" || kind === "recurrence";

  function change(next: string) {
    setDismissed((current) => reconcileDismissed(text, next, current));
    setText(next);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (parse.title === "") return;
    onAdd({ text, ignore, dueDate: overridden ? due : null, now });
    setText("");
    setDue("");
    setDismissed([]);
  }

  const refused = parse.declined[0];

  return (
    <form className="add-task" onSubmit={submit}>
      <div className="dn-field add-task-text">
        <label className="dn-label dn-sr-only" htmlFor="add-task-content">
          New task
        </label>
        <input
          id="add-task-content"
          className="dn-input"
          value={text}
          disabled={disabled}
          autoComplete="off"
          placeholder="Add a task —  tomorrow 9am  p1  @label  #project  // notes"
          onChange={(event) => change(event.target.value)}
        />
      </div>
      <div className="dn-field add-task-date">
        <label className="dn-label dn-sr-only" htmlFor="add-task-due">
          Due date
        </label>
        <input
          id="add-task-due"
          className="dn-input"
          type="date"
          value={due}
          disabled={disabled}
          onChange={(event) => setDue(event.target.value)}
        />
      </div>
      <button
        className="dn-btn dn-btn--primary"
        type="submit"
        disabled={disabled || parse.title === ""}
      >
        Add
      </button>

      {/* Chips are weight and border, never colour: a plain badge for what was
          read outright, an outlined one with a "?" for what took a guess, and
          a line through the ones the date field has overruled. */}
      {parse.tokens.length > 0 && (
        <ul className="add-task-chips" aria-label="What was read from your line">
          {parse.tokens.map((token) => {
            const assumed = token.assumed !== undefined;
            const struck = overridden && isSchedule(token.kind);
            return (
              <li key={`${token.start}:${token.text}`}>
                <button
                  type="button"
                  className={`dn-badge chip${assumed ? " dn-badge--outline" : ""}${struck ? " struck" : ""}`}
                  title={struck ? "The date field below is used instead" : chipTitle(token)}
                  aria-label={`${chipLabel(token, today)}${assumed ? ", assumed" : ""}. Put "${token.text}" back in the title`}
                  onClick={() => setDismissed((current) => [...current, { start: token.start, text: token.text }])}
                >
                  {chipLabel(token, today)}
                  {assumed && <span aria-hidden="true"> ?</span>}
                  <span aria-hidden="true" className="chip-x">
                    ×
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* The other half of "visible": what it looked at and left alone. A
          title that still says "next friday" is the intended outcome, and
          without this it would look like the parser had simply not noticed. */}
      {refused !== undefined && (
        <p className="dn-hint add-task-refused">
          Left as text: “{refused.text}” — {refused.reason}.
          {parse.declined.length > 1 && ` (and ${parse.declined.length - 1} more)`}
        </p>
      )}
    </form>
  );
}
