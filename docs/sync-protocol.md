# Sync protocol

Version 1. All requests need `Authorization: Bearer <session token>`.

## Operations

The unit of change:

```jsonc
{
  "id": "k3m1x8a9qp2...",   // client-generated; makes a retry idempotent
  "kind": "task",            // project|section|task|label|comment|reminder|filter|focusSession
  "entityId": "k3m1x8b2...",
  "type": "upsert",          // or "delete"
  "fields": { "priority": 1 },  // sparse patch; absent for a delete
  "clock": "00000z9k4lm:00003:nf82kd10qp",  // encoded HLC
  "node": "nf82kd10qp"       // the device
}
```

`fields` is a **sparse patch**, not a row. A client that toggled a checkbox
sends only that field and so cannot clobber a title edited elsewhere.

The clock encodes as `<wall base36>:<counter base36>:<node>`, padded so that
string comparison matches timestamp comparison. That lets SQLite order clocks
with a plain `<`.

## Endpoints

### `GET /sync/snapshot`

Full current state. For a client that has never synced, or one whose cursor has
fallen outside retained history.

```jsonc
{
  "version": 1,
  "cursor": 2841,
  "entities": {
    "project": [ /* ... */ ],
    "task": [ /* ... */ ]
  }
}
```

Live rows only — tombstones are not worth sending to a client that has never
seen the rows.

### `GET /sync/pull?since=<cursor>`

Operations with a sequence above `since`, oldest first, up to 500 per page.

```jsonc
{ "version": 1, "cursor": 2900, "ops": [ /* ... */ ], "hasMore": true }
```

Keep pulling while `hasMore`.

### `POST /sync`

Push and pull in one trip. Up to 1000 operations per request.

```jsonc
// request
{ "version": 1, "since": 2841, "ops": [ /* ... */ ] }

// response
{
  "version": 1,
  "cursor": 2903,
  "ops": [ /* what you had not seen */ ],
  "hasMore": false,
  "accepted": ["op-id-1", "op-id-2"],
  "rejected": [{ "id": "op-id-3", "reason": "unknown entity kind \"wormhole\"" }],
  "stale": false
}
```

- **`accepted`** — drop these from the queue. An operation already in the log is
  reported accepted, so a retry clears the queue rather than duplicating.
- **`rejected`** — drop these too, and surface them. The server rejects only
  what it will never accept, so retrying would loop forever.
- **`stale: true`** — your cursor predates retained history. Re-snapshot;
  incremental catch-up is not possible.

A stale operation is not rejected. It is applied, loses on whatever fields
already have a later write, and is recorded so other clients converge. Only
malformed operations are refused.

### `GET /sync/socket?token=<session token>`

WebSocket. Authenticated by query string because the browser WebSocket API
cannot set a header.

```jsonc
{ "type": "hello",   "cursor": 2903, "node": "server" }   // on connect
{ "type": "changed", "cursor": 2904, "node": "nf82kd10qp" }  // after a push
```

The notice carries no data. Pull on receipt, and ignore notices whose `node` is
your own — that is the echo of your own push, already applied.

## Client algorithm

```
on start:
  load queue and cursor from local storage
  if cursor == 0: GET /sync/snapshot, replace local state
  sync()

on mutation:
  apply to the local store immediately
  append the op to the queue
  sync()

sync():                       # collapse re-entrant calls into one pass
  while queue is not empty:
    POST /sync with the next batch and the current cursor
    apply returned ops; advance cursor
    remove accepted and rejected ops from the queue
  while hasMore:
    GET /sync/pull?since=cursor
    apply returned ops; advance cursor
```

The optimistic update and the operation that eventually reaches the server are
the same object, so there is no separate pending shape to reconcile.

## Merge rule

For each field in an incoming patch:

```
if the patch's clock > the clock recorded for that field:
    take the value, record the clock
else:
    discard that field
```

For a delete, the row's tombstone moves to the later of the existing one and the
incoming clock. The row is alive when the newest field clock is later than the
tombstone.

Because every stored value is a maximum, replaying a log in any order converges.
That is a property worth testing rather than asserting: `packages/core` shuffles
a forty-operation log across fifty seeds and requires byte-identical results.

## Server-owned fields

`id` and `createdAt` cannot be changed after creation. A patch touching them on
an existing row has those fields rejected while the rest applies.

## Retention

The oplog keeps thirty days. Tombstones are dropped once no retained operation
refers to them. A client offline longer than that re-snapshots, which is what
`stale` signals.
