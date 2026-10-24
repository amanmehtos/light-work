import { applyOp, isLive, type Cursor, type JsonObject, type Op, type Record_ } from "@light/core";
import type { PullResult, PushResult, SnapshotResult, SyncTransport } from "../src/session.js";

/**
 * An in-memory stand-in for the Light Week server.
 *
 * Applies the same merge rule the real Durable Object does, so a tool test
 * exercises the real conflict behaviour without needing workerd.
 */
export class FakeServer implements SyncTransport {
  private readonly log: (Op & { seq: number })[] = [];
  private readonly entities = new Map<string, Record_<JsonObject>>();
  pushCalls = 0;

  private key(kind: string, id: string): string {
    return `${kind}:${id}`;
  }

  async snapshot(): Promise<SnapshotResult> {
    const entities: Record<string, JsonObject[]> = {};
    for (const [key, record] of this.entities) {
      if (!isLive(record)) continue;
      const kind = key.slice(0, key.indexOf(":"));
      (entities[kind] ??= []).push(record.value);
    }
    return { cursor: this.log.length, entities };
  }

  async pull(since: Cursor): Promise<PullResult> {
    const ops = this.log.filter((op) => op.seq > since);
    return { cursor: this.log.length, ops, hasMore: false };
  }

  async push(since: Cursor, ops: Op[]): Promise<PushResult> {
    this.pushCalls += 1;
    for (const op of ops) {
      if (this.log.some((existing) => existing.id === op.id)) continue;
      const key = this.key(op.kind, op.entityId);
      const merged = applyOp(this.entities.get(key) ?? null, op);
      this.entities.set(key, merged.record);
      this.log.push({ ...op, seq: this.log.length + 1 });
    }
    return {
      cursor: this.log.length,
      ops: this.log.filter((op) => op.seq > since && !ops.some((pushed) => pushed.id === op.id)),
      hasMore: false,
      rejected: [],
    };
  }

  /** Simulates another device changing something. */
  async applyExternal(ops: Op[]): Promise<void> {
    await this.push(this.log.length, ops);
  }

  liveCount(kind: string): number {
    let n = 0;
    for (const [key, record] of this.entities) {
      if (key.startsWith(`${kind}:`) && isLive(record)) n++;
    }
    return n;
  }
}
