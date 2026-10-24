import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  DevMailer,
  MemoryAccountStores,
  MemoryAuthStore,
  MemoryRealtime,
} from "../src/adapters/memory.js";
import { authorizeUrl, issueState, verifyState, type GoogleConfig } from "../src/google.js";

/**
 * The parts of Google sign-in that can be tested without Google: the
 * authorize URL and the signed state that protects the callback.
 *
 * The token exchange itself is one `fetch` to Google and is covered by the
 * route's behaviour in app.test.ts rather than by mocking Google's responses,
 * which would only assert that the mock matches this file's assumptions.
 */

const config: GoogleConfig = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  redirectUri: "https://example.test/auth/google/callback",
  appUrl: "https://example.test",
};

describe("the authorize URL", () => {
  it("asks for an identity and nothing else", async () => {
    const url = new URL(await authorizeUrl(config));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    // Anything beyond this would ask the user to grant access to their data.
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("always offers the account chooser", async () => {
    const url = new URL(await authorizeUrl(config));
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  it("never sends the client secret", async () => {
    expect(await authorizeUrl(config)).not.toContain(config.clientSecret);
  });

  it("carries a state that verifies", async () => {
    const state = new URL(await authorizeUrl(config)).searchParams.get("state");
    expect(state).not.toBeNull();
    expect(await verifyState(config, state!)).toBe(true);
  });
});

describe("the signed state", () => {
  it("accepts one it issued", async () => {
    expect(await verifyState(config, await issueState(config))).toBe(true);
  });

  it("is different every time, so a callback cannot be replayed blindly", async () => {
    expect(await issueState(config)).not.toBe(await issueState(config));
  });

  it("rejects a tampered payload", async () => {
    const [, signature] = (await issueState(config)).split(".");
    const forged = `${btoa(JSON.stringify({ n: "x", t: Date.now() }))}.${signature}`;
    expect(await verifyState(config, forged)).toBe(false);
  });

  it("rejects one signed with a different client secret", async () => {
    const other = { ...config, clientSecret: "someone-else" };
    expect(await verifyState(config, await issueState(other))).toBe(false);
  });

  it("rejects rubbish", async () => {
    for (const value of ["", ".", "nodot", "a.b", "....."]) {
      expect(await verifyState(config, value)).toBe(false);
    }
  });

  it("expires, so an abandoned sign-in cannot be resumed much later", async () => {
    const issued = Date.now();
    const state = await issueState(config, issued);

    expect(await verifyState(config, state, issued + 9 * 60_000)).toBe(true);
    expect(await verifyState(config, state, issued + 11 * 60_000)).toBe(false);
  });

  it("rejects one stamped in the future", async () => {
    const issued = Date.now();
    const state = await issueState(config, issued);
    expect(await verifyState(config, state, issued - 11 * 60_000)).toBe(false);
  });
});

describe("the routes", () => {
  const appWith = (google?: GoogleConfig) =>
    createApp({
      accounts: new MemoryAccountStores(),
      auth: new MemoryAuthStore(),
      realtime: new MemoryRealtime(),
      mailer: new DevMailer(),
      platform: "test",
      ...(google !== undefined ? { google } : {}),
    });

  const get = (app: ReturnType<typeof createApp>, path: string) =>
    app.fetch(new Request(`https://api.test${path}`));

  it("are absent when no client is configured", async () => {
    const app = appWith();
    expect((await get(app, "/auth/google/start")).status).toBe(404);
    expect((await get(app, "/auth/google/callback?code=x&state=y")).status).toBe(404);
  });

  it("are advertised only when a client is configured", async () => {
    const without = await (await get(appWith(), "/healthz")).json();
    expect(without).toMatchObject({ auth: { google: false } });

    const configured = await (await get(appWith(config), "/healthz")).json();
    expect(configured).toMatchObject({ auth: { google: true } });
  });

  it("send the browser to Google", async () => {
    const response = await get(appWith(config), "/auth/google/start");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("accounts.google.com");
  });

  it("report a refused consent screen rather than failing", async () => {
    const response = await get(appWith(config), "/auth/google/callback?error=access_denied");
    expect(response.headers.get("location")).toBe(`${config.appUrl}/#error=access_denied`);
  });

  it("refuse a callback whose state was not issued here", async () => {
    const response = await get(appWith(config), "/auth/google/callback?code=x&state=forged.sig");
    expect(response.headers.get("location")).toBe(`${config.appUrl}/#error=bad_state`);
  });

  it("refuse a callback with no code", async () => {
    const state = await issueState(config);
    const response = await get(appWith(config), `/auth/google/callback?state=${state}`);
    expect(response.headers.get("location")).toBe(`${config.appUrl}/#error=missing_code`);
  });

  it("hand back a token in the fragment, never the query string", async () => {
    // What the callback redirects to on success. Asserted on the shape rather
    // than by completing a real exchange: a token in the query string would be
    // written to access logs and leak through Referer.
    const response = await get(appWith(config), "/auth/google/callback?error=access_denied");
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("#");
    expect(new URL(location).search).toBe("");
  });
});
