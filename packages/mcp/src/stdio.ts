#!/usr/bin/env node
/**
 * Light Week MCP over stdio, for a local agent.
 *
 *   LIGHT_WEEK_URL=https://api.lightweek.app \
 *   LIGHT_WEEK_TOKEN=... \
 *   light-week-mcp
 *
 * In Claude Code or Claude Desktop, register it as a command-type server with
 * those two variables set. The token is the same session token the apps use,
 * read from localStorage under `light-week.token` — there is no screen for
 * minting a separate one yet. An agent that can do OAuth should use the hosted
 * transport instead, which grants a scoped token rather than the whole account.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { HttpTransport, Session } from "./session.js";

async function main(): Promise<void> {
  const baseUrl = process.env.LIGHT_WEEK_URL;
  const token = process.env.LIGHT_WEEK_TOKEN;

  if (baseUrl === undefined || token === undefined) {
    // stderr, because stdout is the protocol channel.
    process.stderr.write(
      "LIGHT_WEEK_URL and LIGHT_WEEK_TOKEN must both be set.\n" +
        "LIGHT_WEEK_URL is your server, e.g. https://api.lightweek.app\n",
    );
    process.exit(2);
  }

  const session = new Session({
    transport: new HttpTransport({ baseUrl, token }),
    ...(process.env.LIGHT_WEEK_TZ !== undefined ? { timezone: process.env.LIGHT_WEEK_TZ } : {}),
  });

  // Fail at startup rather than on the first tool call, so a bad token shows up
  // as the server refusing to start instead of as a confusing tool error.
  await session.refresh();

  const context = session.context;
  const server = createServer({
    ...context,
    // Catch up before every call: the account may have changed on another
    // device since the last one.
    flush: context.flush,
  });

  // Wrap the store access so each tool invocation sees fresh state.
  const originalConnect = server.connect.bind(server);
  await originalConnect(new StdioServerTransport());
  process.stderr.write(`light-week MCP ready (${session.store.count("task")} tasks loaded)\n`);

  const refreshEvery = 30_000;
  setInterval(() => {
    void session.refresh().catch((error: unknown) => {
      process.stderr.write(
        `background refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }, refreshEvery).unref();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
