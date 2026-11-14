import { beforeEach, describe, expect, it } from "vitest";
import type { Comment, JsonObject } from "@light/core";
import { Operations } from "../src/operations.js";
import { commentsOnTask, postedTime } from "../src/comments.js";
import { LightStore } from "../src/store.js";

let store: LightStore;
let ops: Operations;

beforeEach(() => {
  store = new LightStore("test-device");
  ops = new Operations(store);
});

function task(content = "Ready the deck") {
  const project = ops.createProject({ name: "Develop KYC" }).result;
  return ops.createTask({ projectId: project.id, content }).result;
}

/**
 * A comment the way the Todoist importer writes one — every field, with the
 * `postedById` a Todoist user id and nothing a client here would have put
 * there — loaded as a snapshot row, which is how it reaches a client.
 */
function imported(over: Partial<Comment> & { id: string }): Comment {
  return {
    taskId: null,
    projectId: null,
    content: "",
    attachment: null,
    postedById: "todoist-uid-1234",
    postedAt: "2024-03-01T09:30:00.000000Z",
    ...over,
  };
}

function load(...comments: Comment[]) {
  const entities = {
    project: store.all("project") as unknown as JsonObject[],
    task: store.all("task") as unknown as JsonObject[],
    comment: comments as unknown as JsonObject[],
  };
  store.loadSnapshot(entities);
}

describe("addComment", () => {
  it("writes a whole row, null where there is nothing", () => {
    const t = task();
    const staged = ops.addComment(t.id, "  Lead with economics.  ", new Date("2026-11-14T10:00:00.000Z"));

    const comment = staged.result!;
    expect(comment).toEqual({
      id: comment.id,
      taskId: t.id,
      projectId: null,
      content: "Lead with economics.",
      attachment: null,
      postedById: null,
      postedAt: "2026-11-14T10:00:00.000Z",
    });
    // One op, and it names every field: a reader that sees a key missing
    // cannot tell "not set" from "not sent".
    expect(staged.ops).toHaveLength(1);
    expect(Object.keys(staged.ops[0]!.fields as object).sort()).toEqual(
      ["attachment", "content", "id", "postedAt", "postedById", "projectId", "taskId"],
    );
    expect(store.get("comment", comment.id)).toEqual(comment);
  });

  it("keeps the line breaks inside the text", () => {
    const t = task();
    expect(ops.addComment(t.id, "one\n\ntwo").result!.content).toBe("one\n\ntwo");
  });

  it("stages nothing for blank text or a task that is not there", () => {
    const t = task();
    expect(ops.addComment(t.id, "   \n ")).toEqual({ result: null, ops: [] });
    expect(ops.addComment("nope", "hello")).toEqual({ result: null, ops: [] });
    expect(store.count("comment")).toBe(0);
  });
});

describe("deleteComment", () => {
  it("tombstones the row, and says so when there was none", () => {
    const t = task();
    const comment = ops.addComment(t.id, "x").result!;
    expect(ops.deleteComment(comment.id).result.deleted).toBe(true);
    expect(store.get("comment", comment.id)).toBeNull();
    expect(ops.deleteComment(comment.id)).toEqual({ result: { deleted: false }, ops: [] });
  });
});

describe("commentsOnTask", () => {
  it("is oldest first, and breaks a tie by id so the order never shuffles", () => {
    const t = task();
    const other = task("another");
    load(
      imported({ id: "c", taskId: t.id, content: "third", postedAt: "2024-03-03T00:00:00.000Z" }),
      imported({ id: "b", taskId: t.id, content: "tied-b", postedAt: "2024-03-02T00:00:00.000Z" }),
      imported({ id: "a", taskId: t.id, content: "tied-a", postedAt: "2024-03-02T00:00:00.000Z" }),
      imported({ id: "z", taskId: other.id, content: "elsewhere" }),
    );
    expect(commentsOnTask(store, t.id).map((c) => c.content)).toEqual(["tied-a", "tied-b", "third"]);
  });

  it("leaves out a comment that hangs off a project, which has no sheet to be read on", () => {
    const t = task();
    load(
      imported({ id: "p", projectId: t.projectId, content: "project-level" }),
      imported({ id: "t", taskId: t.id, content: "task-level" }),
    );
    expect(commentsOnTask(store, t.id).map((c) => c.content)).toEqual(["task-level"]);
  });

  it("reads a comment an import wrote, whole, with fields this client never would", () => {
    const t = task();
    load(
      imported({
        id: "c1",
        taskId: t.id,
        content: "Deck v3",
        attachment: { fileName: "deck.pdf", fileType: "application/pdf", fileUrl: "https://example.com/deck.pdf", fileSize: 2048 },
      }),
    );
    const [comment] = commentsOnTask(store, t.id);
    expect(comment!.content).toBe("Deck v3");
    expect(comment!.attachment?.fileName).toBe("deck.pdf");
    expect(comment!.postedById).toBe("todoist-uid-1234");
  });
});

describe("postedTime", () => {
  it("reads a real date, microseconds and all", () => {
    expect(postedTime({ postedAt: "2024-03-01T09:30:00.000000Z" })).toBe(Date.parse("2024-03-01T09:30:00Z"));
  });

  it("calls the importer's epoch placeholder, and garbage, undated", () => {
    expect(postedTime({ postedAt: new Date(0).toISOString() })).toBeNull();
    expect(postedTime({ postedAt: "" })).toBeNull();
    expect(postedTime({ postedAt: "last tuesday" })).toBeNull();
  });
});

describe("what deleting takes with it", () => {
  it("deleting a task deletes its comments, and its subtasks' — and nobody else's", () => {
    const t = task();
    const sub = ops.createTask({ projectId: t.projectId, content: "sub", parentId: t.id }).result;
    const stays = ops.createTask({ projectId: t.projectId, content: "stays" }).result;
    ops.addComment(t.id, "on the parent");
    ops.addComment(sub.id, "on the subtask");
    const kept = ops.addComment(stays.id, "on the survivor").result!;

    const deletion = ops.deleteTask(t.id);
    expect(deletion.ops.filter((op) => op.kind === "comment" && op.type === "delete")).toHaveLength(2);
    expect(store.all("comment")).toEqual([kept]);
  });

  it("deleting a project deletes the comments on its tasks and on the project itself", () => {
    const t = task();
    const other = task("elsewhere");
    ops.addComment(t.id, "on a task");
    ops.addComment(other.id, "elsewhere");
    store.mutate("comment", "on-project", imported({ id: "on-project", projectId: t.projectId }));

    ops.deleteProject(t.projectId);
    expect(store.all("comment").map((c) => c.content)).toEqual(["elsewhere"]);
  });
});
