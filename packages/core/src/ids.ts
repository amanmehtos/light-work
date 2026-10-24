/**
 * Identifiers.
 *
 * Ids are generated on the client so that creating a task works offline and
 * never needs a server round trip to become real. They are time-prefixed and
 * lexicographically sortable, which keeps insertion order stable in SQLite
 * indexes and makes a log of ids readable when debugging.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomPart(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += ALPHABET.charAt(byte % ALPHABET.length);
  }
  return out;
}

/** A sortable, collision-resistant id: 8 chars of timestamp, 16 random. */
export function newId(now: number = Date.now()): string {
  return now.toString(36).padStart(8, "0") + randomPart(16);
}

/** A stable per-device identifier, used as the HLC node and for echo suppression. */
export function newNodeId(): string {
  return `n${randomPart(10)}`;
}

export function idTimestamp(id: string): number {
  return parseInt(id.slice(0, 8), 36);
}
