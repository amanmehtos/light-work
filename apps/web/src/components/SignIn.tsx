/**
 * Two-step sign-in: ask for a code, then enter it.
 *
 * In local development the server hands the code back in the response rather
 * than emailing it, and this shows it — the difference between a usable dev
 * loop and one that needs a mail provider configured first.
 */

import { useState } from "react";
import { Button, Heading, Panel, Stack, SunDial, Text, TextField } from "@light/diurnal";
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
      {/* A dialog sits well above the desk, so it throws the longest shadow
          on the page. */}
      <Panel level={3} className="signin-card">
        <Stack gap={4}>
          <Stack gap={1}>
            <div className="signin-head">
              <Heading level={1}>Light Week</Heading>
              <SunDial />
            </div>
            <Text tone="soft">Tasks, with focus as a first-class citizen.</Text>
          </Stack>

          {stage === "email" ? (
            <form onSubmit={submitEmail}>
              <Stack gap={3}>
                <TextField
                  label="Email"
                  type="email"
                  value={email}
                  required
                  autoFocus
                  autoComplete="email"
                  placeholder="you@example.com"
                  hint="No password. We email a six-digit code that expires in fifteen minutes."
                  onChange={(event) => setEmail(event.target.value)}
                />
                <Button variant="primary" type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Send me a code"}
                </Button>
              </Stack>
            </form>
          ) : (
            <form onSubmit={submitCode}>
              <Stack gap={3}>
                <TextField
                  label="Six-digit code"
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
                <Button variant="primary" type="submit" disabled={busy || code.length !== 6}>
                  {busy ? "Checking…" : "Sign in"}
                </Button>
                {devCode !== null && (
                  <Panel inset className="dev-code">
                    <Text size="small" tone="soft">
                      Development mode — your code is <strong>{devCode}</strong>
                    </Text>
                  </Panel>
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStage("email");
                    setCode("");
                    setError(null);
                  }}
                >
                  Use a different address
                </Button>
              </Stack>
            </form>
          )}

          {error !== null && (
            <Text role="alert" tone="danger" size="small" as="p">
              {error}
            </Text>
          )}
        </Stack>
      </Panel>
    </main>
  );
}
