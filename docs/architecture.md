# Architecture

## The shape of it

```
          iPhone (SwiftUI)     Desktop (Tauri)     Web (React PWA)
                 │                    │                   │
                 └──────────── same sync protocol ────────┘
                                      │
                        ┌─────────────▼─────────────┐
                        │   Worker (Hono)           │
                        │   auth · routing · MCP    │
                        └──────┬─────────────┬──────┘
                               │             │
                   ┌───────────▼──┐   ┌──────▼──────────────┐
                   │ D1           │   │ Durable Object      │
                   │ users        │   │ one per account     │
                   │ sessions     │   │ SQLite: entities    │
                   │ login codes  │   │         oplog       │
                   └──────────────┘   └─────────────────────┘
```

Every client keeps a full local copy of the account and answers reads from it.
Nothing in the interaction path waits on the network.

## Why a Durable Object holds the data, not D1

This is the load-bearing decision, and it is driven by the free tier.

Cloudflare's free plan allows **100,000 D1 row writes per day across the whole
account**, and since September 2026 queries past that limit fail rather than
throttle. A task manager that syncs is write-heavy by nature: a drag-reorder, a
checkbox, a retitle are all writes, and each one also writes an oplog row and
touches indexes. A handful of active users would exhaust the day's allowance on
ordinary editing.

Durable Object storage has a separate allowance. Putting each account's task
graph in its own SQLite-backed Durable Object keeps the hot write path off D1
entirely, and D1 is left doing the one job it is good at here: a small, globally
queryable table of users and sessions.

Three things fall out of that choice for free:

- **Strong consistency per account.** Every write for an account is serialised
  through one object, so the oplog's sequence numbers have no gaps and no races.
  The sync cursor can be a plain integer.
- **Realtime without a message broker.** Every device for an account already
  talks to the same object, so notifying the others is a local broadcast. With
  WebSocket hibernation an idle connection costs nothing.
- **Per-account isolation.** One account cannot read another's rows, because
  they are not in the same database.

The cost is that an account is pinned to one location, so a user who moves
continents sees higher latency until the object migrates. For a local-first app
where reads are local, that affects sync lag rather than interaction speed.

## Conflict resolution

Two devices edit offline. Both come back. Something has to give, and the
interesting question is *what*.

Light Week resolves **per field**, not per row. Each stored row keeps a map of
field name to the hybrid-logical-clock timestamp of the last write to that
field. An incoming change applies field by field, and only where its clock is
later than the clock already recorded.

The difference is concrete: reschedule a task on your phone while your laptop
renames it, and both survive. Row-level resolution would discard one of them.

Deletion follows the same rule rather than being a flag. A row keeps the clock
of the latest delete it has seen, and liveness is *derived* — deleted while the
tombstone is the most recent thing to have happened to the row, alive once an
edit newer than the tombstone arrives. Undo across devices falls out of that
without a dedicated operation.

That derivation is not an aesthetic choice. An earlier version of this code
cleared the tombstone on revival, and whether a row ended up alive depended on
whether the delete or the edit arrived first. A property test replaying a
shuffled log across fifty orderings caught it. Every stored value is now a
maximum over the operations that touched it, so folding a log in any order lands
in the same state.

## Ordering

List order is a **fractional index**: a base-62 fraction held as a string and
compared lexicographically. Inserting between two neighbours mints a key
strictly between them, so moving one task writes exactly one row, and two
devices reordering different items never collide.

Integer positions would mean renumbering everything after the insertion point —
dozens of writes for one drag, and a guaranteed conflict whenever two devices
reorder at once.

Keys lengthen rather than fail when items are repeatedly inserted at the same
spot. Bulk inserts use a divide-and-conquer split that keeps keys short: a
thousand keys in one go stay under ten characters, where naive appending would
reach a thousand.

## Sync

One round trip: push the queue, pull everything since a cursor.

The server assigns the cursor, so clients never trust each other's clocks for
*ordering* — only for conflict *resolution*, which is what the clock is for. A
client that has never synced bootstraps from a snapshot instead of replaying
history, because the oplog is pruned after thirty days and on a busy account is
far larger than the state it produces.

Operations carry client-generated ids, and the oplog has a uniqueness constraint
on them. A retried push is therefore a no-op rather than a duplicate — which
matters, because a request that times out after the server committed it is the
normal case on a phone, not an edge case.

The WebSocket carries only a nudge, never data. Clients still pull. That keeps
one code path for catching up whether a client was connected or not, so a
dropped socket degrades to polling rather than to missing changes.

## Why there are no passwords

Storing a password safely needs a deliberately slow key-derivation function. A
Worker invocation on the free plan gets roughly 10ms of CPU; a defensible PBKDF2
or Argon2 cost is an order of magnitude more. The options were a weak hash or a
different mechanism, so sign-in is by emailed code: the secret is high-entropy
and server-generated, which makes a single SHA-256 exactly the right amount of
hashing, since there is nothing to brute-force.

Session tokens are stored only as hashes, so a database leak does not hand over
live sessions. OAuth providers slot in beside this and are the natural next
addition.

## Light Minute

A `focusSession` is a first-class entity, synced like anything else, carrying
planned and actual seconds, interruption count, outcome, and which app wrote it.

Light Minute writes sessions; Light Week reads them. That is the whole contract,
and it is why the suite is one thing rather than two apps that happen to share a
name: tasks accumulate real attention data, and the MCP server hands that to an
agent so planning can be informed by where attention actually went rather than
where someone guessed it would.
