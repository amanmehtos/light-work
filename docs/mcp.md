# The built-in MCP server

Light Week exposes its own data to an AI agent over the Model Context Protocol,
in two forms. Both serve the same tools.

## Remote (hosted)

`POST https://light-week.amanmehtos.workers.dev/mcp`. Stateless: each request catches up
from the account, runs the call, and discards everything.

Give the URL to the client and let it do the rest — in Claude Desktop that is
**Settings → Connectors → Add custom connector**, and the same URL works in
claude.ai, Cursor and Zed. The server registers the client itself (RFC 7591),
sends you to a consent screen in the browser, and hands back a token scoped to
what you allowed. Nothing is copied and pasted.

```
https://light-week.amanmehtos.workers.dev/mcp
```

### What you are granting

| Scope | What it allows |
| --- | --- |
| `mcp:read` | The six reading tools: projects, tasks, labels, the week plan, focus stats |
| `mcp:write` | The ten that change things, including the two deletes, which cascade |

These two scopes govern this endpoint only. The first-party iOS apps use a
separate family, `tasks:read` / `tasks:write`, against the sync API — see
[apps.md](apps.md). An `mcp:*` grant is refused there and a `tasks:*` grant gets
no tools here: one server, two surfaces, told apart by scope.

A read-only grant does not get the writing tools **registered at all**, rather
than getting them and being refused. An agent that cannot see `delete_task`
will not plan around it; one that can see it will try, fail, and then have to
explain itself to whoever is waiting.

The consent screen names the client, the scopes in plain words, and the address
the code is about to be sent to — which is the one detail that decides whether
any of it is safe.

### Revoking

Signing out revokes every grant along with the session. There is no screen yet
for revoking one agent and keeping another; that is the next piece of work here.

### Claude Code, or anything that can set a header

Claude Code takes a header directly, so it can skip the handshake and use a
session token — the one the web app keeps in `localStorage` under
`light-week.token`:

```sh
claude mcp add --transport http light-week https://light-week.amanmehtos.workers.dev/mcp \
  --header "Authorization: Bearer <session token>"
```

That path still works and is not deprecated, but it is the blunter instrument: a
session token carries no scope and no audience, so it is the whole account.
Prefer OAuth where the client supports it.

## Local (stdio)

For an agent on your own machine. Talks to the API over HTTP and keeps a warm
local copy, refreshed every thirty seconds. STDIO transports take credentials
from the environment rather than doing OAuth, which is what the MCP spec asks
for.

```sh
LIGHT_WEEK_URL=https://light-week.amanmehtos.workers.dev \
LIGHT_WEEK_TOKEN=<session token> \
LIGHT_WEEK_TZ=Asia/Bangkok \
  light-week-mcp
```

It refuses to start on a bad token rather than failing on the first tool call.

> **This one does not run yet.** `@light/mcp` is a private workspace package: it
> is not published to npm, so `npx light-week-mcp` fails, its `bin` points at a
> `.ts` file, and there is no build script to turn it into something `node` can
> execute. Either publish it or add a bundle step first. The hosted transport
> above has no such problem.

## Tools

| Tool | Reads | What it is for |
| --- | :-: | --- |
| `list_projects` | ✓ | Projects with full nested paths and open-task counts |
| `list_tasks` | ✓ | Filter by project, section, label, priority, due window, text |
| `get_task` | ✓ | One task, its subtasks, and its accumulated focus time |
| `list_labels` | ✓ | Labels with open-task counts |
| `get_week_plan` | ✓ | The whole picture for a window, in one call |
| `get_focus_stats` | ✓ | Where attention actually went |
| `create_task` | | |
| `update_task` | | Sparse — omitted fields are untouched |
| `complete_task` | | Reschedules instead, when the task recurs |
| `delete_task` | | Cascades to subtasks |
| `move_task` | | Between projects, sections, parents |
| `reorder_tasks` | | Full desired order of a sibling list |
| `create_project` | | |
| `delete_project` | | Sections and tasks go too; child projects only with `recursive` |
| `create_section` | | |
| `log_focus_session` | | Backfill a session that happened away from the timer |

### `get_week_plan` is the one that matters

It returns, for a window:

- overdue tasks
- each day's scheduled work
- deadlines falling inside the window
- **unscheduled p1/p2 tasks** — invisible to a due-date query, and usually the
  most useful thing to surface when asked to fill a week
- focus time already spent, per task

The alternative is an agent making a dozen calls and assembling the same view
itself, badly.

### Two things the server tells the agent up front

The server's instructions state both, because both are easy to get wrong:

**Priority runs 1 to 4 with 1 being urgent**, matching the p1..p4 a user reads.
Todoist's API inverts this internally; Light Week stores the user-facing order.

**Due and deadline are different.** Due is when you intend to work on it;
deadline is when it is actually owed. A task can be due Monday with a deadline
three weeks out. Agents are told to prefer moving a due date.

### Recurrence is validated, not guessed

`create_task` and `update_task` reject a recurrence phrase they cannot parse,
and the error lists the supported forms. An agent that writes `every 3rd
thursday of the month` is told so immediately rather than discovering later that
the repeat silently stopped.

`complete_task` returns `rescheduled: true|false` and warns when a recurrence
existed but could not be read.

## Safety

Read-only tools are annotated `readOnlyHint: true`, so a host can run them
without confirmation and prompt on the rest. `delete_task` and `delete_project`
cascade and are not recoverable through the API — both are annotated
non-idempotent for that reason. `delete_project` refuses the inbox outright,
and refuses a project with children unless `recursive` is passed, so a one-word
mistake cannot take a whole subtree.

The endpoint speaks OAuth 2.1: PKCE (S256 only — OAuth 2.1 drops `plain`),
dynamic client registration, rotating refresh tokens, and RFC 9728 metadata at
`/.well-known/oauth-protected-resource` so a client can find all of that from a
401 alone. Tokens are bound to an audience (RFC 8707) and checked against it on
every request, so a token minted for another resource is refused here.

Access and refresh tokens are stored only as a SHA-256 hash, like sessions and
sign-in codes: a database leak does not hand over live credentials.
