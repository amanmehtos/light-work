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
