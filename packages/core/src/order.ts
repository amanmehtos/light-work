/**
 * Fractional index ordering.
 *
 * An order key is a base-62 fraction held as a string, compared
 * lexicographically. Inserting between two neighbours mints a key strictly
 * between them, so a reorder only ever writes the one row that moved and two
 * devices reordering different items never conflict.
 *
 * Keys are pure fractions with no integer part. Repeatedly inserting at the
 * same spot therefore lengthens the key rather than failing; `rebalance` exists
 * for when a list has been churned enough that keys have grown unreasonable.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Lowest key the generator will mint, useful as a seed. */
export const FIRST_KEY = keyBetween(null, null);

function assertValid(key: string, label: string): void {
  if (key === "") throw new Error(`${label} must not be empty`);
  for (const ch of key) {
    if (!DIGITS.includes(ch)) throw new Error(`${label} has invalid digit ${ch}`);
  }
  if (key.endsWith("0")) throw new Error(`${label} must not end in a zero digit`);
}

/**
 * Returns a key strictly between `lower` and `upper`.
 *
 * Pass `null` for `lower` to insert at the head of the list, `null` for `upper`
 * to append at the tail, and `null` for both to seed an empty list.
 */
export function keyBetween(lower: string | null, upper: string | null): string {
  if (lower !== null) assertValid(lower, "lower bound");
  if (upper !== null) assertValid(upper, "upper bound");
  if (lower !== null && upper !== null && lower >= upper) {
    throw new Error(`lower bound ${lower} is not below upper bound ${upper}`);
  }
  return midpoint(lower ?? "", upper);
}

function midpoint(lower: string, upper: string | null): string {
  if (upper !== null) {
    // Carry any shared prefix through untouched and recurse on the remainder.
    let shared = 0;
    while (true) {
      const l = lower.charAt(shared) || "0";
      const u = upper.charAt(shared);
      if (u === "" || l !== u) break;
      shared += 1;
    }
    if (shared > 0) {
      return upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared));
    }
  }

  const lowDigit = lower === "" ? 0 : DIGITS.indexOf(lower.charAt(0));
  const highDigit = upper === null ? DIGITS.length : DIGITS.indexOf(upper.charAt(0));

  if (highDigit - lowDigit > 1) {
    // Room for a digit in between; take the midpoint of the two.
    const mid = Math.round(0.5 * (lowDigit + highDigit));
    return DIGITS.charAt(mid);
  }

  // The leading digits are adjacent, so descend a place.
  if (upper !== null && upper.length > 1) return upper.slice(0, 1);
  return DIGITS.charAt(lowDigit) + midpoint(lower.slice(1), null);
}

/**
 * Mints `count` keys in ascending order, all strictly between the bounds.
 * Used when inserting a block of items at once, such as during an import.
 */
export function keysBetween(
  lower: string | null,
  upper: string | null,
  count: number,
): string[] {
  if (count < 0) throw new Error("count must not be negative");
  if (count === 0) return [];
  if (count === 1) return [keyBetween(lower, upper)];

  // Split at the midpoint and fill each half, so keys stay short rather than
  // growing linearly as they would when repeatedly appending after the last.
  const mid = Math.floor(count / 2);
  const pivot = keyBetween(lower, upper);
  return [
    ...keysBetween(lower, pivot, mid),
    pivot,
    ...keysBetween(pivot, upper, count - mid - 1),
  ];
}

/** Returns evenly spaced short keys for a list whose keys have grown long. */
export function rebalance(count: number): string[] {
  return keysBetween(null, null, count);
}

export function compareOrder(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
