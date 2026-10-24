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
}

declare global {
  interface Env extends LightWeekSecrets {}

  namespace Cloudflare {
    interface Env extends LightWeekSecrets {}
  }
}

export {};
