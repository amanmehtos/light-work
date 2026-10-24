import { describe, expect, it } from "vitest";
import {
  Clock,
  compareHLC,
  decodeHLC,
  encodeHLC,
  merge,
  tick,
  zeroHLC,
} from "../src/hlc.js";

describe("encodeHLC", () => {
  it("round-trips", () => {
    const hlc = { wall: 1761300000000, counter: 7, node: "device-a" };
    expect(decodeHLC(encodeHLC(hlc))).toEqual(hlc);
  });

  it("sorts lexicographically in the same order as compareHLC", () => {
    const clocks = [
      { wall: 1, counter: 0, node: "a" },
      { wall: 1, counter: 1, node: "a" },
      { wall: 1, counter: 1, node: "b" },
      { wall: 2, counter: 0, node: "a" },
      { wall: 1761300000000, counter: 0, node: "a" },
    ];
    const byCompare = [...clocks].sort(compareHLC).map(encodeHLC);
    const byString = [...clocks].map(encodeHLC).sort();
    expect(byString).toEqual(byCompare);
  });

  it("rejects malformed input", () => {
    expect(() => decodeHLC("nope")).toThrow(/malformed/);
  });
});

describe("tick", () => {
  it("advances the wall clock when time has moved on", () => {
    const next = tick({ wall: 100, counter: 5, node: "a" }, 200);
    expect(next).toEqual({ wall: 200, counter: 0, node: "a" });
  });

  it("bumps the counter within the same millisecond", () => {
    const next = tick({ wall: 200, counter: 5, node: "a" }, 200);
    expect(next).toEqual({ wall: 200, counter: 6, node: "a" });
  });

  it("stays monotonic when the device clock runs backwards", () => {
    const local = { wall: 500, counter: 0, node: "a" };
    const next = tick(local, 100);
    expect(compareHLC(local, next)).toBe(-1);
    expect(next).toEqual({ wall: 500, counter: 1, node: "a" });
  });
});

describe("merge", () => {
  it("orders a local event after an absorbed remote one", () => {
    const remote = { wall: 900, counter: 3, node: "b" };
    const local = { wall: 100, counter: 0, node: "a" };
    const merged = merge(local, remote, 100);
    expect(compareHLC(remote, merged)).toBe(-1);
    expect(merged.node).toBe("a");
  });

  it("breaks ties when both clocks sit in the same millisecond", () => {
    const merged = merge(
      { wall: 300, counter: 4, node: "a" },
      { wall: 300, counter: 9, node: "b" },
      300,
    );
    expect(merged).toEqual({ wall: 300, counter: 10, node: "a" });
  });
});

describe("Clock", () => {
  it("issues strictly increasing timestamps even with a frozen wall clock", () => {
    const clock = new Clock("device-a", () => 1000);
    let previous = clock.peek();
    for (let i = 0; i < 100; i++) {
      const next = clock.next();
      expect(compareHLC(previous, next)).toBe(-1);
      previous = next;
    }
  });

  it("starts from zero", () => {
    expect(new Clock("device-a").peek()).toEqual(zeroHLC("device-a"));
  });

  it("orders its own events after anything it has observed", () => {
    const clock = new Clock("device-a", () => 1000);
    clock.observe({ wall: 5000, counter: 2, node: "device-b" });
    const mine = clock.next();
    expect(mine.wall).toBeGreaterThanOrEqual(5000);
    expect(compareHLC({ wall: 5000, counter: 2, node: "device-b" }, mine)).toBe(-1);
  });
});
