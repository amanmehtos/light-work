/**
 * Remote MCP, hosted in the Worker.
 *
 * Stateless: each request builds a session, catches it up from the account's
 * Durable Object, runs the call, and discards everything. There is no MCP
 * session to keep warm, which costs a snapshot read per request but means the
 * endpoint holds no state and scales with the platform rather than against it.
 *
 * The session reaches the account through the Durable Object directly rather
 * than over HTTP, so the Worker never makes a request back to itself.
 */

import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Session, createServer, type PullResult, type PushResult, type SnapshotResult, type SyncTransport } from "@light/mcp";
import type { Cursor, Op } from "@light/core";
import type { Account } from "./account.js";

type AccountStub = DurableObjectStub<Account>;

/** Reaches the account through its Durable Object rather than over HTTP. */
class DurableObjectTransport implements SyncTransport {
  constructor(private readonly stub: AccountStub) {}

  async snapshot(): Promise<SnapshotResult> {
    return JSON.parse(await this.stub.snapshotJson()) as SnapshotResult;
  }

  async pull(since: Cursor): Promise<PullResult> {
    return JSON.parse(await this.stub.pullJson(since)) as PullResult;
  }

  async push(since: Cursor, ops: Op[]): Promise<PushResult> {
    return JSON.parse(await this.stub.pushJson(since, JSON.stringify(ops))) as PushResult;
  }
}

export interface McpRequestOptions {
  stub: AccountStub;
  /** The user's timezone, so "today" means their today. */
  timezone?: string;
}

export async function handleMcpRequest(
  request: Request,
  options: McpRequestOptions,
): Promise<Response> {
  const session = new Session({
    transport: new DurableObjectTransport(options.stub),
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
  });
  await session.refresh();

  const server = createServer(session.context, {
    // AJV compiles schemas with `new Function`, which Workers forbid.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode: no session id, and a plain JSON response rather than SSE,
    // which is all these tools need and keeps the Worker's job to one request.
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Closing the server releases the transport; the next request builds its own.
    await server.close().catch(() => {});
  }
}
