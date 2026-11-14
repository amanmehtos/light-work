import { describe, expect, it } from "vitest";
import { mountDrag } from "../src/mount-drag.js";

/**
 * A stand-in element: `drag()` needs listeners, pointer capture and nothing
 * else, and an `EventTarget` is the same listener machinery the browser uses.
 */
class FakeElement extends EventTarget {
  setPointerCapture(): void {}
  /** Set while the press is "on a control", for the `ignore` selector to find. */
  onControl = false;
  closest(selector: string): this | null {
    return this.onControl && selector === "[data-no-drag]" ? this : null;
  }
}

function pointer(type: string, x: number, y: number): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    button: 0,
    clientX: x,
    clientY: y,
  });
}

function press(el: EventTarget, to: [number, number] = [0, 0]): void {
  el.dispatchEvent(pointer("pointerdown", 0, 0));
  if (to[0] !== 0 || to[1] !== 0) el.dispatchEvent(pointer("pointermove", to[0], to[1]));
  el.dispatchEvent(pointer("pointerup", to[0], to[1]));
}

function mount(el: FakeElement, ignore?: string) {
  const seen = { tap: 0, end: 0 };
  const stop = mountDrag(el as unknown as HTMLElement, {
    axis: "both",
    threshold: 6,
    onEnd: () => {
      seen.end += 1;
    },
    onTap: () => {
      seen.tap += 1;
    },
  }, ignore);
  return { seen, stop };
}

describe("mountDrag", () => {
  it("behaves like drag(): a press is a tap, a pull past the threshold is a drag", () => {
    const el = new FakeElement();
    const { seen } = mount(el);

    press(el);
    expect(seen).toEqual({ tap: 1, end: 0 });

    press(el, [40, 40]);
    expect(seen).toEqual({ tap: 1, end: 1 });
  });

  it("stays a tap under the threshold", () => {
    const el = new FakeElement();
    const { seen } = mount(el);
    press(el, [3, 3]);
    expect(seen.tap).toBe(1);
    expect(seen.end).toBe(0);
  });

  it("stops responding once torn down", () => {
    const el = new FakeElement();
    const { seen, stop } = mount(el);
    stop();

    press(el);
    press(el, [40, 40]);
    expect(seen).toEqual({ tap: 0, end: 0 });
  });

  it("is one set of handlers after mount, teardown, mount — what StrictMode does", () => {
    const el = new FakeElement();
    const first = mount(el);
    first.stop();
    const second = mount(el);

    press(el);
    press(el, [40, 40]);
    // Each fires once. Without a teardown the first mount's handlers would
    // still be on the node and these would both be 2.
    expect(second.seen).toEqual({ tap: 1, end: 1 });
    expect(first.seen).toEqual({ tap: 0, end: 0 });
  });

  it("lets a control inside keep its press when told to ignore it", () => {
    const el = new FakeElement();
    const { seen } = mount(el, "[data-no-drag]");

    el.onControl = true;
    press(el);
    press(el, [40, 40]);
    expect(seen).toEqual({ tap: 0, end: 0 });

    // Anywhere else on the card still drags.
    el.onControl = false;
    press(el);
    press(el, [40, 40]);
    expect(seen).toEqual({ tap: 1, end: 1 });
  });

  it("ignores nothing unless asked, so the day view is untouched", () => {
    const el = new FakeElement();
    const { seen } = mount(el);
    el.onControl = true;
    press(el);
    expect(seen.tap).toBe(1);
  });

  it("leaves no shadow behind on the element", () => {
    const el = new FakeElement();
    mount(el);
    expect(Object.prototype.hasOwnProperty.call(el, "addEventListener")).toBe(false);
  });
});
