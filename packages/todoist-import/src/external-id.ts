/**
 * Deterministic ids for imported rows.
 *
 * An import that mints fresh random ids duplicates everything when it is run
 * twice — and it will be run twice, because the first run is always a dry run.
 * Deriving the id from the source system and its id instead makes the import
 * idempotent: re-importing the same account produces the same ids, so the ops
 * land as no-op upserts rather than a second copy of your account.
 *
 * The cost is that imported ids are not time-sortable the way locally created
 * ones are. That only affects index locality, which is a fair trade for not
 * duplicating 50 projects.
 */

const OFFSET = 0x811c9dc5;
const PRIME = 0x01000193;

function fnv1a(input: string): number {
  let hash = OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** A stable 24-character id for an entity imported from another system. */
export function externalId(source: string, kind: string, id: string): string {
  const seed = `${source}:${kind}:${id}`;
  // Four rounds over salted variants, for enough width to make collisions
  // irrelevant at the scale an import operates on.
  let out = "";
  for (let round = 0; round < 4; round++) {
    out += fnv1a(`${round}|${seed}`).toString(36).padStart(7, "0");
  }
  return out.slice(0, 24);
}
