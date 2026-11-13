/**
 * What a tool needs to do its job.
 *
 * Tools are written against this rather than against a transport, so the same
 * set runs over stdio for a local agent and over HTTP for a hosted one. `flush`
 * is what makes a tool's writes durable; a tool that only reads never calls it.
 */

import type { LightStore, Operations } from "@light/client-sdk";
import type { Op } from "@light/core";

export interface ToolContext {
  store: LightStore;
  ops: Operations;
  /** Sends staged ops to the server. Resolves once they are accepted. */
  flush: (ops: Op[]) => Promise<void>;
  /** Today, as `YYYY-MM-DD`, in the user's timezone. */
  today: () => string;
  /**
   * The IANA zone `today` is read in, and so the zone a time of day in a
   * task's text means. Optional so a caller that builds a context by hand does
   * not have to know about it; the tools that need one fall back to UTC, which
   * is what `Session.today` does when it has no zone either.
   */
  timezone?: string;
  /** The wall-clock time now, `HH:MM`, in that zone. Optional like `timezone`. */
  now?: () => string;
}
