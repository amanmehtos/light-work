/**
 * Field-level last-write-wins.
 *
 * Resolving conflicts per row would mean one device's whole task overwrites the
 * other's. Resolving per field means that if you reschedule a task on your phone
 * while your laptop renames it, both edits survive — which is the behaviour a
 * user expects and the main reason this is not just `UPDATE ... SET`.
 *
 * Each row keeps a map of field name to the encoded HLC of the last write to
 * that field, plus the clock of the latest delete it has seen. Every stored
 * value is a maximum over the ops that touched it, so folding a log in any order
 * lands on the same state. Liveness is *derived* from those clocks rather than
 * stored as a flag: a delete wins while it is the latest thing to have happened
 * to the row, and an edit newer than the delete revives it. Deriving it is what
 * makes the result independent of delivery order — an earlier version of this
 * file cleared the tombstone on undelete and diverged depending on whether the
 * delete or the edit arrived first.
 */

import { compareHLC, decodeHLC } from "./hlc.js";
import type { JsonValue, Op } from "./protocol.js";
import { SERVER_OWNED_FIELDS } from "./protocol.js";

/** Field name to encoded HLC of the last accepted write to it. */
export type FieldClocks = Record<string, string>;

export interface Record_<T> {
  value: T;
  clocks: FieldClocks;
  /**
   * Encoded HLC of the latest delete seen, or null if never deleted. Retained
   * even after a revival, so that a late-arriving duplicate delete is a no-op.
   */
  deletedAt: string | null;
}

export interface MergeResult<T> {
  record: Record_<T>;
  /** Fields the patch actually changed. Empty means the op was fully stale. */
  applied: string[];
  /** Fields the patch lost on, because a later write already existed. */
  rejected: string[];
  liveBefore: boolean;
  liveAfter: boolean;
}

function isLater(incoming: string, existing: string | undefined | null): boolean {
  if (existing === undefined || existing === null) return true;
  return compareHLC(decodeHLC(incoming), decodeHLC(existing)) > 0;
}

/** The clock of the most recent write to any field of the row. */
function latestFieldClock(clocks: FieldClocks): string | null {
  let latest: string | null = null;
  for (const clock of Object.values(clocks)) {
    if (isLater(clock, latest)) latest = clock;
  }
  return latest;
}

/**
 * Whether the row currently exists.
 *
 * Deleted while the tombstone is the latest event on the row; revived once an
 * edit newer than the tombstone arrives. Undo across devices falls out of this
 * rule rather than needing an op of its own.
 */
export function isLive<T>(record: Record_<T> | null | undefined): boolean {
  if (record == null) return false;
  if (record.deletedAt === null) return true;
  const newestEdit = latestFieldClock(record.clocks);
  if (newestEdit === null) return false;
  return isLater(newestEdit, record.deletedAt);
}

function emptyRecord<T>(): Record_<T> {
  return { value: {} as T, clocks: {}, deletedAt: null };
}

/**
 * Applies an op to a record, returning the merged result.
 *
 * Pass `null` for `existing` when the entity is new.
 */
export function applyOp<T extends object>(
  existing: Record_<T> | null,
  op: Op,
): MergeResult<T> {
  const base: Record_<T> = existing ?? emptyRecord<T>();
  const liveBefore = isLive(base);

  if (op.type === "delete") {
    // The tombstone only moves forward, so a replayed delete changes nothing.
    if (!isLater(op.clock, base.deletedAt)) {
      return { record: base, applied: [], rejected: ["__deleted"], liveBefore, liveAfter: liveBefore };
    }
    const record = { ...base, deletedAt: op.clock };
    return { record, applied: ["__deleted"], rejected: [], liveBefore, liveAfter: isLive(record) };
  }

  const fields = op.fields ?? {};
  const value = { ...base.value } as Record<string, JsonValue>;
  const clocks = { ...base.clocks };
  const applied: string[] = [];
  const rejected: string[] = [];

  for (const [field, incoming] of Object.entries(fields)) {
    if (SERVER_OWNED_FIELDS.has(field) && existing !== null) {
      rejected.push(field);
      continue;
    }
    if (!isLater(op.clock, clocks[field])) {
      rejected.push(field);
      continue;
    }
    value[field] = incoming;
    clocks[field] = op.clock;
    applied.push(field);
  }

  const record: Record_<T> = { value: value as T, clocks, deletedAt: base.deletedAt };
  return { record, applied, rejected, liveBefore, liveAfter: isLive(record) };
}

/**
 * Folds a batch of ops into a record. Order does not matter: every stored value
 * is a maximum, so replaying a log out of order converges on the same result.
 */
export function applyOps<T extends object>(
  existing: Record_<T> | null,
  ops: Op[],
): Record_<T> {
  let record = existing;
  for (const op of ops) {
    record = applyOp<T>(record, op).record;
  }
  return record ?? emptyRecord<T>();
}
