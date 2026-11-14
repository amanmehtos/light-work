import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { JsonObject } from "@light/core";
import { LightStore, commentsOnTask } from "@light/client-sdk";
import { TaskComments } from "../src/components/TaskComments.js";
import { resolveShortcut, type KeyLike, type TargetLike } from "../src/shortcuts.js";

/**
 * A task and its comments, in the store the way a client receives them: as a
 * snapshot row, wholesale, with whatever the importer put there.
 */
function account(comments: JsonObject[]) {
  const store = new LightStore("test-device");
  store.loadSnapshot({
    task: [{ id: "t1", projectId: "p1", content: "Ready the deck" }],
    comment: comments,
  });
  return store;
}

const render = (store: LightStore) =>
  renderToStaticMarkup(<TaskComments comments={commentsOnTask(store, "t1")} onAdd={() => {}} />);

describe("an imported comment", () => {
  // The importer's own shape, plus keys this client has no field for and a
  // date it did not stamp. None of it may stop the comment being read.
  const imported: JsonObject = {
    id: "c1",
    taskId: "t1",
    projectId: null,
    content: "Lead with economics.\nThen the roadmap.",
    attachment: null,
    postedById: "todoist-uid-1234",
    postedAt: "2024-03-01T09:30:00.000000Z",
    reactions: { "👍": ["todoist-uid-9"] },
    uidsToNotify: [],
  };

  it("decodes and displays, with its line break kept and the keys it does not know ignored", () => {
    const html = render(account([imported]));
    expect(html).toContain("Lead with economics.\nThen the roadmap.");
    expect(html).toContain("Comments · 1");
    expect(html).toContain("2024"); // its date, read from a microsecond timestamp
    expect(html).not.toContain("todoist-uid-1234");
  });

  it("is reached from the task it was written on, and not from another", () => {
    const store = account([imported, { ...imported, id: "c2", taskId: "elsewhere", content: "not here" }]);
    expect(render(store)).not.toContain("not here");
  });

  it("shows no date when the import had none, rather than 1970", () => {
    const html = render(account([{ ...imported, postedAt: new Date(0).toISOString() }]));
    expect(html).toContain("Lead with economics.");
    expect(html).not.toContain("1970");
  });

  it("survives the fields an older import left out", () => {
    const html = render(account([{ id: "c3", taskId: "t1", content: "bare", postedAt: "" } as JsonObject]));
    expect(html).toContain("bare");
  });

  it("shows text as text: markup in a comment is escaped, not rendered", () => {
    const html = render(account([{ ...imported, content: "<img src=x onerror=alert(1)>" }]));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("names an attachment, links it only when it is a web address", () => {
    const withFile = (fileUrl: string): JsonObject => ({
      ...imported,
      attachment: { fileName: "deck.pdf", fileType: "application/pdf", fileUrl, fileSize: 2048 },
    });
    const safe = render(account([withFile("https://example.com/deck.pdf")]));
    expect(safe).toContain('href="https://example.com/deck.pdf"');
    expect(safe).toContain('rel="noopener noreferrer"');

    const unsafe = render(account([withFile("javascript:alert(1)")]));
    expect(unsafe).toContain("deck.pdf");
    expect(unsafe).not.toContain("href=");
  });

  it("is oldest first", () => {
    const html = render(
      account([
        { ...imported, id: "late", content: "second", postedAt: "2024-05-01T00:00:00.000Z" },
        { ...imported, id: "early", content: "first", postedAt: "2024-04-01T00:00:00.000Z" },
      ]),
    );
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("second"));
  });

  it("still offers the add field on a task with none", () => {
    const html = render(account([]));
    expect(html).toContain("<textarea");
    expect(html).not.toContain("<ul");
  });
});

describe("keyboard shortcuts while the comment box has focus", () => {
  /**
   * The focused element, taken from what the component actually renders
   * rather than assumed — so changing the box to a `div` or an `input` of some
   * other kind changes what this tests. It is inside the editor sheet, as it
   * is on the page.
   */
  function focused(tag: "textarea" | "button"): TargetLike {
    const html = render(account([]));
    expect(html).toMatch(new RegExp(`<${tag}[\\s>]`));
    expect(html, "the thread must not sit in a form: Enter would submit it").not.toContain("<form");
    return {
      tagName: tag.toUpperCase(),
      isContentEditable: false,
      getAttribute: () => null,
      closest: (selector) =>
        selector.split(",").some((part) => [tag, ".dn-sheet"].includes(part.trim())) ? {} : null,
    };
  }

  const press = (key: string, target: TargetLike, over: Partial<KeyLike> = {}): KeyLike => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    target,
    ...over,
  });

  const KEYS = ["q", "/", "e", "j", "k", "Enter", "?"];

  it("none of the seven fires in the box, with the sheet open or — if it were not — closed", () => {
    const box = focused("textarea");
    for (const sheetOpen of [true, false]) {
      for (const key of KEYS) {
        const shift = key === "?";
        expect(resolveShortcut(press(key, box, { shiftKey: shift }), { sheetOpen, menuOpen: false }), `${key}, sheetOpen=${sheetOpen}`)
          .toBeNull();
      }
    }
  });

  it("types a sentence full of shortcut letters without anything firing", () => {
    const box = focused("textarea");
    for (const character of "quick jerky, then email Jo/Q? ") {
      const shiftKey = character !== character.toLowerCase() || character === "?";
      expect(resolveShortcut(press(character, box, { shiftKey }), { sheetOpen: true, menuOpen: false }), character)
        .toBeNull();
    }
    // A line break is the box's own.
    expect(resolveShortcut(press("Enter", box), { sheetOpen: true, menuOpen: false })).toBeNull();
  });

  it("leaves Escape to the sheet, which closes itself and the half-typed comment with it", () => {
    expect(resolveShortcut(press("Escape", focused("textarea")), { sheetOpen: true, menuOpen: false })).toBeNull();
  });

  it("leaves Enter on the Comment button to the button", () => {
    const button = focused("button");
    expect(resolveShortcut(press("Enter", button), { sheetOpen: true, menuOpen: false })).toBeNull();
    expect(resolveShortcut(press("Enter", button), { sheetOpen: false, menuOpen: false })).toBeNull();
  });
});
