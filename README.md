# Light Week

A task manager with Todoist parity, built local-first, open source, and designed so
that focus is a first-class citizen rather than an afterthought.

Light Week is part of **Light Suite**:

| App | Role | Status |
| --- | --- | --- |
| **Light Minute** | Pomodoro / intentional focus timer | iPhone, shipped (separate repo, moving in) |
| **Light Week** | Tasks, projects, planning | this repo |
| **Light Year** | Long-range review | planned |

The thing that makes Light Week different from every other Todoist clone: when you
focus on a task in Light Minute, that session is logged **against the task**. Over
time each task accumulates real attention data, and the built-in MCP server exposes
it to an AI agent so it can plan your week against where your attention actually
goes, not where you guessed it would.

## Design

- **Local-first.** Every client keeps a full local copy and works offline. Sync is a
  background reconciliation, never a blocking page load.
- **Field-level last-write-wins** over a hybrid logical clock, so two devices editing
  different fields of the same task both win.
- **Fractional indexing** for ordering, so reordering on two devices never fights.
- **One SQLite Durable Object per user** is the authoritative store. D1 holds only
  global auth rows. This keeps the hot write path off D1's free-tier row-write quota
  and gives each account strong consistency and a free WebSocket fanout.
- **The cloud sits behind four ports.** Cloudflare is the only deployed target, but
  the server itself has no knowledge of it — one conformance suite runs against
  three backends, and the whole API runs in plain Node with no cloud account.
- **The interface is lit by the time of day.** [Diurnal](packages/diurnal) treats the
  page as a surface and derives every shadow from where the sun actually is.

## Documentation

- [Architecture](docs/architecture.md) — why a Durable Object per account, how
  conflicts resolve, and what the free tier forced
- [Sync protocol](docs/sync-protocol.md) — the wire format
- [The MCP server](docs/mcp.md) — the tools an agent gets
- [Hosting on more than one cloud](docs/hosting.md) — the ports, and the AWS plan
- [Diurnal](packages/diurnal/README.md) — the UI kit
- [Moving in from Todoist](docs/migrating-from-todoist.md)
- [Deploying](docs/deploying.md)

## Layout

| Path | What it is | State |
| --- | --- | --- |
| `packages/core` | Domain model, hybrid logical clock, fractional index, merge rule | 36 tests |
| `packages/client-sdk` | Local store, sync client, recurrence, domain operations | 34 tests |
| `packages/todoist-import` | Todoist → Light Week migration, with a CLI | 49 tests |
| `packages/mcp` | MCP tools, stdio server, session | 30 tests |
| `packages/diurnal` | The UI kit: light from the time of day | 34 tests |
| `packages/server-core` | The server, with the cloud behind four ports | 50 tests, no cloud needed |
| `services/api` | Cloudflare adapters: Durable Object, D1, sockets | 34 tests in workerd |
| `apps/web` | React PWA, built on Diurnal | 24 end-to-end checks in a browser |
| `apps/desktop` | Tauri shell | written, never compiled |
| `apps/ios` | LightKit — the Light Minute bridge | written, never compiled |

## Status

The backend, sync engine, importer, MCP server and web app work and are tested.
The API tests run in workerd against a real Durable Object, real D1 and real
WebSockets; the web tests drive a real browser against a real server.

Not done yet, in rough order of what is missing most:

- **The iPhone app.** `apps/ios` holds only LightKit, the shared contract, and
  none of it has been compiled. See its README.
- **The desktop build.** The Tauri configuration is written but has never been
  run.
- **AWS.** The ports are in place and the mapping is written up, but no AWS
  adapter is built — see [docs/hosting.md](docs/hosting.md).
- **Sharing.** Projects are single-user; the schema has the fields but nothing
  uses them.
- **OAuth for MCP.** The endpoint takes a session token today, which means
  handing an agent a credential rather than granting it scoped access.
- **Richer views.** Filters are imported and stored, but the web app does not
  yet run them; there is no board view and no drag-and-drop.

## Running it

```sh
pnpm install
pnpm -r test

# the API
cd services/api
npx wrangler d1 migrations apply light-week-auth --local
echo 'DEV_LOGIN=1' > .dev.vars      # returns sign-in codes instead of emailing
npx wrangler dev

# the web app, in another terminal
pnpm --filter @light/web dev
```

`DEV_LOGIN=1` hands the sign-in code back in the response, so there is no mail
provider to configure before you can use it. See
[docs/deploying.md](docs/deploying.md) for the real thing.

## License

MIT — see [LICENSE](LICENSE).
