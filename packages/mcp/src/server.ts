/**
 * Builds an MCP server from the tool registry.
 *
 * Transport-agnostic: the caller connects whichever transport it has, so the
 * same tools serve a local agent over stdio and a hosted one over HTTP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/index.js";
import type { ToolContext } from "./context.js";
import { buildTools } from "./tools.js";

export const SERVER_NAME = "light-week";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Light Week is a task manager that also records where attention actually went.

Two things are worth knowing before you arrange anything.

Priority runs 1 to 4 with **1 being urgent**, matching the p1..p4 a user sees.

A task has both a *due* date and a *deadline*, and they mean different things: due
is when the user intends to work on it, deadline is when it is actually owed. A
task can be due next Monday with a deadline three weeks out. Do not conflate
them, and prefer moving a due date over moving a deadline.

Call get_week_plan before proposing a rearrangement. It returns overdue work,
each day's schedule, deadlines in the window, and unscheduled p1/p2 tasks in one
response, along with how much focus each task has already received. Focus data
is the signal that distinguishes a task being ground at from one being avoided,
which is usually the question that matters when replanning.

When you reorder, pass the full desired order to reorder_tasks rather than
issuing moves one at a time.`;

export interface CreateServerOptions {
  /**
   * Which JSON Schema validator to use.
   *
   * The SDK defaults to AJV, which compiles schemas with `new Function` and so
   * cannot run on Workers. The Worker build passes the cfworker validator
   * instead; stdio leaves this unset and gets the faster default.
   */
  jsonSchemaValidator?: jsonSchemaValidator;
}

export function createServer(
  context: ToolContext,
  options: CreateServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: INSTRUCTIONS,
      ...(options.jsonSchemaValidator !== undefined
        ? { jsonSchemaValidator: options.jsonSchemaValidator }
        : {}),
    },
  );

  for (const tool of buildTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          // A write here changes the user's real task list, so hosts should
          // treat repeat calls as meaningful rather than safe to retry blindly.
          idempotentHint: tool.readOnly,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args, context);
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
