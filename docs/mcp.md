# The built-in MCP server

Light Week exposes its own data to an AI agent over the Model Context Protocol,
in two forms. Both serve the same tools.

## Remote (hosted)

`POST https://<your-api>/mcp`, authenticated with the same bearer session token
as the rest of the API. Stateless: each request catches up from the account,
runs the call, and discards everything.

In Claude Code:

```sh
claude mcp add --transport http light-week https://<your-api>/mcp \
  --header "Authorization: Bearer <session token>"
```

## Local (stdio)

For an agent on your own machine. Talks to the API over HTTP and keeps a warm
local copy, refreshed every thirty seconds.

```sh
LIGHT_WEEK_URL=https://<your-api> \
LIGHT_WEEK_TOKEN=<session token> \
LIGHT_WEEK_TZ=Asia/Bangkok \
  npx light-week-mcp
```

It refuses to start on a bad token rather than failing on the first tool call.

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
without confirmation and prompt on the rest. `delete_task` cascades and is not
recoverable through the API — it is annotated non-idempotent for that reason.

The endpoint authenticates with a session token today. Proper OAuth, which lets
a user grant an agent scoped access without handing over a token at all, is the
next piece of work here.
