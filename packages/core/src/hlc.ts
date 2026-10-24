/**
 * Hybrid logical clock.
 *
 * Wall-clock ordering that still works when device clocks disagree: the wall
 * component keeps timestamps human-meaningful, the counter breaks ties within
 * the same millisecond, and the node id breaks ties between devices so that
 * every replica reaches the same ordering decision.
 */

export interface HLC {
  /** Milliseconds since epoch. */
  readonly wall: number;
  /** Disambiguates events inside the same millisecond. */
  readonly counter: number;
  /** Stable per-device identifier. */
  readonly node: string;
}

const WALL_WIDTH = 11;
const COUNTER_WIDTH = 5;

/**
 * Encodes a clock as a string that sorts identically to {@link compareHLC}, so
 * it can be stored in a SQLite TEXT column and compared with plain `<`.
 */
export function encodeHLC(hlc: HLC): string {
  const wall = hlc.wall.toString(36).padStart(WALL_WIDTH, "0");
  const counter = hlc.counter.toString(36).padStart(COUNTER_WIDTH, "0");
  return `${wall}:${counter}:${hlc.node}`;
}

export function decodeHLC(encoded: string): HLC {
  const parts = encoded.split(":");
  if (parts.length < 3) throw new Error(`malformed HLC: ${encoded}`);
  const [wall, counter, ...node] = parts as [string, string, ...string[]];
  return {
    wall: parseInt(wall, 36),
    counter: parseInt(counter, 36),
    node: node.join(":"),
  };
}

export function compareHLC(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node === b.node) return 0;
  return a.node < b.node ? -1 : 1;
}

/** Advances the clock for a locally originated event. */
export function tick(local: HLC, nowMs: number): HLC {
  const wall = Math.max(local.wall, nowMs);
  const counter = wall === local.wall ? local.counter + 1 : 0;
  return { wall, counter, node: local.node };
}

/**
 * Advances the clock on receiving a remote event, pulling the local clock
 * forward past the remote one so that any event we then originate is ordered
 * after it.
 */
export function merge(local: HLC, remote: HLC, nowMs: number): HLC {
  const wall = Math.max(local.wall, remote.wall, nowMs);
  let counter: number;
  if (wall === local.wall && wall === remote.wall) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (wall === local.wall) {
    counter = local.counter + 1;
  } else if (wall === remote.wall) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return { wall, counter, node: local.node };
}

export function zeroHLC(node: string): HLC {
  return { wall: 0, counter: 0, node };
}

/** A clock bound to one device, advanced in place as events are produced. */
export class Clock {
  private current: HLC;

  constructor(
    node: string,
    private readonly now: () => number = Date.now,
  ) {
    this.current = zeroHLC(node);
  }

  get node(): string {
    return this.current.node;
  }

  peek(): HLC {
    return this.current;
  }

  /** Produces the next timestamp for a local event. */
  next(): HLC {
    this.current = tick(this.current, this.now());
    return this.current;
  }

  /** Absorbs a remote timestamp, returning the updated local clock. */
  observe(remote: HLC): HLC {
    this.current = merge(this.current, remote, this.now());
    return this.current;
  }
}
