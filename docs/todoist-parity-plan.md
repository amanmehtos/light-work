# Mirroring Todoist

An implementation plan for Light Week on web and iOS. Verified against `8d0c4aa`.

The ask is "Todoist — the simplicity and everything." Those two things pull
against each other, and this plan treats the first as the constraint and the
second as the backlog. Todoist is not simple because of its feature list; it is
simple because the four things people do a hundred times a day — capture,
complete, reschedule, reprioritise — each cost one gesture. Most of Todoist's
surface area is not where the feeling comes from, and some of it (boards,
karma, the filter query language) is where the feeling went to die.

So the organising principle here: **make the four common acts cost one gesture
on both clients, and surface the model that already exists. Add almost nothing
new.**

---

## 1. Corrections to the brief

The brief's findings are mostly right. Four corrections, one of them material.

**`Operations.createSection` does have a caller.** It is wired as the MCP tool
`create_section` (`packages/mcp/src/tools.ts:666`) and covered in
`packages/client-sdk/test/operations.test.ts:288`. What is true, and is the
point being made, is that **no human-facing client can create or see a
section** — an agent can make one and neither the web app nor the phone will
ever draw it. That is worse than an uncalled method: the feature exists and is
invisible to the person who owns the data.

**`section`, `comment`, `reminder` and `filter` have zero UI — and the importer
already fills three of them.** `docs/migrating-from-todoist.md` shows a real
import producing 38 sections, 31 comments and 2 filters. Those rows sync, merge
and are served in `/sync/snapshot` today, and nothing on either client can
reach them. This is not "schema ahead of UI", it is **data the user already
owns and cannot see.** It raises sections and comments above where a pure
feature-ranking would put them.

**Neither client is actually local-first in deployment.** The brief says iOS is
not and implies web is. The architecture is there on web — `SyncClient` takes a
`QueueStorage` and the file's own header says "the queue is the only state that
has to survive a restart" — but `apps/web/src/store-hook.ts` constructs the
client without one, so it falls back to `MemoryQueueStorage`
(`packages/client-sdk/src/sync.ts:21`). **A web reload with queued ops loses
them.** There is no `localStorage` or IndexedDB anywhere in `client-sdk` or
`core`. One small class closes this, and it belongs in Phase 0 before any phase
adds more write paths.

**A fresh account never gets an inbox.** `Operations.createProject` hardcodes
`isInbox: false` (`operations.ts:85`) and nothing anywhere sets it true except
the Todoist importer (`todoist-import/src/map.ts:276`). `App.tsx:152` creates a
project *named* "Inbox" on first task, with `isInbox: false`. So
`store.all("project").find(p => p.isInbox)` returns nothing on any
natively-created account, and the inbox falls back to "whichever project sorts
first". Inbox-first capture is Todoist's single most load-bearing habit and it
is currently not representable.

Two smaller notes: `.dn-nav` is upstream in `vendor/diurnal-ui/diurnal.css`
now, so `Sidebar.tsx`'s header comment about a local `diurnal-additions.css` is
stale (that file does not exist). And `TaskListModel.rebuild()`
(`apps/ios/.../TaskListModel.swift`) sorts by priority then title, ignoring
`order` entirely — the same account shows a different sequence on the two
clients today.

---

## 2. What Todoist actually gives people, ranked

Ranked by how much of the feeling each one carries, not by how much work it is.

### Tier 1 — this is what "Todoist" means

1. **Quick Add with natural-language parsing.** One text field. `pay rent
   tomorrow 9am p1 @errand #Home`. Capture is near-zero cost, which is the
   whole reason people trust it with everything. Nothing else on this list is
   close.
2. **Inbox-first capture.** You are allowed not to decide where something goes.
   Without an inbox, every capture is also a filing decision, and people stop
   capturing.
3. **Today as home, overdue folded in.** Todoist opens on Today and shows
   overdue above it. Light Week already opens on Today and already folds
   overdue in (`day <= today`), without separating them.
4. **Reschedule from the row.** Click the date, get Today / Tomorrow / Next
   week / Pick a date. The most-used edit after completing something.
5. **Keyboard on web.** `q` quick add, `/` search, `e` edit. This is most of
   why Todoist on a laptop feels faster than its competitors.
6. **Subtasks with indentation and collapse.** A task that is really five
   tasks needs somewhere to put them without inventing a project.
7. **Search.** One field, substring, instant.

### Tier 2 — earns its place

8. **Sections.** Promoted above its natural rank because the import already
   brought 38 of them (see §1).
9. **Priority from the row.** Same argument as reschedule: one gesture, not a
   sheet.
10. **Drag to reorder a list.** Light Week has ↑/↓ buttons today, which is the
    honest placeholder for this.
11. **Labels as views.** The model is complete; this is a sidebar list.
12. **Swipe gestures and context menus on iOS.** The native idiom for the
    one-gesture acts. On iOS this is also where create and delete have to live,
    because neither exists at all right now.
13. **Upcoming as a day-grouped agenda,** rather than one flat sorted list.

### Tier 3 — later, or in reduced form

14. **Comments.** Promoted off the floor only because 31 of them are already
    imported and unreachable. For a single-user app `Task.description` does the
    job of a note; a thread does not earn authoring UI yet.
15. **Per-day ordering.** `Task.dayOrder` exists, is null everywhere, and is
    exactly what Todoist uses so that reordering Today does not scramble the
    project. Pure surfacing.

### Rejected, with the reason

Not silently dropped — each of these is something "mirror Todoist" could
reasonably be expected to include.

- **Board view.** `Project.view` already has `"board"`. A kanban is a second
  layout of the same rows, and Light Week already has a better second layout
  that no competitor has: the Day. Adding a third would make the app busier for
  a view that is mostly useful to teams, and this is a single-user app.
- **Calendar / month view.** `Project.view` has `"calendar"` too. The Day view
  *is* the calendar, at the only resolution where a task has a time. A month
  grid of 30 cells holding three words each is a worse Upcoming.
- **Filter query language.** `Filter` carries Todoist's query syntax verbatim
  and the importer brings the strings in. Implementing the DSL (`@label &
  !#Project & 7 days`) is a parser, an evaluator, a syntax error surface and a
  help page. Almost everyone uses it for three queries that Tier-2 label and
  priority views cover directly. Keep the rows, do not build the engine.
- **Reminders.** `Reminder` is modelled fully, including location triggers.
  Delivering one needs APNs, a web push service worker, a server-side scheduler
  and a timezone story. That is an infrastructure project, not a UI phase, and
  a reminder that silently fails to fire is worse than no reminders.
- **Multi-select and bulk edit.** The clearest example of a feature that adds
  capability and subtracts simplicity: a selection mode changes what every
  click means. Revisit only if someone is seen wanting it.
- **Collaboration, sharing, assignees.** `assigneeId` and `addedById` exist and
  are documented as "set once sharing lands". Sharing is a different product.
- **Karma, streaks, productivity trends.** Light Week already answered this,
  better, with Rewards. Two motivation systems would cancel out.
- **Templates, activity history, file attachments.** `Attachment` is modelled
  for import fidelity. None of these are in the four common acts.

---

## 3. Colour: monochrome stays, and hue means one thing

**Decision: Light Week does not adopt Todoist's palette. Diurnal stays
monochrome, and hue stays reserved for a single meaning — a plan that has
slipped.**

This is the biggest design call in the work, so here is the whole argument.

**Todoist's colour is not the simplicity being asked for.** It is sediment.
Priority flags are red/orange/blue because a flat list of identical rows had no
other way to shout; project dots are coloured because a sidebar of twenty
identical names needed marks. Both are solutions to problems Diurnal does not
have. Diurnal has three signalling axes already in use and already working:
**contrast, weight and elevation.**

**The codebase already made this call, and already made it twice.** The header
of `apps/web/src/components/TaskRow.tsx` says it outright: priority is carried
by badge weight — solid for urgent, outline for high, plain for medium, nothing
for none — and "an earlier version of this file used red, amber and blue, which
is precisely what the library exists not to do." `TaskListView.swift` matches
it badge for badge and additionally sets `.tint(Color.dnInk)` so that SwiftUI's
default blue never leaks in. Reversing this would mean rewriting both clients'
visual language to import a palette neither needs.

**There is exactly one hue in Diurnal, and it already has a job.**
`--dn-danger` is `#ae3b31` in light and `#e0796e` in dark
(`vendor/diurnal-ui/diurnal.css:28,54`), and `.dn-badge--danger` is already how
`TaskRow` draws an overdue date. That is the correct and only use of hue in this
system: **not category, not rank — failure.** A p1 task that is on schedule is
not a problem and does not get red. A p4 task three weeks overdue is. This is
strictly more informative than Todoist, where p1 is red whether or not anything
is wrong, so red stops meaning anything.

**`Project.color` and `Label.color` stay in the model and get rendered without
hue.** Do not delete the fields: they are import fidelity, Todoist's twenty
named colours are already landing in them, and a future non-Diurnal client may
want them. Render a project's colour as a **monochrome mark** — map each of the
twenty names to one of about four greys crossed with filled/hollow, by
luminance — so an imported account keeps visually distinguishable project dots
without a single hue entering the page. Someone who coloured `Work` charcoal
and `Home` yellow still sees two different marks. (Shared mapping, so web and
iOS agree: put it next to `COLORS` in `packages/core/src/entities.ts`.)

**The escape hatch, named once and then closed.** If this turns out to be
wrong, the smallest correct version is a single `Preference` field —
`colorAccents` — that re-enables `Project.color` and `Label.color` as real hue
on project dots and label chips, and changes nothing else. `Preference` is an
entity and new fields on it need no migration (`sql.ts` merges per field), so
this is a one-line schema change available at any time. **I recommend not
building it in these phases.** Build it only if, after Phase 5, the owner looks
at a monochrome imported account and genuinely misses the colour. Priority and
overdue must never be wired to it under any circumstances.

---

## 4. Audit: what exists today, per client

### Shared (`core`, `client-sdk`, `mcp`) — far ahead of both clients

| | State |
| --- | --- |
| Model | Essentially complete Todoist parity: priority, due vs deadline, duration, labels, sections, subtasks via `parentId`, comments, reminders, filters, per-day order. |
| `Operations` | createProject/Section/Label, createTask, updateTask, complete (with recurrence + rewards), uncomplete, deleteTask (cascades subtasks), deleteProject, moveTask, reorderTask, addLabel, removeLabel, rewards, focus. |
| Recurrence | A real implementation of Todoist's phrase language including `every!`, with catch-up. Returns `null` rather than guessing. |
| Missing | Any date/`#project` natural-language parser. No `updateSection`/`deleteSection`/`reorderSection`. No `updateProject`. No `updateLabel`/`deleteLabel`. No comment operations. No shared search helper. No durable queue storage implementation. No `ensureInbox`. |
| MCP | 18 tools, including `create_section` and a `search` filter on `list_tasks` that neither client has. |

### Web — the reference client, and still missing Tier 1

Have: Today / Day / Upcoming / All / Completed views; nested project tree in
the sidebar; add-task with `p1` / `@label` / `//notes` and a separate date
field; a full task editor sheet (priority, project, due date + time, deadline,
estimate, labels, reward, delete); the Day view with real pointer
drag-and-drop, overlap columns, a now-line and drag-to-unschedule; rewards; the
Light Minute focus handoff; monochrome priority badges and danger-coloured
overdue.

Missing: natural-language dates; an Inbox view (the inbox appears only as a
project in the tree, and on a native account is not flagged at all); any
keyboard shortcut; search; sections; subtask rendering (project view filters
them out with `parentId === null`, every other view shows them as top-level
rows — so the same subtask is either hidden or misrepresented depending on
which view you are in); drag-to-reorder in a list (↑/↓ buttons stand in);
reschedule or reprioritise without opening the sheet; labels as views;
day-grouped Upcoming; comments; durable offline queue.

### iOS — considerably further behind than a feature list suggests

Have: a signed-in task list sorted urgent-first; a Day view that is a genuine
port of the web's, drag and all; a task editor sheet matching the web's fields;
preferences; rewards; the focus handoff; `LightKit` with `Order` proven
byte-identical to `keyBetween`.

Missing, and this is the headline: **iOS cannot create a task.**
`LightKit.Operations` has exactly four writes — `update`, `complete`, `reopen`,
`setRewardsEnabled`. There is no create, no delete, no move, no reorder, no
label editing (the editor's Labels section is a read-only badge row). There is
no view concept at all: no Today, no Upcoming, no Inbox, no projects — one flat
list of every open task on the account, under a title that says "This week".
`LightWeekClient.Snapshot.Entities` decodes only `project`, `task`, `label`,
`focusSession`, `preference` — so sections, comments, reminders and filters are
dropped on the floor at the network boundary. `LightKit.Task` has no `dayOrder`
and no `isCollapsed`. And per §1, the list sort ignores `order`.

---

## 5. The plan

Each phase ships on its own. Shared work is listed separately in every phase
because it also lands in the MCP tools, which means the agent gets it for free.

### Phase 0 — Fix the foundations (half a phase, do it first)

Nothing here is a feature. All of it is load-bearing for what follows, and two
items are live bugs.

**Shared**
- `packages/client-sdk/src/operations.ts`: add `ensureInbox()` — returns the
  `isInbox` project, creating it (named "Inbox", `isInbox: true`) if absent.
  Give `createProject` an `isInbox` input. Guard: only ever one.
- `packages/client-sdk/src/sync.ts`: add `WebQueueStorage implements
  QueueStorage`, backed by `localStorage` under one key, try/catch around both
  accessors, falling back to memory. The interface already exists; this is the
  missing implementation.
- `packages/core/src/entities.ts`: add the `COLORS` → monochrome mark mapping
  from §3 (`colorMark(color): { tone: 1|2|3|4; filled: boolean }`).

**Web**
- `store-hook.ts`: pass `new WebQueueStorage()` to `SyncClient`.
- `App.tsx`: call `ops.ensureInbox()` instead of `createProject({name:
  "Inbox"})`; add an **Inbox** nav item above Today in `Sidebar.tsx`, driven by
  `isInbox`.
- Subtask consistency: in Today / Upcoming / All, hide a task whose parent is
  also in the same list (it will be drawn under its parent in Phase 4); show an
  orphaned-in-this-view subtask with its parent's title as a hint line. One
  rule, applied in the `useMemo` in `App.tsx`.

**iOS**
- `TaskListModel.rebuild()`: sort by `compareOrder`-equivalent on `order`,
  falling back to priority — so the two clients agree.

**Done looks like**: a brand-new account has exactly one project, named Inbox,
with `isInbox: true`. Queue an edit with devtools offline, reload, go online —
the edit arrives. No task appears twice in any view, and no subtask appears as
a root task.

**Verify** — browser: sign in fresh at `127.0.0.1:5173`, confirm the sidebar
shows Inbox and that `store.all("project")` has one row with `isInbox: true`;
DevTools → Network → Offline, add two tasks, reload, back online, confirm both
land on the server (check `/sync/snapshot`). Simulator: build and confirm the
open list order matches the web's for the same account, side by side.

---

### Phase 1 — Quick Add (the one that matters most)

**Shared**
- New file `packages/client-sdk/src/parse.ts`. One parser, used by web, iOS and
  the agent. Recognises `#Project`, `@label`, `p1`–`p4`, `//notes`, and dates:
  `today`, `tomorrow`, `tonight`, weekday names, `next week`, `in 3 days`,
  `jan 5` / `5 jan`, `9am` / `17:30`, and recurrence phrases, which it hands
  straight to the existing `parseRecurrence` rather than reimplementing.
- It returns **annotated** output: the cleaned content plus, for each match,
  the token span and what it became. The UI needs the spans to draw chips; this
  is what makes the parse visible instead of a guess (see Risk 1).
- Deliberately conservative: anything ambiguous is left in the title as text.
  No date is ever inferred from a bare number.
- `Operations.createTaskFromText(text, { defaultProjectId })` — resolves
  `#Project` against existing projects by name (case-insensitive), falls back
  to the inbox, mints labels through the existing `createLabel` path.
- `packages/mcp/src/tools.ts`: new tool `create_task_from_text`. Do **not**
  change `create_task`'s schema — agents depend on the structured form.
- Tests: `packages/client-sdk/test/parse.test.ts`, a table of phrases, in the
  idiom of `recurrence.test.ts`. This file is the contract.

**Web**
- `AddTask.tsx`: one field. Below it, live chips for what was parsed — `Home`,
  `tomorrow 09:00`, `p1`, `@errand` — each dismissable, which un-parses that
  token back into plain text. Keep the explicit date input as an override; it
  is the answer when the parser is wrong, and removing it would be a
  regression.
- `parseEntry` in `AddTask.tsx` is deleted and its tests
  (`apps/web/test/parse-entry.test.ts`) move to the shared parser's suite.

**iOS**
- `LightKit/Operations.swift`: add `create(...)` returning the task and its
  ops — the Swift twin of `createTask`, including order-at-end via the existing
  `Order`. Port the parser too, or (preferred for Phase 1) ship iOS capture
  **without** natural language: a content field plus the existing editor
  controls. A second parser implementation is a second place for the date rules
  to drift, and one parser in two languages is the kind of duplication the
  rewards rule already demonstrates the cost of.
- `TaskListModel`: `create(content:projectId:)`, optimistic then push.
- `TaskListView`: a compose field pinned above the list, or a `+` toolbar item
  opening the editor in create mode.

**Done looks like**: `pay rent tomorrow 9am p1 @errand #Home` typed into the
web field shows four chips and creates exactly that task. The same string
through `create_task_from_text` creates an identical task. **An iPhone can add
a task.**

**Verify** — browser: the phrase above, then open the editor and confirm every
field; type `read chapter 3` and confirm `3` did not become a date; type
`standup every weekday 9am` and confirm it is recurring and completing it
advances a day. Simulator: add a task, pull to refresh, confirm it survives;
kill the app mid-add with the network off and confirm the alert says the write
failed rather than leaving a phantom row.

---

### Phase 2 — One gesture per act

Collapses the common edits out of the sheet. No schema, no new entities.

**Shared**
- Nothing new is required — `updateTask`, `deleteTask` and `reorderTask` cover
  all of it. Add one small helper, `Operations.reschedule(id, "today" |
  "tomorrow" | "next-week" | "weekend" | null)`, so web, iOS and an agent round
  the same way (and so "next week" means the same Monday everywhere).
- `LightKit/Operations.swift`: add `delete(_ task:)` (cascading subtasks, same
  rule as `deleteTask`) and `move(_:to:)`.

**Web**
- The date badge in `TaskRow.tsx` becomes a button opening a small menu:
  Today / Tomorrow / This weekend / Next week / No date / Pick a date. Priority
  badge likewise → p1–p4. Both commit through `updateTask`.
- Drag to reorder in a list. **Extract** the `Draggable` component out of
  `Day.tsx` into its own module, unchanged in behaviour, and reuse it for task
  rows. Give it a teardown (see Risk 2). `reorderTask` already exists and is
  already wired to the ↑/↓ buttons — keep those buttons; they are the keyboard
  and screen-reader path for the same act.

**iOS**
- `.swipeActions`: leading = complete/reopen, trailing = reschedule + delete.
- `.contextMenu` on the row: Priority, Reschedule, Move to project, Delete.
- **Not** drag-to-reorder on iOS in this phase. See Risk 3.

**Done looks like**: on both clients, rescheduling and reprioritising never
opens a sheet. On web a list can be dragged into order. The Day view behaves
exactly as it did.

**Verify** — browser: reschedule from the row and confirm the badge updates
without a sheet; drag a row in a project list, reload, confirm the order held;
then go to the Day view and drag a block between hours and into the rail, and
confirm both still work and the checkbox inside a dragged block still ticks.
Simulator: swipe-complete a task with a reward set and confirm the reward
appears in Rewards (this proves the swipe went through `Operations.complete`);
long-press for the context menu; swipe-delete a task with subtasks and confirm
the children go too.

---

### Phase 3 — Keyboard and search (web)

Web-only by design: these are laptop affordances, and the iOS equivalents
(Phase 2's gestures) are already in.

**Shared**
- `packages/client-sdk`: `searchTasks(store, query)` — substring over
  `content`, `description` and label names, ranked title-first. Rewire MCP's
  `list_tasks` `search` filter to call it, so the agent and the UI cannot
  disagree about what a search means.

**Web**
- A small, fixed shortcut set, and no more: `q` quick add (focus the field from
  anywhere), `/` search, `e` edit the selected row, `j`/`k` move the selection,
  `Enter` complete the selection, `Esc` close whatever is open, `?` a sheet
  listing them with `.dn-kbd`.
- A hard rule: no shortcut fires while an input, textarea or
  `contenteditable` has focus, or while a sheet is open.
- A `{ kind: "search" }` view in `Sidebar.tsx`'s `View` union, rendering the
  same `TaskRow` list.

**Done looks like**: `?` lists seven shortcuts and they all work. `/` then three
letters finds a task. Typing `q` inside the add field types the letter q.

**Verify** — browser: walk every shortcut; focus the add field and type
`quick jerky` and confirm nothing was triggered; open the editor and confirm
`j`/`k` do not move the selection behind it; search a term that only appears in
a description and confirm a hit.

---

### Phase 4 — Sections and subtasks as structure

The phase that makes the imported account whole.

**Shared**
- `Operations`: `updateSection`, `deleteSection` (move its tasks to the project
  root rather than deleting them — a section is a heading, not a container of
  record), `reorderSection`, and `setCollapsed(kind, id, collapsed)` for both
  `Section.isCollapsed` and `Task.isCollapsed`, both of which already exist in
  the model and are already synced.
- MCP: `list_sections`, `update_section`, `delete_section`. `move_task` already
  takes `sectionId`.
- `LightKit/Model.swift`: add a `Section` struct; add `section` to
  `LightWeekClient.Snapshot.Entities`. Add `dayOrder` and `isCollapsed` to
  `LightKit.Task` (extra JSON keys are already ignored by `Codable`, so this is
  additive and safe in both directions).

**Web**
- Project view renders section headings in `order`, each with its tasks, plus an
  "Add section" control and a collapse chevron. Tasks with `sectionId: null`
  sit above the first heading, as in Todoist.
- Subtasks render indented under their parent with a collapse chevron and a
  `2/5` count. This retires the Phase 0 hiding rule.
- Dragging (Phase 2's `Draggable`) can drop a task onto a section heading →
  `moveTask({ sectionId })`.

**iOS**
- Read-only section headings in a project list; subtask indentation and
  collapse. Section authoring stays on web this phase.

**Done looks like**: the imported account's 38 sections are visible, tasks can
be moved between them, and a collapsed section is still collapsed on the other
device.

**Verify** — browser: create a section, drag a task into it, collapse it,
reload, then open the same account on the simulator and confirm the same
section is collapsed there. Confirm deleting a section leaves its tasks in the
project. Agent: `list_sections` then `move_task` with a `sectionId` and confirm
the web reflects it live over the socket.

---

### Phase 5 — Views that match the mental model

**Shared**
- `Operations.reorderInDay(id, afterId, day)` writing `Task.dayOrder` — the
  field exists, is null everywhere, and is precisely Todoist's mechanism for
  letting Today's order differ from the project's.
- MCP: expose `dayOrder` in `formatTask` and accept it in `reorder_tasks`.

**Web**
- Upcoming becomes a day-grouped agenda: a heading per day, tasks under it,
  drag a task from one day's heading to another to reschedule it. Reuse the
  Day view's landing logic rather than reimplementing hit-testing.
- Today and Upcoming order by `dayOrder` when set, `order` otherwise.
- Labels in the sidebar as views. Nav becomes: Inbox, Today, Day, Upcoming,
  Search, Labels, Completed, Projects. That is the ceiling — nothing else gets
  added to the sidebar.

**iOS**
- Views at last: Inbox / Today / Upcoming / Day / Done, and a project list.
  Replace the three-way `Surface` picker with a navigation list, which is also
  what makes room for the project tree.
- Upcoming is read-only-grouped on iOS this phase. Drag-between-days stays web
  only (Risk 3).

**Done looks like**: dragging a task from Thursday to Friday in Upcoming
changes its due date. Reordering Today does not touch any project's order. The
phone has a Today.

**Verify** — browser: reorder Today, then open the task's project and confirm
that list is untouched; drag between two days and confirm the due date in the
editor. Simulator: switch between Inbox / Today / Upcoming and confirm the
counts match the web's for the same account exactly.

---

### Phase 6 — Comments, read-mostly (optional, lowest)

Only here because 31 of them are already imported and unreachable.

**Shared**: `Operations.addComment` / `deleteComment`; MCP `list_comments`,
`add_comment`. `LightKit`: a `Comment` struct and the snapshot entity.

**Web**: a comment thread at the bottom of the task editor sheet, with an add
field. **iOS**: read-only.

**Done looks like**: every imported comment is reachable from its task. **Verify**:
open a task that the import gave a comment and read it on both clients.

---

## 6. Schema: what needs adding, and what is merely hidden

**Needs a schema addition: nothing in Phases 0–6.** That is the headline
finding of this audit. Every feature above is either surfacing a field that
already exists or adding an operation over existing fields.

Surfacing only, no model change:

| Feature | Already in the model |
| --- | --- |
| Inbox-first capture | `Project.isInbox` (never set — a write-path bug, not a schema gap) |
| Sections | the whole `Section` entity, plus `Task.sectionId` |
| Subtasks, collapse | `Task.parentId`, `Task.isCollapsed`, `Section.isCollapsed` |
| Per-day ordering | `Task.dayOrder` |
| Recurrence from Quick Add | `Due.text`, `Due.isRecurring`, and `parseRecurrence` |
| Deadline vs due | `Task.deadline` and `Task.due`, both already in both editors |
| Labels as views | `Label`, `Label.isFavorite` |
| Comments | the whole `Comment` entity |
| Project marks | `Project.color` + the new monochrome mapping |

Available and deliberately left unsurfaced: `Reminder` (needs push infra),
`Filter` (needs the query DSL), `Project.view` `board`/`calendar`,
`Task.assigneeId`/`addedById`, `Attachment`.

If a later phase does want a field, the cheap shape is a new field on
`Preference` — `sql.ts` stores JSON and merges per field, so it costs no
migration. A *new entity kind* costs one line in `ENTITY_KINDS` and nothing
else, but nothing in this plan needs one.

---

## 7. Feature → client → phase

| Feature | Web | iOS | Shared | Phase |
| --- | --- | --- | --- | --- |
| Inbox exists and is a view | yes | P5 | `ensureInbox` | 0 |
| Durable offline queue | yes | — (not local-first) | `WebQueueStorage` | 0 |
| Subtask double-render fixed | yes | — | — | 0 |
| List order agrees across clients | — | yes | — | 0 |
| Quick Add, natural language | yes | P2+ | parser + MCP tool | 1 |
| Create a task at all | have | **yes** | `LightKit.create` | 1 |
| Reschedule from the row | yes | yes | `reschedule` | 2 |
| Priority from the row | yes | yes | — | 2 |
| Delete a task | have | yes | `LightKit.delete` | 2 |
| Drag to reorder a list | yes | **no** (Risk 3) | — | 2 |
| Swipe actions, context menu | — | yes | — | 2 |
| Keyboard shortcuts | yes | — | — | 3 |
| Search | yes | later | `searchTasks` | 3 |
| Sections | author | read | section ops + MCP | 4 |
| Subtask indent + collapse | yes | yes | `setCollapsed` | 4 |
| Upcoming, day-grouped | yes + drag | read | — | 5 |
| `dayOrder` | yes | read | `reorderInDay` | 5 |
| Labels as views | yes | P5 nav | — | 5 |
| Comments | read + write | read | comment ops + MCP | 6 |
| Board / calendar / filters / reminders / multi-select / sharing | no | no | no | rejected, §2 |

---

## 8. Regression risks

### The three biggest

**1. The Quick Add parser guessing wrong — and corrupting agent writes too.**
`AddTask.tsx`'s header states the current position outright: dates are a
separate field "because guessing wrong about a date is worse than one extra
tab." Phase 1 overrules that, and must earn it. Mitigations, all of them
required: the parser returns spans and the UI draws a dismissable chip per
match, so the parse is *visible before submit* rather than discovered later;
anything ambiguous stays as title text; no date is ever inferred from a bare
number; the explicit date input stays as the override. And because the same
parser backs `create_task_from_text`, a parser bug writes bad dates through the
agent where no one is watching chips at all — so `parse.test.ts` is the
contract, written first, as a phrase table. Keep `create_task`'s structured
schema untouched so agents have a parser-free path.

**2. Reusing the Day view's drag machinery will break the Day view if done
carelessly.** `Day.tsx` is the most intricate working code in the repo and
Phase 2 reaches straight into it. Three specific traps, all visible in the
file: `Draggable` mounts `drag()` in a `useEffect` with an empty dep array and
returns nothing, with the comment "`drag` has no teardown, and the element dies
with its listeners" — true for day blocks that live as long as the view, false
for task rows that mount and unmount on every filter change, where handlers
will stack on reused nodes. The `Check` component survives inside a draggable
only because of `stopPropagation` on `pointerdown`; any new in-row control
(the reschedule menu, the priority menu) needs the same treatment or the drag
helper will swallow its click. And `drag()`'s `onTap` is what opens the editor,
so a 6px threshold change turns taps into drags. Mitigation: extract
`Draggable` byte-for-byte first, add a teardown, and land that extraction as
its own commit with the Day view unchanged, before any row uses it. Keep
`layOut` and `landingAt` untouched in Phase 2. `apps/web/test/lay-out.test.ts`
and the e2e runs must stay green.

**3. iOS is not local-first, and every phase here widens that hole.** Today iOS
has four write paths; this plan takes it to roughly a dozen. Each is
`TaskListModel.write` — optimistic, push immediately, and on failure show an
alert and reload the whole snapshot from the server. That is honest for create,
complete, edit, delete and reschedule: a failed write snaps one row back and
says so. It is **not** honest for reorder or drag-between-days, where a failed
push visibly reshuffles a list the user just arranged, and where two devices
reordering offline is exactly the case fractional indexing exists to handle —
in a queue the phone does not have. **Recommendation: do not port the
local-first replica in these phases, and in exchange keep reorder and
drag-between-days off iOS until it exists** (Phases 2 and 5 are written that
way). Porting `LightStore` + `applyOp` + the queue to Swift is its own piece of
work; `Order` is already proven byte-identical, which is the hardest part
already done, but it is not a sub-task of a UI phase.

### Specific things that already work and must keep working

- **The Day view, drag and all.** See Risk 2. It is also the thing most likely
  to be quietly broken by a CSS change to `.dn-card` or `.task`.
- **The task editor sheet.** `Sheet` in `diurnal.tsx` stays mounted when closed
  and syncs React back from the library via a `MutationObserver` on `hidden`,
  because `fluid.mjs` closes itself on scrim, Escape and flick without telling
  React. Phase 2's reschedule menu must **not** be a second `.dn-sheet` layered
  over the first — two mounted sheets racing on Escape will fight. Use a
  popover/menu, or route everything through the one sheet.
- **The rewards rule.** It exists twice: `Operations.earnReward` in TypeScript
  and `Operations.complete` in Swift, deliberately, and tested against the same
  cases. Every new completion path — iOS swipe-to-complete, a keyboard `Enter`,
  a bulk action if one ever lands — must go through those methods and not write
  `isCompleted` directly, or rewards silently stop being earned on that path.
  This is the single easiest regression to introduce and the hardest to notice.
- **The Light Minute focus handoff.** `focusLink` in `TaskRow.tsx` builds the
  URL by hand, not with `URLSearchParams`, because the Swift side reads it with
  `URLComponents` and a `+` would survive as a literal. Its format is pinned by
  `apps/web/test/focus-link.test.ts`. `plannedSeconds` reads `task.duration`,
  so Phase 2's row menus must not offer a duration edit that produces a
  `unit: "day"` the link then silently defaults away.
- **The MCP tools.** They drive the same `Operations`, which is the leverage
  this whole plan rests on — but it cuts both ways: `Operations.deleteSection`
  moving tasks to the project root is a behaviour an agent will see too.
  `packages/mcp/test/tools.test.ts` and
  `packages/server-core/test/conformance.test.ts` are the guard. Add tools;
  avoid changing existing tool schemas.
- **Recurrence.** `completeTask` reschedules rather than completing, and
  reports `recurrenceUnderstood: false` instead of guessing. Any new completion
  surface must surface that flag, or an unparsable repeat vanishes silently.
- **The consent screen.** `App.tsx` has no router and reads
  `/oauth/consent` once from `window.location`. Phase 3's search view and
  Phase 5's nav must stay in the `View` union and not introduce real routing
  without accounting for that path.
- **Monochrome.** Any new badge, chip or dot must come from `.dn-*` classes and
  Diurnal's tokens. The one permitted hue is `--dn-danger`, for overdue.

---

## 9. Sequencing, in one line each

0. Fix the inbox, the queue and the double-rendered subtasks.
1. Quick Add on web; **a create button on iOS**.
2. Reschedule and reprioritise from the row; drag to reorder on web; swipes and
   context menus on iOS.
3. Keyboard and search on web.
4. Sections and subtask structure.
5. Inbox / Today / Upcoming on iOS; day-grouped Upcoming and `dayOrder` on web;
   labels as views.
6. Comments, if wanted.

Phases 0–2 are where the Todoist feeling actually arrives. If only two phases
ever ship, ship those.
