/**
 * Two-step sign-in: ask for a code, then enter it.
 *
 * In local development the server hands the code back in the response rather
 * than emailing it, and this shows it — which is the difference between a
 * usable dev loop and one that needs a mail provider configured first.
 */

import { useState } from "react";
import { requestCode, verifyCode, type StoredSession } from "../auth.js";

export function SignIn({ onSignedIn }: { onSignedIn: (session: StoredSession) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await requestCode(email);
      setDevCode(result.devCode ?? null);
      setStage("code");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send a code.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await verifyCode(email, code));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <div className="signin-card">
        <h1>Light Week</h1>
        <p className="muted">Tasks, with focus as a first-class citizen.</p>

        {stage === "email" ? (
          <form onSubmit={submitEmail}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              required
              autoFocus
              autoComplete="email"
              placeholder="you@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
            <button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send me a code"}
            </button>
            <p className="muted small">
              No password. We email a six-digit code that expires in fifteen minutes.
            </p>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <label htmlFor="code">Six-digit code</label>
            <input
              id="code"
              value={code}
              required
              autoFocus
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="123456"
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
            <button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            {devCode !== null && (
              <p className="dev-code">
                Development mode — your code is <strong>{devCode}</strong>
              </p>
            )}
            <button
              type="button"
              className="link"
              onClick={() => {
                setStage("email");
                setCode("");
                setError(null);
              }}
            >
              Use a different address
            </button>
          </form>
        )}

        {error !== null && <p role="alert" className="error">{error}</p>}
      </div>
    </main>
  );
}
