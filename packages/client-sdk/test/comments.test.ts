import { beforeEach, describe, expect, it } from "vitest";
import type { Comment, JsonObject } from "@light/core";
import { Operations } from "../src/operations.js";
import { commentsOnTask, postedTime, commentsOnProject } from "../src/comments.js";
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

/**
 * Notes left on a project rather than on a task.
 *
 * Todoist allows them and the importer has always kept them — `taskId` null,
 * `projectId` set — into a field nothing read. These are the tests that say
 * the two threads can never show each other's rows.
 */
describe("commentsOnProject", () => {
  function seed() {
    const store = new LightStore("test-device");
    const ops = new Operations(store);
    const project = ops.createProject({ name: "Agoda" }).result;
    const task = ops.createTask({ projectId: project.id, content: "Ready the deck" }).result;
    return { store, ops, project, task };
  }

  it("reads a note the importer left on the project", () => {
    const { store, project } = seed();
    // The imported shape: no taskId, a projectId, a real timestamp.
    store.mutate("comment", "imported", {
      id: "imported",
      taskId: null,
      projectId: project.id,
      content: "Rates confirmed for Q1",
      attachment: null,
      postedById: "4213",
      postedAt: "2026-02-04T11:12:13.456789Z",
    });

    expect(commentsOnProject(store, project.id).map((c) => c.content)).toEqual([
      "Rates confirmed for Q1",
    ]);
  });

  it("never shows a task's comment in the project thread", () => {
    const { store, ops, project, task } = seed();
    ops.addComment(task.id, "On the task");
    ops.addProjectComment(project.id, "On the project");

    expect(commentsOnProject(store, project.id).map((c) => c.content)).toEqual(["On the project"]);
    expect(commentsOnTask(store, task.id).map((c) => c.content)).toEqual(["On the task"]);
  });

  it("writes a project comment with no taskId, which is what keeps them apart", () => {
    const { ops, project } = seed();
    const written = ops.addProjectComment(project.id, "  Spacing trimmed  ").result;

    expect(written?.taskId).toBeNull();
    expect(written?.projectId).toBe(project.id);
    expect(written?.content).toBe("Spacing trimmed");
  });

  it("refuses a blank one, and one on a project that is not there", () => {
    const { ops, project } = seed();
    expect(ops.addProjectComment(project.id, "   ").ops).toEqual([]);
    expect(ops.addProjectComment("nope", "Hello").ops).toEqual([]);
  });

  it("orders a project thread oldest first, like a task's", () => {
    const { store, project } = seed();
    for (const [id, postedAt, content] of [
      ["b", "2026-02-05T09:00:00.000Z", "Second"],
      ["a", "2026-02-04T09:00:00.000Z", "First"],
    ] as const) {
      store.mutate("comment", id, {
        id, taskId: null, projectId: project.id, content,
        attachment: null, postedById: null, postedAt,
      });
    }
    expect(commentsOnProject(store, project.id).map((c) => c.content)).toEqual(["First", "Second"]);
  });
});
