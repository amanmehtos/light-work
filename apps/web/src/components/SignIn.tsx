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

import { useEffect, useState } from "react";
import {
  completeRedirectSignIn,
  hasRedirectSignIn,
  requestCode,
  signInMethods,
  verifyCode,
  GOOGLE_START_URL,
  type StoredSession,
} from "../auth.js";

export function SignIn({ onSignedIn }: { onSignedIn: (session: StoredSession) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);
  // Coming back from Google, the token is already in the fragment: show the
  // card as working rather than flashing an empty form that is about to vanish.
  const [returning, setReturning] = useState(hasRedirectSignIn);

  useEffect(() => {
    let live = true;

    completeRedirectSignIn()
      .then((session) => {
        if (!live) return;
        if (session !== null) onSignedIn(session);
        else setReturning(false);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : "Could not sign in.");
        setReturning(false);
      });

    // Only offered where the deployment has an OAuth client, so the button is
    // never shown unless pressing it can work.
    void signInMethods().then((methods) => {
      if (live) setGoogle(methods.google);
    });

    return () => {
      live = false;
    };
  }, [onSignedIn]);

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

        {returning ? (
          <p className="dn-prose signin-returning">Completing sign-in…</p>
        ) : stage === "email" ? (
          <form onSubmit={submitEmail} className="signin-form">
            {google && (
              <>
                {/* A link, not a fetch: OAuth is a full-page navigation, and
                    Google refuses to render its consent screen in a frame. */}
                <a className="dn-btn dn-btn--block signin-google" href={GOOGLE_START_URL}>
                  <GoogleMark />
                  Continue with Google
                </a>
                <div className="dn-divider dn-divider--labelled">
                  <span>or</span>
                </div>
              </>
            )}
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

/**
 * Google's mark, in its fixed brand colours.
 *
 * Deliberately not themed: the identity guidelines require these exact
 * colours, so this is the one place in the app that opts out of Diurnal's
 * palette.
 */
function GoogleMark() {
  return (
    <svg className="signin-google-mark" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
