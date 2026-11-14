/**
 * The comments on a task, at the foot of its editor sheet.
 *
 * Here because 31 of them arrived with the Todoist import and nothing could
 * reach them: the rows synced, the API served them, and neither client drew
 * one. The plan (Phase 6) asks for exactly this much — a thread and an add
 * field — and the restraint is the design. A comment is a note on a task, not
 * a conversation, so there is no author, no avatar, no reactions, no editing in
 * place and no count on the row; the thread is read when the task is opened.
 *
 * It sits *outside* the sheet's `<form>`, deliberately. Everything in the form
 * is a draft that Save commits and Cancel throws away; a comment is written the
 * moment it is added, so putting its field among the draft ones would make
 * Cancel look as if it could unsay it. As a sibling of the form it also cannot
 * submit the form: Enter in the box is a line break, and "Comment" is the only
 * thing that posts.
 *
 * The box is a `<textarea>`, which is the whole of the keyboard story:
 * `isTypingTarget` in `shortcuts.ts` treats every textarea as a field, and the
 * editor is a sheet besides, so `q`, `j`, `e` and Enter reach the text and not
 * the app. `test/task-comments.test.tsx` renders this and holds that to it.
 *
 * Text is shown as written, line breaks kept, never parsed: Todoist comments
 * are markdown, and a renderer is a second place for links and HTML to go
 * wrong for the sake of 31 notes.
 */

import { useState } from "react";
import type { Comment } from "@light/core";
import { postedTime } from "@light/client-sdk";

/**
 * A link only when it is a web address. The URL came from an import, and
 * `javascript:` in an `href` is the one thing here that could do anything.
 */
function webUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function postedOn(comment: Comment): string | null {
  const time = postedTime(comment);
  return time === null
    ? null
    : new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function TaskComments({
  comments,
  onAdd,
}: {
  /** Oldest first — `commentsOnTask`'s order, which this does not change. */
  comments: Comment[];
  onAdd: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const blank = text.trim() === "";

  function post() {
    if (blank) return;
    onAdd(text);
    setText("");
  }

  return (
    <section className="comments" aria-label="Comments">
      <h3 className="comments-title">{comments.length === 0 ? "Comments" : `Comments · ${comments.length}`}</h3>

      {comments.length > 0 && (
        <ul className="comment-list">
          {comments.map((comment) => {
            const date = postedOn(comment);
            // `?? null` because a row from an older import can lack the key
            // outright, and the type says null where the data says nothing.
            const attachment = comment.attachment ?? null;
            const href = attachment === null ? null : webUrl(attachment.fileUrl ?? "");
            const name = attachment?.fileName || "An attachment";
            return (
              <li key={comment.id} className="comment">
                {(comment.content ?? "") !== "" && <p className="comment-text">{comment.content}</p>}
                {attachment !== null && (
                  <p className="comment-attachment dn-hint">
                    {href === null ? (
                      name
                    ) : (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {name}
                      </a>
                    )}
                  </p>
                )}
                {date !== null && <span className="dn-hint">{date}</span>}
              </li>
            );
          })}
        </ul>
      )}

      <div className="dn-field">
        <label className="dn-label" htmlFor="comment-new">
          Add a comment
        </label>
        <textarea
          id="comment-new"
          className="dn-textarea comment-box"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div className="editor-actions">
        <button className="dn-btn" type="button" disabled={blank} onClick={post}>
          Comment
        </button>
      </div>
    </section>
  );
}
