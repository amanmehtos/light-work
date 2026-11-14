import { beforeEach, describe, expect, it } from "vitest";
import { Operations } from "../src/operations.js";
import { searchTasks } from "../src/search.js";
import { LightStore } from "../src/store.js";

let store: LightStore;
let ops: Operations;
let projectId: string;

beforeEach(() => {
  store = new LightStore("test-device");
  ops = new Operations(store);
  projectId = ops.createProject({ name: "Light Week" }).result.id;
});

function add(content: string, extra: { description?: string; labelNames?: string[] } = {}) {
  return ops.createTask({ projectId, content, ...extra }).result;
}

const titles = (query: string) => searchTasks(store, query).map((task) => task.content);

describe("searchTasks", () => {
  it("ranks a title hit above a label hit above a description hit, whatever the list order", () => {
    // Created in the opposite order to the ranking, so a pass cannot be an
    // accident of the tasks' own order.
    add("note only", { description: "send the invoice on Friday" });
    add("tagged", { labelNames: ["invoice"] });
    add("Invoice the client");

    expect(titles("invoice")).toEqual(["Invoice the client", "tagged", "note only"]);
  });

  it("finds a task by its description alone", () => {
    add("call the plumber", { description: "ask about the boiler" });
    add("unrelated");
    expect(titles("boiler")).toEqual(["call the plumber"]);
  });

  it("finds a task by the name of one of its labels, and not by a label it lacks", () => {
    add("with label", { labelNames: ["deep-work"] });
    add("without");
    expect(titles("deep")).toEqual(["with label"]);
  });

  it("is case-insensitive in the query, the title, the notes and the label", () => {
    add("Ship The PITCH");
    add("b", { description: "NOTES about Pitch" });
    add("c", { labelNames: ["Pitch"] });
    expect(titles("pItCh")).toHaveLength(3);
  });

  it("matches a phrase as written, not word by word", () => {
    add("quick jerky recipe");
    add("jerky, but quick");
    expect(titles("quick jerky")).toEqual(["quick jerky recipe"]);
  });

  it("ignores spaces around the query, so a half-typed phrase still matches", () => {
    add("quick jerky recipe");
    expect(titles("  quick ")).toEqual(["quick jerky recipe"]);
  });

  it("matches nothing for an empty or blank query, rather than everything", () => {
    add("anything");
    expect(searchTasks(store, "")).toEqual([]);
    expect(searchTasks(store, "   ")).toEqual([]);
  });

  it("keeps the tasks' own order within a rank", () => {
    add("pitch one");
    add("pitch two");
    add("pitch three");
    expect(titles("pitch")).toEqual(["pitch one", "pitch two", "pitch three"]);
  });

  it("leaves completed tasks in, because filtering them is the caller's decision", () => {
    const done = add("finished pitch");
    ops.completeTask(done.id, "2026-10-26");
    expect(titles("pitch")).toEqual(["finished pitch"]);
  });
});

describe("comments", () => {
  it("are not searched: a hit the row cannot show is a result nobody can explain", () => {
    // The decision is recorded here so that adding comments to `searchTasks`
    // is a deliberate change to this file and not a drive-by. A row shows the
    // title, the labels and the notes — everything search matches on — but a
    // comment is read only inside the editor sheet, so a task listed "for" a
    // word that appears nowhere on its row would look like a wrong answer.
    const task = add("call the plumber");
    ops.addComment(task.id, "ask about the boiler");
    expect(titles("boiler")).toEqual([]);
  });
});
