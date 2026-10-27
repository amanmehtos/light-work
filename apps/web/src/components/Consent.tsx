/**
 * The consent screen: "this agent wants access to your tasks".
 *
 * The authorization endpoint cannot ask this itself. It has no idea who is
 * knocking — the session token lives in localStorage rather than a cookie, so
 * nothing the server renders knows the user. So it hands the request here, to
 * the one place that is already signed in.
 *
 * Nothing in the query string is trusted. The server checks every parameter
 * against what the client registered before it issues anything; what the
 * parameters are used for here is telling the person what they are allowing.
 */

import { useState } from "react";
import { decideConsent, type ConsentRequest, type StoredSession } from "../auth.js";

/** What each scope actually lets an agent do, in the user's terms. */
const SCOPE_TEXT: Record<string, { title: string; detail: string }> = {
  "mcp:read": {
    title: "Read your tasks",
    detail: "Projects, labels, due dates, and where your focus time went.",
  },
  "mcp:write": {
    title: "Change your tasks",
    detail: "Add, edit, complete, reorder and delete — including subtasks.",
  },
  "tasks:read": {
    title: "Read your tasks",
    detail: "Sync your whole account down, so the app can show it while offline.",
  },
  "tasks:write": {
    title: "Change your tasks, and record focus time",
    detail: "Add, edit, complete and delete, and log focus sessions against a task.",
  },
};

export function Consent({
  request,
  session,
}: {
  request: ConsentRequest;
  session: StoredSession;
}) {
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scopes = request.scope.split(/\s+/).filter((scope) => scope !== "");

  async function decide(approve: boolean): Promise<void> {
    setBusy(approve ? "allow" : "deny");
    setError(null);
    try {
      // A full navigation, not a fetch: the agent is waiting on its own
      // redirect URI, which is usually a loopback port on this machine.
      window.location.replace(await decideConsent(session.token, request, approve));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not complete the request.");
      setBusy(null);
    }
  }

  // Shown rather than hidden: where the code is about to be sent is the one
  // thing that decides whether this is safe, so it should be legible.
  let destination = request.redirectUri;
  try {
    destination = new URL(request.redirectUri).host || request.redirectUri;
  } catch {
    /* Leave it as written; the server has already checked it is registered. */
  }

  return (
    <main className="signin">
      <div className="dn-card dn-card--float signin-card">
        <div className="dn-eyebrow">Light Week</div>
        <h1 className="consent-title">Allow access?</h1>
        <p className="dn-prose">
          <strong>{request.clientName}</strong> is asking to connect to your tasks as{" "}
          {session.user.email}.
        </p>

        <ul className="consent-scopes">
          {scopes.map((scope) => {
            const text = SCOPE_TEXT[scope];
            return (
              <li key={scope} className="consent-scope">
                <span className="consent-scope-title">{text?.title ?? scope}</span>
                {text !== undefined && <span className="dn-hint">{text.detail}</span>}
              </li>
            );
          })}
        </ul>

        <p className="dn-hint consent-destination">
          It will be sent back to <code>{destination}</code>. You can revoke this later by signing
          out.
        </p>

        {error !== null && <p className="signin-error">{error}</p>}

        <div className="consent-actions">
          <button
            className="dn-btn dn-btn--primary dn-btn--block"
            type="button"
            disabled={busy !== null}
            onClick={() => void decide(true)}
          >
            {busy === "allow" ? "Allowing…" : "Allow"}
          </button>
          <button
            className="dn-btn dn-btn--block"
            type="button"
            disabled={busy !== null}
            onClick={() => void decide(false)}
          >
            {busy === "deny" ? "Refusing…" : "Not now"}
          </button>
        </div>
      </div>
    </main>
  );
}
