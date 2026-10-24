/**
 * The built-in MCP endpoint, over whatever account store is configured.
 *
 * Stateless: each request builds a session, catches it up from the account,
 * runs the call, and discards everything. There is no MCP session to keep warm,
 * which costs a snapshot read per request but means the endpoint holds no state
 * and scales with the platform rather than against it.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/index.js";
import {
  Session,
  createServer,
  type PullResult,
  type PushResult,
  type SnapshotResult,
  type SyncTransport,
} from "@light/mcp";
import type { Cursor, Op } from "@light/core";
import type { AccountStore } from "./ports.js";

/** Reaches the account directly, with no HTTP hop back into our own server. */
class AccountStoreTransport implements SyncTransport {
  constructor(private readonly store: AccountStore) {}

  async snapshot(): Promise<SnapshotResult> {
    return (await this.store.snapshot()) as unknown as SnapshotResult;
  }

  async pull(since: Cursor): Promise<PullResult> {
    return (await this.store.pull(since)) as unknown as PullResult;
  }

  async push(since: Cursor, ops: Op[]): Promise<PushResult> {
    return (await this.store.push(since, ops)) as unknown as PushResult;
  }
}

export interface McpOptions {
  store: AccountStore;
  /** The user's timezone, so "today" means their today. */
  timezone?: string;
  /**
   * Which JSON Schema validator the MCP SDK should use. Workers must pass the
   * cfworker one: the SDK's default compiles schemas with `new Function`, which
   * the runtime forbids. Node can leave this unset and get the faster default.
   */
  jsonSchemaValidator?: jsonSchemaValidator;
}

export async function handleMcpRequest(
  request: Request,
  options: McpOptions,
): Promise<Response> {
  const session = new Session({
    transport: new AccountStoreTransport(options.store),
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
  });
  await session.refresh();

  const server = createServer(session.context, {
    ...(options.jsonSchemaValidator !== undefined
      ? { jsonSchemaValidator: options.jsonSchemaValidator }
      : {}),
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id, and a plain JSON response rather than SSE,
    // which is all these tools need.
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => {});
  }
}
