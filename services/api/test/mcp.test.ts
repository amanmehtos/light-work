import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Exercises the hosted MCP endpoint over real HTTP inside workerd, speaking
 * JSON-RPC as a client would. This is the only way to catch the things that
 * only break in the Workers runtime — AJV's code generation, for one.
 */

let seq = 0;

async function signIn(): Promise<string> {
  const email = `mcp${seq++}-${Date.now()}@example.com`;
  const requested = await SELF.fetch("https://api.test/auth/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const { devCode } = await requested.json<{ devCode: string }>();
  const verified = await SELF.fetch("https://api.test/auth/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code: devCode }),
  });
  return (await verified.json<{ token: string }>()).token;
}

let rpcId = 0;

async function rpc(token: string, method: string, params?: unknown) {
  const response = await SELF.fetch("https://api.test/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // The spec requires a client to accept both, even in JSON-response mode.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as any),
  };
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "vitest", version: "0" },
};

describe("the MCP endpoint", () => {
  it("refuses an unauthenticated request", async () => {
    const response = await SELF.fetch("https://api.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INITIALIZE }),
    });
    expect(response.status).toBe(401);
  });

  it("initializes and names the server", async () => {
    const token = await signIn();
    const { status, body } = await rpc(token, "initialize", INITIALIZE);
    expect(status).toBe(200);
    expect(body.result.serverInfo.name).toBe("light-week");
    expect(body.result.instructions).toContain("1 being urgent");
  });

  it("lists its tools with usable schemas", async () => {
    const token = await signIn();
    await rpc(token, "initialize", INITIALIZE);
    const { body } = await rpc(token, "tools/list");

    const names = body.result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(names).toContain("get_week_plan");
    expect(names).toContain("create_task");
    expect(names).toContain("get_focus_stats");
    expect(names).toContain("reorder_tasks");

    const createTask = body.result.tools.find((t: { name: string }) => t.name === "create_task");
    // A real JSON Schema, which is what proves schema generation survived the
    // Workers runtime rather than throwing on AJV's code generation.
    expect(createTask.inputSchema.type).toBe("object");
    expect(Object.keys(createTask.inputSchema.properties)).toContain("projectId");
    expect(createTask.inputSchema.required).toContain("content");

    const listTasks = body.result.tools.find((t: { name: string }) => t.name === "list_tasks");
    expect(listTasks.annotations.readOnlyHint).toBe(true);
    expect(createTask.annotations.readOnlyHint).toBe(false);
  });

  it("runs a round trip: create a project, add a task, read it back", async () => {
    const token = await signIn();
    await rpc(token, "initialize", INITIALIZE);

    const created = await rpc(token, "tools/call", {
      name: "create_project",
      arguments: { name: "Develop Light Week" },
    });
    expect(created.body.result.isError).toBeUndefined();
    const projectId = created.body.result.structuredContent.project.id;

    const task = await rpc(token, "tools/call", {
      name: "create_task",
      arguments: {
        projectId,
        content: "Ship the sync engine",
        priority: 1,
        due: { date: "2026-10-27" },
        deadlineDate: "2026-11-15",
        labels: ["focus"],
      },
    });
    expect(task.body.result.structuredContent.task.content).toBe("Ship the sync engine");

    // A separate request, so this proves the write reached the Durable Object
    // and was not just held in the previous request's in-memory store.
    const listed = await rpc(token, "tools/call", {
      name: "list_tasks",
      arguments: { projectId },
    });
    const tasks = listed.body.result.structuredContent.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].content).toBe("Ship the sync engine");
    expect(tasks[0].priorityLabel).toBe("p1");
    expect(tasks[0].deadline).toBe("2026-11-15");
    expect(tasks[0].labels).toEqual(["focus"]);
  });

  it("validates arguments and reports a bad call rather than crashing", async () => {
    const token = await signIn();
    await rpc(token, "initialize", INITIALIZE);
    const response = await rpc(token, "tools/call", {
      name: "create_task",
      arguments: { projectId: "whatever" },
    });
    // Either a JSON-RPC error or a tool error is acceptable; a 500 is not.
    const failed =
      response.body.error !== undefined || response.body.result?.isError === true;
    expect(failed).toBe(true);
  });

  it("keeps one account's tasks out of another's", async () => {
    const first = await signIn();
    await rpc(first, "initialize", INITIALIZE);
    const project = await rpc(first, "tools/call", {
      name: "create_project",
      arguments: { name: "Private" },
    });
    expect(project.body.result.structuredContent.project.id).toBeDefined();

    const second = await signIn();
    await rpc(second, "initialize", INITIALIZE);
    const listed = await rpc(second, "tools/call", { name: "list_projects", arguments: {} });
    expect(listed.body.result.structuredContent.projects).toHaveLength(0);
  });

  it("surfaces focus time through the same endpoint", async () => {
    const token = await signIn();
    await rpc(token, "initialize", INITIALIZE);

    const project = (
      await rpc(token, "tools/call", { name: "create_project", arguments: { name: "Focus" } })
    ).body.result.structuredContent.project;
    const task = (
      await rpc(token, "tools/call", {
        name: "create_task",
        arguments: { projectId: project.id, content: "deep work" },
      })
    ).body.result.structuredContent.task;

    await rpc(token, "tools/call", {
      name: "log_focus_session",
      arguments: {
        taskId: task.id,
        startedAt: "2026-10-24T09:00:00Z",
        plannedMinutes: 50,
        focusedMinutes: 45,
      },
    });

    const stats = await rpc(token, "tools/call", {
      name: "get_focus_stats",
      arguments: { taskId: task.id },
    });
    expect(stats.body.result.structuredContent.focused).toBe("45m");
  });
});
