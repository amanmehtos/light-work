/**
 * The local copy.
 *
 * Every client keeps the whole account in memory and answers reads from it, so
 * the UI never waits on the network. Writes produce ops, which go into the
 * store immediately and into a queue for the next sync — the optimistic update
 * and the thing that eventually reaches the server are the same op, so there is
 * no separate "pending" shape to reconcile.
 */

import {
  Clock,
  applyOp,
  decodeHLC,
  compareOrder,
  isLive,
  keyBetween,
  newId,
  type Entity,
  type EntityByKind,
  type EntityKind,
  type JsonObject,
  type Op,
  type Record_,
  encodeHLC,
} from "@light/core";

type Bucket = Map<string, Record_<JsonObject>>;

export interface StoreChange {
  kind: EntityKind;
  entityId: string;
  /** True when the row exists after the change. */
  live: boolean;
}

export class LightStore {
  private readonly buckets = new Map<EntityKind, Bucket>();
  private readonly listeners = new Set<(changes: StoreChange[]) => void>();
  private readonly clock: Clock;

  constructor(nodeId: string, now: () => number = Date.now) {
    this.clock = new Clock(nodeId, now);
  }

  get node(): string {
    return this.clock.node;
  }

  /* ---------------------------------------------------------- */
  /* reads                                                      */
  /* ---------------------------------------------------------- */

  private bucket(kind: EntityKind): Bucket {
    let bucket = this.buckets.get(kind);
    if (bucket === undefined) {
      bucket = new Map();
      this.buckets.set(kind, bucket);
    }
    return bucket;
  }

  get<K extends EntityKind>(kind: K, id: string): EntityByKind[K] | null {
    const record = this.bucket(kind).get(id);
    if (record === undefined || !isLive(record)) return null;
    return record.value as unknown as EntityByKind[K];
  }

  /** All live rows of a kind, in insertion order. Callers sort as they need. */
  all<K extends EntityKind>(kind: K): EntityByKind[K][] {
    const out: EntityByKind[K][] = [];
    for (const record of this.bucket(kind).values()) {
      if (isLive(record)) out.push(record.value as unknown as EntityByKind[K]);
    }
    return out;
  }

  /** Live rows of a kind sorted by their fractional order key. */
  ordered<K extends "project" | "section" | "task" | "label" | "filter">(
    kind: K,
  ): EntityByKind[K][] {
    return this.all(kind).sort((a, b) =>
      compareOrder(
        (a as unknown as { order: string }).order,
        (b as unknown as { order: string }).order,
      ),
    );
  }

  count(kind: EntityKind): number {
    let n = 0;
    for (const record of this.bucket(kind).values()) if (isLive(record)) n++;
    return n;
  }

  /* ---------------------------------------------------------- */
  /* applying ops                                               */
  /* ---------------------------------------------------------- */

  /** Applies ops from the server, pulling the local clock past them. */
  applyRemote(ops: Op[]): StoreChange[] {
    const changes: StoreChange[] = [];
    for (const op of ops) {
      this.clock.observe(decodeHLC(op.clock));
      changes.push(this.applyLocally(op));
    }
    if (changes.length > 0) this.emit(changes);
    return changes;
  }

  /** Replaces local state wholesale from a server snapshot. */
  loadSnapshot(entities: Partial<Record<EntityKind, JsonObject[]>>): void {
    this.buckets.clear();
    for (const [kind, rows] of Object.entries(entities) as [EntityKind, JsonObject[]][]) {
      const bucket = this.bucket(kind);
      for (const row of rows) {
        const id = typeof row.id === "string" ? row.id : undefined;
        if (id === undefined) continue;
        // A snapshot is already-merged state, so it carries no per-field clocks.
        // Any later op wins over it, which is correct: the snapshot is by
        // definition older than anything that arrives after it.
        bucket.set(id, { value: row, clocks: {}, deletedAt: null });
      }
    }
    this.emit([]);
  }

  private applyLocally(op: Op): StoreChange {
    const bucket = this.bucket(op.kind);
    const existing = bucket.get(op.entityId) ?? null;
    const merged = applyOp(existing, op);
    bucket.set(op.entityId, merged.record);
    return { kind: op.kind, entityId: op.entityId, live: merged.liveAfter };
  }

  /* ---------------------------------------------------------- */
  /* writes                                                     */
  /* ---------------------------------------------------------- */

  /**
   * Stages a change: applied locally at once and returned for the sync queue.
   * `fields` is sparse, so only what the caller touched is claimed.
   */
  mutate<K extends EntityKind>(
    kind: K,
    entityId: string,
    fields: Partial<EntityByKind[K]>,
  ): Op {
    const op: Op = {
      id: newId(),
      kind,
      entityId,
      type: "upsert",
      fields: fields as unknown as JsonObject,
      clock: encodeHLC(this.clock.next()),
      node: this.clock.node,
    };
    this.emit([this.applyLocally(op)]);
    return op;
  }

  remove(kind: EntityKind, entityId: string): Op {
    const op: Op = {
      id: newId(),
      kind,
      entityId,
      type: "delete",
      clock: encodeHLC(this.clock.next()),
      node: this.clock.node,
    };
    this.emit([this.applyLocally(op)]);
    return op;
  }

  /**
   * An order key placing an item between two others.
   *
   * Exposed because callers reordering a list need the key before they can
   * build the mutation, and the arithmetic should not be duplicated in the UI.
   */
  orderBetween(before: string | null, after: string | null): string {
    return keyBetween(before, after);
  }

  /* ---------------------------------------------------------- */
  /* notification                                               */
  /* ---------------------------------------------------------- */

  subscribe(listener: (changes: StoreChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(changes: StoreChange[]): void {
    for (const listener of this.listeners) listener(changes);
  }
}

export type { Entity };
