import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  isTypingTarget,
  moveSelection,
  resolveShortcut,
  selectionAfterRemoval,
  type KeyLike,
  type PageState,
  type TargetLike,
} from "../src/shortcuts.js";

/**
 * A stand-in for a focused element. The guard reads a tag, a content-editable
 * flag, a role and `closest`, and nothing else, so this is as much of the DOM
 * as the rule can see.
 */
function el(
  tag: string,
  extra: { editable?: boolean; role?: string; within?: string[] } = {},
): TargetLike {
  return {
    tagName: tag,
    isContentEditable: extra.editable === true,
    getAttribute: (name) => (name === "role" ? (extra.role ?? null) : null),
    closest: (selector) => {
      // `selector` is a comma list; answer yes when any part names something
      // this element is, or sits inside.
      const wanted = selector.split(",").map((part) => part.trim());
      const is = [tag.toLowerCase(), ...(extra.within ?? [])];
      return wanted.some((part) => is.includes(part) || (part === 'a[href]' && tag === "A")) ? el : null;
    },
  };
}

const body = el("BODY");
const idle: PageState = { sheetOpen: false, menuOpen: false };

function press(key: string, target: TargetLike | null = body, over: Partial<KeyLike> = {}): KeyLike {
  return {
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
  };
}

const resolve = (event: KeyLike, page: PageState = idle) => resolveShortcut(event, page);

describe("the set", () => {
  it("is exactly seven, which is the point of it", () => {
    expect(SHORTCUTS).toHaveLength(7);
  });

  it("lists nothing that does not resolve, and everything that does", () => {
    const listed = SHORTCUTS.flatMap((entry) => entry.keys).map((key) => (key === "Esc" ? "Escape" : key));
    for (const key of listed) expect(resolve(press(key)), key).not.toBeNull();

    // And nothing else on the keyboard does anything.
    const extras = "abcdfghilmnoprstuvwxyz0123456789,.;'[]-=".split("");
    for (const key of extras) expect(resolve(press(key)), key).toBeNull();
  });

  it("maps each key to its own action", () => {
    expect(resolve(press("q"))).toBe("quick-add");
    expect(resolve(press("/"))).toBe("search");
    expect(resolve(press("e"))).toBe("edit");
    expect(resolve(press("j"))).toBe("next");
    expect(resolve(press("k"))).toBe("previous");
    expect(resolve(press("Enter"))).toBe("complete");
    expect(resolve(press("Escape"))).toBe("escape");
    expect(resolve(press("?", body, { shiftKey: true }))).toBe("help");
  });
});

describe("while something is being typed into", () => {
  const fields: [string, TargetLike][] = [
    ["a text input", el("INPUT")],
    ["a date input", el("INPUT")],
    ["a textarea", el("TEXTAREA")],
    ["a select", el("SELECT")],
    ["a contenteditable", el("DIV", { editable: true })],
    ["a role=textbox", el("DIV", { role: "textbox" })],
  ];

  it.each(fields)("no shortcut fires in %s", (_name, target) => {
    expect(isTypingTarget(target)).toBe(true);
    for (const key of ["q", "/", "e", "j", "k", "Enter", "?"]) {
      expect(resolve(press(key, target)), key).toBeNull();
    }
  });

  it("types 'quick jerky' into the add field without anything firing", () => {
    // The phrase from the plan, because it holds q, k, j, e and r.
    const field = el("INPUT");
    const fired = [..."quick jerky"].map((character) =>
      resolve(press(character, field, { shiftKey: false })),
    );
    expect(fired.every((result) => result === null)).toBe(true);
  });

  it("ignores a capital and a question mark typed into a field as well", () => {
    const field = el("INPUT");
    expect(resolve(press("Q", field, { shiftKey: true }), idle)).toBeNull();
    expect(resolve(press("?", field, { shiftKey: true }), idle)).toBeNull();
  });

  it("still lets Escape through, which only lets go of the field", () => {
    expect(resolve(press("Escape", el("INPUT")))).toBe("escape");
  });

  it("does not treat an ordinary element as a field", () => {
    expect(isTypingTarget(body)).toBe(false);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("while a sheet or a menu is open", () => {
  const sheet: PageState = { sheetOpen: true, menuOpen: false };
  const menu: PageState = { sheetOpen: false, menuOpen: true };

  it("nothing but Escape fires, even with focus on the page", () => {
    for (const page of [sheet, menu]) {
      for (const key of ["q", "/", "e", "j", "k", "Enter", "?"]) {
        expect(resolve(press(key), page), key).toBeNull();
      }
    }
  });

  it("leaves Escape inside a sheet to the library, which closes it on its own", () => {
    const inSheet = el("INPUT", { within: [".dn-sheet"] });
    expect(resolve(press("Escape", inSheet), sheet)).toBeNull();
  });

  it("takes Escape for a sheet when focus has wandered off it, so it still closes", () => {
    expect(resolve(press("Escape", body), sheet)).toBe("escape");
  });

  it("leaves Escape to an open menu, which has already taken it", () => {
    expect(resolve(press("Escape", el("BUTTON")), menu)).toBeNull();
  });
});

describe("what is not a plain key press", () => {
  it("ignores a chord, so the browser keeps its own", () => {
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(resolve(press("k", body, over))).toBeNull();
      expect(resolve(press("/", body, over))).toBeNull();
    }
  });

  it("ignores a key an input method is composing, and one something else handled", () => {
    expect(resolve(press("j", body, { isComposing: true }))).toBeNull();
    expect(resolve(press("Escape", body, { isComposing: true }))).toBeNull();
    expect(resolve(press("j", body, { defaultPrevented: true }))).toBeNull();
  });

  it("reads Caps Lock as the letter, and Shift on a letter as nothing", () => {
    expect(resolve(press("J"))).toBe("next");
    expect(resolve(press("J", body, { shiftKey: true }))).toBeNull();
  });

  it("lets j and k repeat but never Enter, which would flip a task back and forth", () => {
    expect(resolve(press("j", body, { repeat: true }))).toBe("next");
    expect(resolve(press("k", body, { repeat: true }))).toBe("previous");
    expect(resolve(press("Enter", body, { repeat: true }))).toBeNull();
    expect(resolve(press("q", body, { repeat: true }))).toBeNull();
  });
});

describe("Enter", () => {
  it("is left to a focused button or link, which would act on it anyway", () => {
    expect(resolve(press("Enter", el("BUTTON")))).toBeNull();
    expect(resolve(press("Enter", el("A")))).toBeNull();
    expect(resolve(press("Enter", el("DIV", { within: ['[role^="menuitem"]'] })))).toBeNull();
  });

  it("completes when focus is on the page", () => {
    expect(resolve(press("Enter", body))).toBe("complete");
  });

  it("does not stop the other keys from firing with a button focused", () => {
    expect(resolve(press("j", el("BUTTON")))).toBe("next");
  });
});

describe("moveSelection", () => {
  const ids = ["a", "b", "c"];

  it("steps, and stops at either end rather than wrapping", () => {
    expect(moveSelection(ids, "a", 1)).toBe("b");
    expect(moveSelection(ids, "c", 1)).toBe("c");
    expect(moveSelection(ids, "a", -1)).toBe("a");
    expect(moveSelection(ids, "c", -1)).toBe("b");
  });

  it("starts at the top on j and the bottom on k when nothing, or nothing visible, is selected", () => {
    expect(moveSelection(ids, null, 1)).toBe("a");
    expect(moveSelection(ids, null, -1)).toBe("c");
    expect(moveSelection(ids, "gone", 1)).toBe("a");
    expect(moveSelection(ids, "gone", -1)).toBe("c");
  });

  it("selects nothing in an empty list", () => {
    expect(moveSelection([], null, 1)).toBeNull();
  });
});

describe("selectionAfterRemoval", () => {
  it("moves down to the neighbour, or up from the last row", () => {
    expect(selectionAfterRemoval(["a", "b", "c"], "a")).toBe("b");
    expect(selectionAfterRemoval(["a", "b", "c"], "b")).toBe("c");
    expect(selectionAfterRemoval(["a", "b", "c"], "c")).toBe("b");
  });

  it("leaves nothing selected when the last row goes, or the row was not there", () => {
    expect(selectionAfterRemoval(["a"], "a")).toBeNull();
    expect(selectionAfterRemoval(["a", "b"], "z")).toBeNull();
  });
});
