import { describe, expect, it } from "vitest";
import {
  FIRST_KEY,
  compareOrder,
  keyBetween,
  keysBetween,
  rebalance,
} from "../src/order.js";

describe("keyBetween", () => {
  it("seeds an empty list", () => {
    expect(FIRST_KEY).toBe(keyBetween(null, null));
    expect(FIRST_KEY).not.toBe("");
  });

  it("appends after a key", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    expect(compareOrder(a, b)).toBe(-1);
  });

  it("prepends before a key", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(null, a);
    expect(compareOrder(b, a)).toBe(-1);
  });

  it("inserts strictly between two keys", () => {
    const a = keyBetween(null, null);
    const c = keyBetween(a, null);
    const b = keyBetween(a, c);
    expect(compareOrder(a, b)).toBe(-1);
    expect(compareOrder(b, c)).toBe(-1);
  });

  it("survives repeated insertion at the same spot", () => {
    let lower = keyBetween(null, null);
    const upper = keyBetween(lower, null);
    const seen = new Set<string>([lower, upper]);
    for (let i = 0; i < 500; i++) {
      const next = keyBetween(lower, upper);
      expect(compareOrder(lower, next)).toBe(-1);
      expect(compareOrder(next, upper)).toBe(-1);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      lower = next;
    }
  });

  it("survives repeated prepending", () => {
    let head = keyBetween(null, null);
    for (let i = 0; i < 500; i++) {
      const next = keyBetween(null, head);
      expect(compareOrder(next, head)).toBe(-1);
      head = next;
    }
  });

  it("survives repeated appending", () => {
    let tail = keyBetween(null, null);
    for (let i = 0; i < 500; i++) {
      const next = keyBetween(tail, null);
      expect(compareOrder(tail, next)).toBe(-1);
      tail = next;
    }
  });

  it("never mints a key ending in a zero digit", () => {
    let tail = keyBetween(null, null);
    for (let i = 0; i < 200; i++) {
      expect(tail.endsWith("0")).toBe(false);
      tail = keyBetween(tail, null);
    }
  });

  it("rejects inverted bounds", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    expect(() => keyBetween(b, a)).toThrow(/not below/);
    expect(() => keyBetween(a, a)).toThrow(/not below/);
  });

  it("rejects malformed bounds", () => {
    expect(() => keyBetween("", null)).toThrow(/empty/);
    expect(() => keyBetween("a0", null)).toThrow(/zero digit/);
    expect(() => keyBetween("!!", null)).toThrow(/invalid digit/);
  });
});

describe("keysBetween", () => {
  it("returns nothing for a count of zero", () => {
    expect(keysBetween(null, null, 0)).toEqual([]);
  });

  it("returns ascending keys within the bounds", () => {
    const lower = keyBetween(null, null);
    const upper = keyBetween(lower, null);
    const keys = keysBetween(lower, upper, 64);
    expect(keys).toHaveLength(64);
    expect([...keys].sort(compareOrder)).toEqual(keys);
    expect(new Set(keys).size).toBe(64);
    for (const key of keys) {
      expect(compareOrder(lower, key)).toBe(-1);
      expect(compareOrder(key, upper)).toBe(-1);
    }
  });

  it("keeps keys short when bulk inserting, as an import would", () => {
    const keys = keysBetween(null, null, 1000);
    expect(keys).toHaveLength(1000);
    expect([...keys].sort(compareOrder)).toEqual(keys);
    const longest = Math.max(...keys.map((k) => k.length));
    // Naive repeated appending would grow one character per item.
    expect(longest).toBeLessThan(10);
  });
});

describe("rebalance", () => {
  it("produces short evenly spaced keys", () => {
    const keys = rebalance(500);
    expect(keys).toHaveLength(500);
    expect([...keys].sort(compareOrder)).toEqual(keys);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(10);
  });
});
