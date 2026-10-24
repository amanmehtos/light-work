# Hosting on more than one cloud

Cloudflare is the only deployed target today. The point of this document is
that it does not have to stay the only one, and that moving is a known quantity
rather than a rewrite.

## The shape

```
                    @light/server-core
        routing · auth · sync · MCP — no cloud in it
                           │
          ┌────────────────┼────────────────┐
     AccountStore      AuthStore        Realtime        Mailer
          │                │                │              │
   ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐  ┌────┴────┐
   │ Durable Obj │  │ D1          │  │ DO sockets  │  │ Resend  │   Cloudflare
   │ Postgres    │  │ Postgres    │  │ API GW WS   │  │ SES     │   AWS
   │ node:sqlite │  │ node:sqlite │  │ (none)      │  │ dev     │   local
   └─────────────┘  └─────────────┘  └─────────────┘  └─────────┘
```

Four ports, defined in `packages/server-core/src/ports.ts`. Everything above
them is ordinary TypeScript. `services/api/src/adapters.ts` is the only file in
the Cloudflare deployment that knows it is on Cloudflare, and it is about two
hundred lines.

## How this is kept honest

A port is easy to get wrong: you draw an interface around the first backend's
shape and call it an abstraction. Two things guard against that here.

**There are already three implementations.** `MemoryAccountStore` reaches the
same merge decisions through a `Map` that the SQL one reaches through two
tables, and `SqlAccountStore` runs on both a Durable Object's embedded SQLite
and Node's built-in one.

**One suite runs against all of them.** `packages/server-core/test/conformance.test.ts`
is parameterised over the backends, so adding a fourth is a matter of making
that file pass rather than of reading the Cloudflare implementation and hoping.
It has already earned its keep: it caught both backends forgetting their
sequence number after compaction, which would have let a long-offline client
silently miss everything that had been pruned.

## What a backend has to guarantee

Only one thing is subtle. **Writes for one account must be serialised, and the
sequence must never go backwards.**

The sync cursor is a sequence number, and clients pull everything above the one
they hold. If op A is assigned sequence 5 but commits after op B at sequence 6,
a client that pulled at 6 will never see 5 — the change is simply lost, with
nothing to indicate it. A Durable Object gives this for free, because every
write for an account runs in one object, one at a time.

Elsewhere you have to arrange it:

- **Postgres** — take a per-account advisory lock (`pg_advisory_xact_lock`) for
  the duration of the push, or keep a per-account counter row and bump it in
  the same transaction. A bare `SERIAL` is **not** sufficient: it hands out
  numbers before commit, so concurrent pushes can commit out of order.
- **DynamoDB** — a per-account counter item with an atomic `ADD`, and
  conditional writes for the entities.

The second requirement is that the sequence survives compaction. Deriving it
from the log means pruning resets it; `SqlAccountStore` keeps it in `meta` for
exactly this reason, and the conformance suite asserts it.

## AWS

Nothing here is built. This is the plan, written now so that the decision is
informed rather than discovered later.

| Port | Service | Notes |
| --- | --- | --- |
| HTTP | **Lambda** behind a Function URL, via `hono/aws-lambda` | The same `createApp()`. Or App Runner / Fargate if you would rather not think about cold starts. |
| `AuthStore` | **DynamoDB**, single table | Partition on email for users and codes, on the token hash for sessions. TTL attributes expire codes and sessions without a cron. |
| `AccountStore` | **Aurora Serverless v2 (Postgres)** | Reuses `SqlAccountStore` with a Postgres dialect of `SCHEMA` — `BIGSERIAL` for `seq`, `$1` placeholders in the driver — plus the advisory lock above. The alternative, a native DynamoDB implementation, is cheaper and more work. |
| `Realtime` | **API Gateway WebSocket API** + a connections table | `notify` becomes `PostToConnection` for that account's connections. Or omit it entirely: the port allows `upgrade` to be absent, and clients degrade to polling rather than to missing changes. |
| `Mailer` | **SES** | A dozen lines, the same shape as `ResendMailer`. |

The honest trade: Cloudflare's free tier runs this for nothing and gives
serialised per-account writes as a property of the platform. On AWS you pay
from the first request and have to build that serialisation yourself. What AWS
buys is that nothing is capped at 100k requests a day.

### Cost, roughly

Cloudflare: £0 until the free tier's 100k requests a day, then $5/month for the
paid plan, which removes every limit discussed in [deploying.md](deploying.md).

AWS, for a small deployment: Aurora Serverless v2 has a floor of 0.5 ACU
(~$45/month) unless you use its scale-to-zero, DynamoDB on-demand is pennies at
this scale, and Lambda is free at this volume. So the realistic comparison is
$5/month against roughly $50 — which is why Cloudflare is the one that is
built.

## Running it locally with neither

```sh
pnpm --filter @light/server-core test
```

The in-memory and `node:sqlite` adapters run the whole API in plain Node, with
no wrangler, no container and no cloud account. `NodeSqliteAccountStores`
accepts a directory if you want the data to survive a restart.

This is also the fastest way to work on anything above the ports: the
server-core suite runs in about a second, where the Cloudflare one has to boot
workerd.
