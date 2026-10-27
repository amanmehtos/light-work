/**
 * Sign-in and the stored session.
 *
 * The token lives in localStorage. That is a deliberate trade: it survives a
 * reload, which a local-first app needs, at the cost of being reachable by
 * script on this origin. The alternative — an httpOnly cookie — cannot be read
 * by the WebSocket URL builder or sent by the native clients, so the protocol
 * would need two auth mechanisms instead of one.
 */

const TOKEN_KEY = "light-week.token";
const USER_KEY = "light-week.user";
const METHODS_KEY = "light-week.methods";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface StoredSession {
  token: string;
  user: User;
}

/** In development the app is served by Vite and proxies /api to the Worker. */
export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private browsing, or site data blocked.
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the session simply will not survive a reload.
  }
}

export function loadSession(): StoredSession | null {
  const token = readStorage(TOKEN_KEY);
  const rawUser = readStorage(USER_KEY);
  if (token === null || rawUser === null) return null;
  try {
    return { token, user: JSON.parse(rawUser) as User };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession | null): void {
  if (session === null) {
    writeStorage(TOKEN_KEY, null);
    writeStorage(USER_KEY, null);
    return;
  }
  writeStorage(TOKEN_KEY, session.token);
  writeStorage(USER_KEY, JSON.stringify(session.user));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? describeError(data.error) : "Something went wrong.");
  }
  return data as T;
}

/** Turns the API's error codes into something worth reading. */
function describeError(code: string): string {
  switch (code) {
    case "no_code":
      return "No sign-in code was requested for that address. Ask for a new one.";
    case "expired":
      return "That code has expired. Ask for a new one.";
    case "too_many_attempts":
      return "Too many incorrect attempts. Ask for a new code.";
    case "mismatch":
      return "That code is not right.";
    case "access_denied":
      return "Google sign-in was cancelled.";
    case "bad_state":
      return "That sign-in attempt expired. Try again.";
    case "missing_code":
    case "google_sign_in_failed":
      return "Google sign-in did not complete. Try again.";
    default:
      return code;
  }
}

export async function requestCode(email: string): Promise<{ devCode?: string }> {
  return post<{ devCode?: string }>("/auth/request-code", { email });
}

export async function verifyCode(email: string, code: string): Promise<StoredSession> {
  const result = await post<{ token: string; user: User }>("/auth/verify-code", {
    email,
    code,
    device: navigator.userAgent,
  });
  const session = { token: result.token, user: result.user };
  saveSession(session);
  return session;
}

/** Where the browser goes to start Google sign-in. A full navigation, not fetch. */
export const GOOGLE_START_URL = `${API_BASE}/auth/google/start`;

/**
 * What the last visit found, so the card can paint the right buttons
 * immediately.
 *
 * Which methods exist is a property of the deployment, not of the visitor, and
 * it changes about as often as a deploy — but it can only be learnt by asking
 * the server. Rendering `false` until the answer arrives makes the Google
 * button and its divider drop in afterwards and shove the form down. Starting
 * from the last answer is right on every visit but the first, and the fetch
 * still corrects it.
 */
export function rememberedMethods(): { google: boolean } {
  return { google: readStorage(METHODS_KEY) === "google" };
}

/* ------------------------------------------------------------------ */
/* Granting an agent access                                           */
/* ------------------------------------------------------------------ */

/**
 * The parameters the authorization endpoint hands to the consent screen.
 *
 * They arrive through the browser and are therefore not trusted: the server
 * re-checks every one of them against the registered client when the grant is
 * made. What they are good for here is telling the person what they are about
 * to allow.
 */
export interface ConsentRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state: string | null;
}

export function readConsentRequest(search: string): ConsentRequest | null {
  const params = new URLSearchParams(search);
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const codeChallenge = params.get("code_challenge");
  const scope = params.get("scope");
  if (clientId === null || redirectUri === null || codeChallenge === null || scope === null) {
    return null;
  }
  return {
    clientId,
    clientName: params.get("client_name") ?? "An unnamed client",
    redirectUri,
    codeChallenge,
    scope,
    resource: params.get("resource") ?? "",
    state: params.get("state"),
  };
}

/**
 * Grants or refuses, and returns where to send the browser next.
 *
 * Refusing still produces a redirect: the client is told `access_denied`
 * rather than left waiting on a window that never comes back.
 */
export async function decideConsent(
  token: string,
  request: ConsentRequest,
  approve: boolean,
): Promise<string> {
  const response = await fetch(`${API_BASE}/oauth/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      approve,
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      code_challenge: request.codeChallenge,
      scope: request.scope,
      resource: request.resource,
      state: request.state,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    redirect?: string;
    error?: string;
  };
  if (!response.ok || typeof body.redirect !== "string") {
    throw new Error(body.error ?? "Could not complete the request.");
  }
  return body.redirect;
}

/** Whether this deployment has a Google OAuth client configured. */
export async function signInMethods(): Promise<{ google: boolean }> {
  try {
    const response = await fetch(`${API_BASE}/healthz`);
    if (!response.ok) return { google: false };
    const info = (await response.json()) as { auth?: { google?: boolean } };
    const google = info.auth?.google === true;
    writeStorage(METHODS_KEY, google ? "google" : null);
    return { google };
  } catch {
    // Offline, or the API is down. Keep whatever the last visit found: the
    // deployment has not changed just because this request failed, and the
    // email form still renders and will report its own failure, which is a
    // better first impression than an error page before anything was tried.
    return rememberedMethods();
  }
}

/**
 * What the Google callback left in the fragment, taken once at module load.
 *
 * Reading it clears it, so it is a one-shot resource, and StrictMode mounts
 * every effect twice in development: consuming it inside the effect means the
 * first pass takes the token and the second finds an empty fragment, and
 * whichever of the two React keeps is the one holding nothing. Taking it here,
 * before anything renders, makes the effect idempotent and the two
 * environments behave the same.
 */
const redirect: { token: string | null; error: string | null } | null = takeRedirectFragment();

function takeRedirectFragment(): { token: string | null; error: string | null } | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "") return null;

  const params = new URLSearchParams(hash);
  const token = params.get("token");
  const error = params.get("error");
  if (token === null && error === null) return null;

  // Cleared whatever it held, so a reload cannot replay a stale token and the
  // address bar is not left carrying one.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return { token, error };
}

/** Whether this load is a return trip from the identity provider. */
export function hasRedirectSignIn(): boolean {
  return redirect !== null;
}

/** Completes a Google sign-in from what the callback redirected with. */
export async function completeRedirectSignIn(): Promise<StoredSession | null> {
  if (redirect === null) return null;
  if (redirect.token === null) throw new Error(describeError(redirect.error ?? "unknown"));

  // The callback hands over a token but not the user; fetch it so the stored
  // session has the same shape the code path produces.
  const response = await fetch(`${API_BASE}/account/me`, {
    headers: { Authorization: `Bearer ${redirect.token}` },
  });
  if (!response.ok) throw new Error("That sign-in did not complete. Try again.");

  const session = { token: redirect.token, user: (await response.json()) as User };
  saveSession(session);
  return session;
}

export async function logout(token: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/account/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Signing out locally matters more than telling the server about it.
  }
  saveSession(null);
}
