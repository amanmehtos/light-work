/**
 * Secrets and vars.
 *
 * Bindings are not declared here — `wrangler types` generates those from
 * wrangler.jsonc, and regenerating is what keeps them in step with the config.
 * Only the values set as secrets or vars need declaring, and they go into both
 * the global `Env` the Worker uses and the `Cloudflare.Env` that
 * `cloudflare:test` reads, which are siblings rather than one extending
 * the other.
 */

interface LightWeekSecrets {
  /** "1" in local development, which enables reading sign-in codes back. */
  DEV_LOGIN?: string;
  /** Resend API key. Absent means codes are not emailed. */
  RESEND_API_KEY?: string;
  /** From address for sign-in emails. */
  MAIL_FROM?: string;
  /** Public base URL, used in emails and OAuth metadata. */
  PUBLIC_URL?: string;
  /** Google OAuth client. Both absent means Google sign-in is not offered. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Overrides the callback URL sent to Google. Needed only where the browser
   * reaches the Worker by a different path than the Worker sees — behind the
   * dev server's `/api` proxy, for instance.
   */
  GOOGLE_REDIRECT_URI?: string;
}

declare global {
  interface Env extends LightWeekSecrets {}

  namespace Cloudflare {
    interface Env extends LightWeekSecrets {}
  }
}

export {};
