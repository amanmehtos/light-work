/**
 * Two-step sign-in: ask for a code, then enter it.
 *
 * Built from Diurnal's own classes rather than wrapped components — the
 * library is CSS with a small runtime, so markup is the interface.
 *
 * In local development the server hands the code back in the response rather
 * than emailing it, and this shows it: the difference between a usable dev
 * loop and one that needs a mail provider configured first.
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
      {/* Float: the highest elevation in the system, so it throws the longest
          shadow on the page. */}
      <div className="dn-card dn-card--float signin-card">
        <div className="dn-eyebrow">Light Suite</div>
        <h1>Light Week</h1>
        <p className="dn-prose">Tasks, with focus as a first-class citizen.</p>

        {stage === "email" ? (
          <form onSubmit={submitEmail} className="signin-form">
            <div className="dn-field">
              <label className="dn-label" htmlFor="signin-email">
                Email
              </label>
              <input
                id="signin-email"
                className="dn-input"
                type="email"
                value={email}
                required
                autoFocus
                autoComplete="email"
                placeholder="you@example.com"
                aria-describedby="signin-email-hint"
                onChange={(event) => setEmail(event.target.value)}
              />
              <span id="signin-email-hint" className="dn-hint">
                No password. We email a six-digit code that expires in fifteen minutes.
              </span>
            </div>
            <button className="dn-btn dn-btn--primary dn-btn--block" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send me a code"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="signin-form">
            <div className="dn-field">
              <label className="dn-label" htmlFor="signin-code">
                Six-digit code
              </label>
              <input
                id="signin-code"
                className="dn-input"
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
            </div>
            <button
              className="dn-btn dn-btn--primary dn-btn--block"
              type="submit"
              disabled={busy || code.length !== 6}
            >
              {busy ? "Checking…" : "Sign in"}
            </button>
            {devCode !== null && (
              <div className="dn-well dev-code">
                <div className="dn-eyebrow">Development</div>
                your code is <strong>{devCode}</strong>
              </div>
            )}
            <button
              type="button"
              className="dn-btn dn-btn--ghost"
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

        {error !== null && (
          <p role="alert" className="dn-hint signin-error">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
