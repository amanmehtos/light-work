/**
 * The sync wire protocol.
 *
 * A client holds a full local copy and a queue of mutations it has not yet had
 * acknowledged. Sync is one round trip: push the queue, pull everything that has
 * happened since a cursor. The server assigns the cursor, so clients never have
 * to trust each other's clocks for ordering — only for conflict resolution,
 * which is what the HLC is for.
 */

import type { EntityKind } from "./entities.js";

/** Monotonic per-account sequence number assigned by the server. */
export type Cursor = number;

export const PROTOCOL_VERSION = 1;

/**
 * Anything that survives the wire.
 *
 * Ops are JSON by definition, and typing their payload as `unknown` would be a
 * lie that also breaks Durable Object RPC — the runtime's serializable
 * constraint rejects `unknown`, so a method returning it infers as `never` at
 * the call site.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One entity's field values, as they travel. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * A single change to one entity.
 *
 * `fields` is a sparse patch, not a whole row: a client that only toggled a
 * checkbox sends only that field, so it cannot clobber a title someone else
 * edited meanwhile. `clock` is the HLC at which the change was made, encoded.
 */
export interface Op {
  /** Client-generated, so a retried push is idempotent. */
  id: string;
  kind: EntityKind;
  entityId: string;
  type: "upsert" | "delete";
  /** Sparse field patch. Absent for a delete. */
  fields?: JsonObject;
  /** Encoded HLC — see `encodeHLC`. */
  clock: string;
  /** Which device produced it. */
  node: string;
}

/** An op the server has accepted, stamped with its place in the account's log. */
export interface SequencedOp extends Op {
  seq: Cursor;
  /** Server receive time, for diagnostics only — never for ordering. */
  receivedAt: string;
}

export interface PushRequest {
  version: typeof PROTOCOL_VERSION;
  /** Cursor the client has already applied. */
  since: Cursor;
  ops: Op[];
}

export interface PullResponse {
  version: typeof PROTOCOL_VERSION;
  /** Cursor to pass as `since` next time. */
  cursor: Cursor;
  ops: SequencedOp[];
  /** True when more remains beyond this page; pull again immediately. */
  hasMore: boolean;
}

export interface PushResponse extends PullResponse {
  /** Ids of the ops accepted in this push, so the client can drop its queue. */
  accepted: string[];
  /** Ops the server refused, with a reason. The client must not retry these. */
  rejected: { id: string; reason: string }[];
}

/** Pushed down the WebSocket to tell idle clients a pull is worth making. */
export interface ChangeNotice {
  type: "changed";
  cursor: Cursor;
  /** The device that caused it, so a client can ignore the echo of its own push. */
  node: string;
}

export interface HelloMessage {
  type: "hello";
  cursor: Cursor;
  node: string;
}

export type ServerMessage = ChangeNotice | HelloMessage;

/** Fields the server owns; a client patching one of these is rejected. */
export const SERVER_OWNED_FIELDS = new Set(["id", "createdAt"]);
