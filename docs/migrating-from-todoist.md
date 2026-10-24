# Moving in from Todoist

Two routes. Take the first unless you would rather not mint a token.

## 1. Full export, via an API token

Highest fidelity. Gets reminders, day order, assignees and completed history.

Token: Todoist → Settings → Integrations → Developer → API token.

```sh
# Look before you leap: writes nothing anywhere, just reports.
pnpm --filter @light/todoist-import exec tsx src/cli.ts \
  --token <todoist-token> --out ops.json

# Then push it.
pnpm --filter @light/todoist-import exec tsx src/cli.ts \
  --in ops.json --push https://<your-api> --auth <light-week-session-token>
```

The dry run prints what it found and what it could not carry:

```
Imported from sync-api:
  project        50
  section        38
  task          412
  label           6
  comment        31
  filter          2
  (of which 118 already completed)

Created 2 label(s) found only on tasks: EMS, TNIGA

4 warning(s):
  label_minted_from_task       2
  missing_task_parent          1
  orphan_comment               1

Not carried over: project.is_shared and collaborators, item.note_count,
user settings, karma and goals, activity history
```

## 2. From the MCP connector's output

No token needed, lower fidelity — no reminders, no day order. Save what the
connector returns and pass `--connector`:

```sh
pnpm --filter @light/todoist-import exec tsx src/cli.ts \
  --in connector-export.json --connector --out ops.json
```

## What the mapping gets right

**Priority is inverted.** Todoist's API uses 4 for urgent; Light Week stores the
p1..p4 a user sees, so 4 becomes 1. Getting this backwards flips every priority
in the account silently, which is why it is a named function with its own tests.

**Due and deadline stay separate.** Todoist has both and they mean different
things. Collapsing them loses real information, so the schema keeps both.

**Recurrence keeps the phrase.** `every saturday at 9am` cannot be rebuilt from
a resolved date, so the text is stored and re-read when the task is completed.

**Labels are minted from task names.** This one bites. A *shared* label applied
to a task has no label record of its own — in the account this was built
against, `EMS` and `TNIGA` were used on tasks but existed nowhere in the label
list. An importer that only reads the label table drops those tags silently.

**Order is positional, not literal.** Todoist's `child_order` values are often
sparse or duplicated in an old account, so items are sorted by `(order, id)` and
then assigned fresh fractional keys. Two sections sharing `section_order: 1`
come out in a stable, distinct order rather than colliding.

**Dangling references are repaired, not dropped.** A subtask whose parent is
archived is promoted to the project root. A task pointing at a vanished section
is re-rooted. Both are warned about. A task whose *project* is missing is
skipped, because there is nowhere to put it.

Nesting is preserved to any depth, section descriptions are preserved verbatim
(several hold the actual plan in markdown), and emoji in names survive.

## Re-running it

Ids are derived from the Todoist id, so a second run produces the same ids and
lands as no-op upserts rather than a second copy of your account. The first run
is always a dry run, so this matters.

## What is not carried over

- Project sharing and collaborators — sharing is not implemented yet
- Karma, goals and activity history
- Note counts, which are recomputed from the comments themselves

## A caveat worth stating

The Sync API field names here were taken from the commonly documented shape plus
what the MCP connector returns for a real account; `developer.todoist.com` was
unreachable from the environment this was written in, so the item schema has not
been checked against the official reference. The readers are deliberately
tolerant — unknown fields are reported rather than fatal — but a confirmation
pass against the published schema is worth doing before trusting a large
migration. Run the dry run first and read the counts.
