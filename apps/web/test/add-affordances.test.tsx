import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LightStore, Operations } from "@light/client-sdk";
import { Sidebar } from "../src/components/Sidebar.js";
import { TaskRow } from "../src/components/TaskRow.js";

/**
 * Where "add a project" and "add a subtask" are, and where they are not.
 *
 * Markup-level, because the constraints are about what is on the page: the nav
 * is eight entries and an "add" beside the Projects heading must not be a ninth,
 * and a list that does not nest, offers no subtask button.
 */

let store: LightStore;
let ops: Operations;

beforeEach(() => {
  store = new LightStore("test-device");
  ops = new Operations(store);
});

function sidebar() {
  return renderToStaticMarkup(
    <Sidebar
      store={store}
      view={{ kind: "today" }}
      onSelect={() => {}}
      counts={{ today: 0, upcoming: 0, completed: 0 }}
      labelCounts={new Map()}
      today="2026-11-13"
      rewardsEnabled
      onAddProject={() => {}}
    />,
  );
}

describe("the sidebar", () => {
  it("keeps the nav at eight entries with the add control beside the Projects heading", () => {
    ops.ensureInbox();
    ops.createProject({ name: "Work" });
    const html = sidebar();

    const heading = html.indexOf(">Projects<");
    expect(heading).toBeGreaterThan(-1);
    const labels = [...html.slice(0, heading).matchAll(/dn-nav__label">([^<]+)</g)].map((m) => m[1]);
    // Seven here, and the Projects heading is the eighth.
    expect(labels).toEqual(["Inbox", "Today", "Day", "Upcoming", "Search", "Labels", "Completed"]);

    // The control is a button on the heading's row, not an entry in a nav list.
    const add = html.indexOf('aria-label="Add project"');
    expect(add).toBeGreaterThan(heading);
    expect(html.slice(add - 200, add + 80)).not.toContain("dn-nav__item");
  });

  it("still draws a nested tree three levels down, indented by depth", () => {
    const a = ops.createProject({ name: "A" }).result;
    const b = ops.createProject({ name: "B", parentId: a.id }).result;
    ops.createProject({ name: "C", parentId: b.id });
    const html = sidebar();

    expect(html).toContain("padding-left:10px");
    expect(html).toContain("padding-left:24px");
    expect(html).toContain("padding-left:38px");
  });
});

describe("a task row", () => {
  function row(options: { addSubtask: boolean }) {
    const project = ops.createProject({ name: "Work" }).result;
    const task = ops.createTask({ projectId: project.id, content: "Plan the trip" }).result;
    return renderToStaticMarkup(
      <TaskRow
        task={task}
        store={store}
        ops={ops}
        today="2026-11-13"
        selected={false}
        onComplete={() => {}}
        onSelect={() => {}}
        onEdit={() => {}}
        onMoveUp={() => {}}
        onMoveDown={() => {}}
        onReschedule={() => {}}
        onPickDay={() => {}}
        onPriority={() => {}}
        {...(options.addSubtask ? { onAddSubtask: () => {} } : {})}
      />,
    );
  }

  it("offers Add subtask when the list can take one", () => {
    expect(row({ addSubtask: true })).toContain('aria-label="Add subtask to Plan the trip"');
  });

  it("offers nothing where the list does not nest, and leaves the other controls as they were", () => {
    const html = row({ addSubtask: false });
    expect(html).not.toContain("Add subtask");
    expect(html).toContain('aria-label="Edit Plan the trip"');
    expect(html).toContain('aria-label="Move Plan the trip up"');
    expect(html).toContain('aria-label="Focus on Plan the trip"');
  });
});
