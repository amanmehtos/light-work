import { useEffect, useMemo, useRef, useState } from "react";
import { compareOrder, type Op, type Priority, type Section, type Task } from "@light/core";
import { commentsOnProject, searchTasks, type DayScope, type RescheduleTarget } from "@light/client-sdk";
import { loadSession, logout, readConsentRequest, type StoredSession } from "./auth.js";
import { Sky, ThemeToggle, describeLight, useDiurnal, useScrolled } from "./diurnal.js";
import { useLightWeek } from "./store-hook.js";
import { AddTask, type AddRequest } from "./components/AddTask.js";
import { Consent } from "./components/Consent.js";
import { Day } from "./components/Day.js";
import { Preferences } from "./components/Preferences.js";
import { Shortcuts } from "./components/Shortcuts.js";
import { SignIn } from "./components/SignIn.js";
import { AddSection } from "./components/AddSection.js";
import { SectionHeading } from "./components/SectionHeading.js";
import { Sidebar, type View } from "./components/Sidebar.js";
import { TaskEditor } from "./components/TaskEditor.js";
import { TaskComments } from "./components/TaskComments.js";
import { TaskRow } from "./components/TaskRow.js";
import {
  countRows,
  dayLabel,
  groupByDay,
  onPageDays,
  planDayReorder,
  siblingBeside,
  todayRows,
  type DayGroup,
} from "./days.js";
import { dayUnder, headingUnder, neighbour, planReorder, planSectionMove, rowUnder } from "./reorder.js";
import { atDay, dueDay, localDay } from "./schedule.js";
import { isTypingTarget, moveSelection, selectionAfterRemoval, type Shortcut } from "./shortcuts.js";
import { groupBySection, onPage, type Group } from "./sections.js";
import { arrangeSubtasks, descendantIds, flatRows, indexTasks, type Row } from "./subtasks.js";
import { useShortcuts } from "./use-shortcuts.js";

function todayISO(): string {
  // Local calendar day, which is what "Today" has to mean to a user.
  return localDay(new Date());
}

export function App() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());

  // There is no router here, and one path does not justify adding one: an
  // agent's authorization request lands on /oauth/consent and nothing else
  // needs a URL of its own. Read once — the page does not navigate.
  const consent = useMemo(() => {
    if (window.location.pathname !== "/oauth/consent") return undefined;
    return readConsentRequest(window.location.search);
  }, []);

  // Signing in comes first either way: consent is a thing only a known person
  // can give, and SignIn returns here once it has one.
  if (session === null) return <SignIn onSignedIn={setSession} />;

  if (consent !== undefined) {
    return consent === null ? <ConsentUnreadable /> : <Consent request={consent} session={session} />;
  }

  // Diurnal's runtime is installed by importing it in main.tsx; it writes the
  // light to :root by itself, so there is no provider to mount here.
  return <Workspace session={session} onSignOut={() => setSession(null)} />;
}

/** A consent link missing the parameters that say what is being asked for. */
function ConsentUnreadable() {
  return (
    <main className="signin">
      <div className="dn-card dn-card--float signin-card">
        <div className="dn-eyebrow">Light Week</div>
        <h1 className="consent-title">That link is incomplete</h1>
        <p className="dn-prose">
          It does not say which application is asking, or for what. Start the connection again from
          the app you are trying to connect.
        </p>
        <a className="dn-btn dn-btn--block" href="/">
          Go to your tasks
        </a>
      </div>
    </main>
  );
}

function Workspace({
  session,
  onSignOut,
}: {
  session: StoredSession;
  onSignOut: () => void;
}) {
  const { store, ops, status, revision, commit, ready, error } = useLightWeek(session.token, session.user.id);
  const [view, setView] = useState<View>({ kind: "today" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // What the search view is looking for. Kept here, not in the view, so that
  // leaving and coming back (the sidebar, or `/` again) finds the last search.
  const [query, setQuery] = useState("");
  // Where Escape takes you back to from the search view.
  const viewBeforeSearch = useRef<View>({ kind: "today" });
  // A field a shortcut wants focused that is not on the page yet, because the
  // view that holds it has not rendered. Resolved by the effect below.
  const pendingFocus = useRef<"add" | "search" | null>(null);
  // Why the last add did not happen, when it did not. Almost always nothing.
  const [addError, setAddError] = useState<string | null>(null);
  const today = todayISO();

  // Read through `ops` rather than the store so the default — on — lives in
  // one place, next to the rule that acts on it.
  const rewardsEnabled = ops.rewardsEnabled();

  // `revision` is the dependency that matters: the store lives outside React,
  // so this recomputes when it changes rather than when props do.
  const { rows, groups, agenda, visibleRows, sectionIds, counts, labelCounts, inboxProjectId, namedProjects } = useMemo(() => {
    // With rewards off the project and its contents go quiet together —
    // leaving the trophies loose in Today would be the opposite of hiding it.
    const hidden = new Set(
      rewardsEnabled
        ? []
        : store
            .all("project")
            .filter((project) => project.isRewards)
            .map((project) => project.id),
    );

    const all = store.all("task").filter((task) => !hidden.has(task.projectId));
    const index = indexTasks(all);
    const open = all.filter((task) => !task.isCompleted);
    const completed = all.filter((task) => task.isCompleted);
    // Today and Upcoming are arranged once, here, and both what is drawn and what
    // the sidebar counts are read off these: a count that was a separate pass
    // over the same tasks is a count that can drift from its list. Neither
    // depends on which view is showing, because the sidebar shows both at once.
    // Through `dueDay`, not off the front of the string: a timed task stores a
    // UTC instant, and slicing it puts a 23:00 task on the wrong day.
    const day = { today, dayOf: dueDay };
    const todayArranged = todayRows(open, index, day);
    const upcomingGroups = groupByDay(open, index, day);

    // Everything else is a flat list that is arranged around its subtasks and,
    // for a project, its sections.
    let list: Task[] = [];
    switch (view.kind) {
      case "search":
        // Everything the account holds, finished work included — finding the
        // thing you did last month is half of why anyone searches — but not the
        // trophies when rewards are off. The order is `searchTasks`' own, which
        // is the whole point of it being shared with the agent.
        list = searchTasks(store, query).filter((task) => !hidden.has(task.projectId));
        break;
      case "completed":
        // Most recently finished first, which is the only ordering that makes
        // sense for a list you look at to remember what you did.
        list = [...completed].sort((a, b) =>
          (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
        );
        break;
      case "project":
        // Every open task, subtasks included: they are drawn beneath their
        // parents by `arrangeSubtasks`. This used to keep only the roots, which
        // left the sidebar's count for the project larger than what it listed.
        list = open.filter((task) => task.projectId === view.projectId);
        break;
      case "label":
        list = open.filter((task) => task.labelIds.includes(view.labelId));
        break;
      case "today":
      case "upcoming":
      case "day":
        // Today and Upcoming are `todayArranged` and `upcomingGroups`; the day
        // view reads the store itself, because what it needs — timed against
        // untimed — is not a filter of one list.
        break;
    }

    // A project and a label are in the order their tasks were filed in. Today
    // and Upcoming are not: they are in the order of the day (`dayOrder`), which
    // is what lets a person arrange Today without arranging any project.
    if (view.kind === "project" || view.kind === "label") {
      list = [...list].sort((a, b) => compareOrder(a.order, b.order));
    }

    // One rule for subtasks, in every view that is a plan (see `subtasks.ts`):
    // a subtask is drawn beneath its parent when the parent is in the list, and
    // stands alone, naming its parent, when it is not. Completed is a record and
    // search finds the subtask itself, so those two stay flat.
    const flat = view.kind === "search" || view.kind === "completed";
    const agenda: DayGroup[] | null =
      view.kind === "today"
        ? [{ day: today, rows: todayArranged }]
        : view.kind === "upcoming"
          ? upcomingGroups
          : null;
    const rows: Row[] =
      agenda !== null
        ? agenda.flatMap((group) => group.rows)
        : view.kind === "day"
          ? []
          : flat
            ? flatRows(list, index)
            : arrangeSubtasks(list, index);

    // Sections only mean something inside one project.
    const groups: Group[] | null =
      view.kind === "project"
        ? groupBySection(
            rows,
            store.all("section").filter((section) => section.projectId === view.projectId),
          )
        : null;
    const visibleRows = groups !== null ? onPage(groups) : agenda !== null ? onPageDays(agenda) : rows.filter((row) => !row.hidden);

    // What is on the page, in the order it is on the page: this is what `j` and
    // `k` walk, so a row inside a folded parent or a folded section is not
    // selectable — there is nothing there to select. In Upcoming that is down
    // through the days, one after another, as they are drawn.
    const sectionIds = new Set(
      groups === null ? [] : groups.flatMap((group) => (group.section === null ? [] : [group.section.id])),
    );

    const inbox = store.all("project").find((project) => project.isInbox);

    // The length of an arrangement, not of the list it was made from. Today
    // that is the same number, because an arrangement never drops a task — and
    // counting through it is what keeps it true if that ever stops being so.
    // A folded parent hides rows but not tasks: the count does not move when a
    // chevron does, and the parent's `2/5` chip says what is inside. Completed
    // does not nest, so it is the plain length.
    const counted = (tasks: Task[]) => arrangeSubtasks(tasks, index).length;
    const withLabel = new Map<string, number>(
      store.all("label").map((label) => [label.id, counted(open.filter((task) => task.labelIds.includes(label.id)))]),
    );

    return {
      rows,
      groups,
      agenda,
      visibleRows,
      sectionIds,
      counts: {
        today: todayArranged.length,
        upcoming: countRows(upcomingGroups),
        completed: completed.length,
      },
      labelCounts: withLabel,
      // No fall back to "whichever project is first": a task with nowhere said
      // belongs in the inbox, and `addTask` makes one if there is not yet one.
      inboxProjectId: inbox?.id ?? null,
      // What a `#Name` in the add-task line can point at. Built here, with the
      // rest of what depends on the store, so it keeps one identity between
      // revisions and the line is not re-read on every unrelated render. The
      // trophy cabinet is not somewhere to file a task by hand.
      namedProjects: store
        .all("project")
        .filter((project) => !project.isArchived && !project.isRewards)
        .map((project) => ({ id: project.id, name: project.name })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, view, query, today, revision, rewardsEnabled]);

  // The sidebar's Inbox entry and every default destination assume one exists,
  // and nothing but a Todoist import used to make it one. Waits for `ready`
  // and a clean start: ensuring before the first snapshot lands would find an
  // empty store and mint a second inbox next to the account's real one.
  useEffect(() => {
    if (!ready || error !== null) return;
    if (store.all("project").some((project) => project.isInbox)) return;
    commit(ops.ensureInbox().ops);
  }, [ready, error, revision, store, ops, commit]);

  const targetProjectId = view.kind === "project" ? view.projectId : inboxProjectId;

  function addTask(request: AddRequest) {
    // Through `createTaskFromText`, which ends in `createTask`, so a task typed
    // here is made the same way as one an agent makes from the same line. When
    // there is no inbox yet — a task added before the first sync has finished,
    // or while it has failed outright — it returns the real one if it has
    // arrived and makes one only when there is genuinely none, in the same
    // batch as the task so neither can be sent without the other.
    try {
      const created = ops.createTaskFromText(request.text, {
        today,
        ...(targetProjectId !== null ? { defaultProjectId: targetProjectId } : {}),
        now: request.now,
        ignore: request.ignore,
        dueDate: request.dueDate,
      });
      commit(created.ops);
      setAddError(null);
    } catch (error) {
      // Only a time that does not exist (clocks going forward) can land here;
      // the field has already refused an empty title. Said rather than lost.
      setAddError(error instanceof Error ? error.message : "That task could not be added.");
    }
  }

  function complete(task: Task) {
    if (task.isCompleted) {
      commit(ops.uncompleteTask(task.id).ops);
      return;
    }
    // The one place a task is finished from, for the checkbox and for Enter
    // alike, so both earn the reward the same way (`Operations.completeTask`
    // does it) and both say when a repeat could not be read. Without that, a
    // "repeats" phrase the app cannot parse would leave a task quietly done
    // and never coming back.
    const staged = ops.completeTask(task.id, today);
    commit(staged.ops);
    if (!staged.result.recurrenceUnderstood) {
      setAddError(
        `“${task.content}” was marked done, but its repeat could not be read, so it will not come back.`,
      );
    }
  }

  // What is on the page, as tasks. Every reordering below reads this and not the
  // list the view was made from: a row folded away cannot be dropped on, and a
  // row's neighbour is the one beside it on the screen.
  const visible = visibleRows.map((row) => row.task);

  // How Today and Upcoming are arranged is `dayOrder`, and it is written by
  // `reorderInDay`, never by `reorderTask`: a day's list mixes projects, and
  // rearranging it must leave every project's own order as it was. `scopeFor`
  // names the list in the terms the operation reads it — the same ones
  // `days.ts` drew it with, so the drop is placed in the list that is on screen.
  const scopeFor = (day: string): DayScope => ({ day, today, dayOf: dueDay });
  const agendaGroupOf = (taskId: string): DayGroup | undefined =>
    agenda?.find((group) => group.rows.some((row) => row.task.id === taskId));

  function reorderInDay(task: Task, afterId: string | null, day: string) {
    try {
      commit(ops.reorderInDay(task.id, afterId, scopeFor(day)).ops);
    } catch {
      // The task or its neighbour left the day's list since this was drawn —
      // finished, or rescheduled on another device. Nothing was staged.
    }
  }

  function move(task: Task, direction: -1 | 1) {
    if (agenda !== null) {
      // Within the day it is drawn under. The button does not carry a task over
      // a heading: that is a reschedule, and has its own menu.
      const group = agendaGroupOf(task.id);
      const beside = group === undefined ? null : siblingBeside(group.rows, task.id, direction);
      if (group === undefined || beside === null) return;
      const plan = planDayReorder(group.rows, task.id, beside, direction === 1 ? "after" : "before");
      if (plan !== null) reorderInDay(task, plan.afterId, group.day);
      return;
    }

    // The neighbour that shares the row's list — same project, section and
    // parent. With subtasks indented under their parents the row below is as
    // often a child as a sibling, and a child is not somewhere to land after.
    const beside = neighbour(visible, task.id, direction);
    if (beside === null) return;
    const plan = planReorder(visible, task.id, beside, direction === 1 ? "after" : "before");
    if (plan === null) return;
    try {
      commit(ops.reorderTask(task.id, plan.afterId).ops);
    } catch {
      // Tasks in a filtered view are not necessarily siblings; reordering is
      // only meaningful inside a project list.
    }
  }

  // The one-gesture edits behind the row's menus. Each is `Operations` and one
  // commit, so a pick never opens the editor — and each goes through the same
  // methods an agent calls, which is what keeps "next week" one day everywhere.
  function reschedule(task: Task, target: RescheduleTarget) {
    commit(ops.reschedule(task.id, target, today).ops);
  }

  function pickDay(task: Task, day: string) {
    // `atDay` rather than a bare date, so a repeat's phrase survives the pick.
    commit(ops.updateTask(task.id, { due: atDay(day, task.due) }).ops);
  }

  function setPriority(task: Task, priority: Priority) {
    if (priority === task.priority) return;
    commit(ops.updateTask(task.id, { priority }).ops);
  }

  // Dragging a row means something wherever the order is one a person sets: a
  // project's `order`, or a day's `dayOrder` (Today, and each day of Upcoming,
  // where a drop on another day is also a reschedule). Completed is ordered by
  // when each was finished, so a dropped row would have nowhere to be.
  const reorderable =
    view.kind === "project" || view.kind === "label" || view.kind === "today" || view.kind === "upcoming";

  function dropOnDay(task: Task, event: PointerEvent) {
    // Today is one list; in Upcoming the day is whichever one the pointer was
    // let go over, found from the page the same way a section heading is.
    const day = view.kind === "today" ? today : dayUnder(event.clientX, event.clientY);
    if (day === null) return;

    if (view.kind === "upcoming" && dueDay(task.due) !== day) {
      // Another day: that is the whole act, a reschedule. Through `pickDay`, so
      // a time and a repeat's phrase survive the move exactly as they do from
      // the row's date menu. It lands in the day's list by its own key; placing
      // it beside the row it was dropped on is left out, because the key it has
      // may be from the day it left and a second write to correct it is a guess
      // about what the person meant by the drop.
      pickDay(task, day);
      return;
    }

    // The same day: a rearrangement of it. Over a row, beside that row.
    const over = rowUnder(event.clientX, event.clientY);
    const group = agenda?.find((candidate) => candidate.day === day);
    if (over === null || group === undefined) return;
    const plan = planDayReorder(group.rows, task.id, over.id, over.side);
    if (plan !== null) reorderInDay(task, plan.afterId, day);
  }

  function drop(task: Task, event: PointerEvent) {
    if (agenda !== null) {
      dropOnDay(task, event);
      return;
    }
    const over = rowUnder(event.clientX, event.clientY);
    if (over === null) {
      // Not over a row: a section heading is the other thing a task can be let
      // go on. Filing is `moveTask`, which lands it last in the section.
      const heading = headingUnder(event.clientX, event.clientY);
      if (heading !== null) moveToSection(task, heading);
      return;
    }

    const plan = planReorder(visible, task.id, over.id, over.side);
    if (plan !== null) {
      try {
        commit(ops.reorderTask(task.id, plan.afterId).ops);
      } catch {
        // `planReorder` only names siblings, so this is a task that vanished
        // mid-drag; there is nothing to undo.
      }
      return;
    }

    // Not a sibling, but perhaps a row in another section: that is a move into
    // it, positioned beside the row that was dropped on. Both ops in one commit,
    // so the task is never seen in the new section at the wrong place.
    const across = planSectionMove(visible, task.id, over.id, over.side, sectionIds);
    if (across === null) return;
    let moved: Op[];
    try {
      moved = ops.moveTask(task.id, { sectionId: across.sectionId }).ops;
    } catch {
      // A section that vanished mid-drag. `moveTask` checks before it writes,
      // so nothing was staged.
      return;
    }
    // The move is already applied to the local store, so it is committed
    // whatever happens next; a reorder that cannot place it leaves it last in
    // the section, which is where `moveTask` put it.
    let placed: Op[] = [];
    try {
      placed = ops.reorderTask(task.id, across.afterId).ops;
    } catch {
      // The row it was dropped beside went away mid-drag.
    }
    commit([...moved, ...placed]);
  }

  function moveToSection(task: Task, sectionId: string) {
    // A subtask is filed by its parent: drawn beneath it, moved with it. Giving
    // it a section of its own would put it in two places at once.
    if (task.parentId !== null || task.sectionId === sectionId) return;
    try {
      commit(ops.moveTask(task.id, { sectionId }).ops);
    } catch {
      // A section from another project, or one deleted mid-drag.
    }
  }

  /* ---------------------------- structure ---------------------------- */

  function toggleTask(row: Row) {
    const folding = !row.task.isCollapsed;
    commit(ops.setCollapsed("task", row.task.id, folding).ops);
    // A selection that was inside what has just been folded away would be left
    // pointing at nothing on the page. It moves up to the row that was folded.
    if (folding && selectedId !== null && descendantIds(rows, row.task.id).has(selectedId)) {
      setSelectedId(row.task.id);
    }
  }

  function toggleSection(section: Section, group: Group) {
    const folding = !section.isCollapsed;
    commit(ops.setCollapsed("section", section.id, folding).ops);
    if (folding && selectedId !== null && group.rows.some((row) => row.task.id === selectedId)) {
      setSelectedId(null);
    }
  }

  function shiftSection(section: Section, direction: -1 | 1) {
    if (groups === null) return;
    const shown = groups.flatMap((group) => (group.section === null ? [] : [group.section]));
    const at = shown.findIndex((candidate) => candidate.id === section.id);
    const afterId = direction === 1 ? shown[at + 1]?.id : (shown[at - 2]?.id ?? null);
    if (at === -1 || afterId === undefined) return;
    try {
      commit(ops.reorderSection(section.id, afterId).ops);
    } catch {
      // A neighbour deleted on another device since this was drawn.
    }
  }

  function removeSection(section: Section) {
    // The tasks are safe whichever way this goes; what the section alone holds
    // is its notes, and those are the one thing worth a second look.
    if (
      section.description.trim() !== "" &&
      !window.confirm(`Delete “${section.name}”? Its tasks stay; its notes will be lost.`)
    ) {
      return;
    }
    commit(ops.deleteSection(section.id).ops);
  }

  // Every way of changing view goes through here, so that leaving for search
  // always remembers where Escape should come back to.
  function selectView(next: View) {
    if (next.kind === "search" && view.kind !== "search") viewBeforeSearch.current = view;
    setView(next);
  }

  // Focus a field by id, or arrange to once the view that holds it has drawn.
  function focusField(which: "add" | "search") {
    const id = which === "add" ? "add-task-content" : "search-input";
    const field = document.getElementById(id) as HTMLInputElement | null;
    if (field !== null && !field.disabled) {
      field.focus();
      // An existing search is selected, so typing replaces it and Escape and
      // an arrow key both still leave it readable.
      if (which === "search") field.select();
      return;
    }
    pendingFocus.current = which;
  }

  useEffect(() => {
    if (pendingFocus.current === null || !ready) return;
    const which = pendingFocus.current;
    const field = document.getElementById(which === "add" ? "add-task-content" : "search-input") as
      | HTMLInputElement
      | null;
    if (field === null) return;
    pendingFocus.current = null;
    field.focus();
    if (which === "search") field.select();
  }, [view, ready]);

  const visibleIds = visible.map((task) => task.id);
  // Only a selection that is on screen counts. The selection survives a change
  // of view (a click-selected row used to, too), and one that has gone off the
  // list must not be edited or completed by a key press nobody can see land.
  const selectedTask = visible.find((task) => task.id === selectedId) ?? null;

  function select(id: string | null) {
    setSelectedId(id);
    if (id === null) return;
    // `nearest`, so a row already in view does not jump; the sticky masthead
    // is allowed for by `scroll-margin-top` on the row.
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-task-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  // The seven keys. Whether one may fire at all — not while typing, not with a
  // sheet or menu open — has been decided before this is called; see
  // `resolveShortcut`. This only does the thing, and says whether it did.
  useShortcuts((shortcut: Shortcut, event, page) => {
    switch (shortcut) {
      case "quick-add":
        if (!ready) return false;
        // The day and search views have no add line. Today is the neutral
        // place to land: a task made there goes to the inbox, as it would from
        // any view that is not a project.
        if (view.kind === "day" || view.kind === "search") setView({ kind: "today" });
        focusField("add");
        return true;

      case "search":
        selectView({ kind: "search" });
        focusField("search");
        return true;

      case "next":
      case "previous": {
        const target = moveSelection(visibleIds, selectedTask?.id ?? null, shortcut === "next" ? 1 : -1);
        if (target === null) return false;
        // Focus goes back to the page: a button left focused on the row that
        // was just clicked would take the next Enter for itself (see
        // `resolveShortcut`), and Enter is meant to act on this selection.
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest(".tasks") !== null) active.blur();
        select(target);
        return true;
      }

      case "edit":
        if (selectedTask === null) return false;
        setEditingId(selectedTask.id);
        return true;

      case "complete": {
        if (selectedTask === null) return false;
        // The neighbour is chosen before the commit, from the list as it is
        // now. Where the row stays (Completed, or a search, which lists
        // finished work) the selection stays with it.
        const staysListed = view.kind === "search" || view.kind === "completed";
        const next = staysListed ? selectedTask.id : selectionAfterRemoval(visibleIds, selectedTask.id);
        complete(selectedTask);
        select(next);
        return true;
      }

      case "help":
        setShortcutsOpen(true);
        return true;

      case "escape": {
        // A sheet that is open and did not hear the key (focus is outside it).
        // One that did hear it is closing itself and never gets here.
        if (page.sheetOpen) {
          setEditingId(null);
          setPreferencesOpen(false);
          setShortcutsOpen(false);
          return true;
        }
        // Then a field: let go of it, keeping what was typed. This is the one
        // shortcut that acts on a focused field, and it takes nothing from it.
        if (isTypingTarget(event.target)) {
          (event.target as HTMLElement).blur();
          return true;
        }
        if (selectedId !== null) {
          setSelectedId(null);
          return true;
        }
        if (view.kind === "search") {
          setView(viewBeforeSearch.current);
          return true;
        }
        return false;
      }
    }
  });

  const project = view.kind === "project" ? store.get("project", view.projectId) : null;

  // Switching rewards off while looking at the trophies would otherwise leave
  // you on a heading with nothing under it — the project is hidden, but the
  // view still points at it.
  useEffect(() => {
    if (!rewardsEnabled && project !== null && project.isRewards) setView({ kind: "today" });
  }, [rewardsEnabled, project]);
  const heading =
    view.kind === "project"
      ? (project?.name ?? "Project")
      : view.kind === "today"
        ? "Today"
        : view.kind === "day"
          ? "Your day"
          : view.kind === "upcoming"
            ? "Upcoming"
            : view.kind === "completed"
              ? "Completed"
              : view.kind === "search"
                ? "Search"
                : // A label that was deleted on another device while it was the
                  // view: it names itself no more, and the list is empty.
                  `@${store.get("label", view.labelId)?.name ?? "label"}`;

  function addSection(projectId: string, name: string) {
    commit(ops.createSection({ projectId, name }).ops);
  }

  // Move up / move down, offered only where there is somewhere to move to.
  function sectionMoves(section: Section): { onMoveUp?: () => void; onMoveDown?: () => void } {
    const shown = (groups ?? []).flatMap((group) => (group.section === null ? [] : [group.section]));
    const at = shown.findIndex((candidate) => candidate.id === section.id);
    return {
      ...(at > 0 ? { onMoveUp: () => shiftSection(section, -1) } : {}),
      ...(at !== -1 && at < shown.length - 1 ? { onMoveDown: () => shiftSection(section, 1) } : {}),
    };
  }

  // Search and Completed do not nest; every other list does.
  const nests = view.kind !== "search" && view.kind !== "completed";

  function renderRow(row: Row) {
    const task = row.task;
    return (
      <TaskRow
        key={task.id}
        task={task}
        store={store}
        ops={ops}
        today={today}
        parentTitle={row.parentTitle}
        {...(nests
          ? {
              structure: {
                depth: row.depth,
                subtasks: row.subtasks,
                hasChildren: row.hasChildren,
                collapsed: row.collapsed,
                onToggle: () => toggleTask(row),
              },
            }
          : {})}
        selected={selectedId === task.id}
        onComplete={() => complete(task)}
        onSelect={() => setSelectedId(selectedId === task.id ? null : task.id)}
        onEdit={() => setEditingId(task.id)}
        onMoveUp={() => move(task, -1)}
        onMoveDown={() => move(task, 1)}
        onReschedule={(target) => reschedule(task, target)}
        onPickDay={(day) => pickDay(task, day)}
        onPriority={(priority) => setPriority(task, priority)}
        {...(reorderable ? { onDrop: (event: PointerEvent) => drop(task, event) } : {})}
      />
    );
  }

  const light = useDiurnal();
  const scrolled = useScrolled();

  return (
    <div className="app">
      {/* The weather overhead, behind the masthead. It is already shaping every
          shadow on this page; this is the same sky, drawn. */}
      <Sky className="topsky" />
      <header className={`dn-card dn-card--flat topbar${scrolled ? " is-scrolled" : ""}`}>
        {/* The library's own control: it flips sun and moon, and redraws
            itself to match. */}
        <ThemeToggle title={describeLight(light)} />
        <h2 className="topbar-title">Light Week</h2>
        <span className={`dn-badge status ${status.state}`}>
          {status.state === "syncing" && "syncing"}
          {status.state === "idle" && (status.pending > 0 ? `${status.pending} queued` : "Synced")}
          {status.state === "offline" && "offline — saved locally"}
          {status.state === "error" && (status.lastError ?? "sync problem")}
        </span>
        <span className="spacer" />
        <span className="dn-hint">{session.user.email}</span>
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm"
          onClick={() => setPreferencesOpen(true)}
        >
          Preferences
        </button>
        <button
          type="button"
          className="dn-btn dn-btn--ghost dn-btn--sm"
          onClick={() => {
            void logout(session.token).then(onSignOut);
          }}
        >
          Sign out
        </button>
      </header>

      {error !== null && (
        <div role="alert" className="dn-well banner">
          {error}
        </div>
      )}
      {addError !== null && (
        <div role="alert" className="dn-well banner">
          {addError}
        </div>
      )}

      <div className="body">
        <div className="dn-card dn-card--flat sidebar-panel">
          <Sidebar
            store={store}
            view={view}
            onSelect={selectView}
            counts={counts}
            labelCounts={labelCounts}
            today={today}
            rewardsEnabled={rewardsEnabled}
          />
        </div>

        <main className="main-column">
          <h1>{heading}</h1>
          {project !== null && project.description !== "" && (
            <p className="dn-prose project-description">{project.description}</p>
          )}

          {/* Notes left on the project itself, which Todoist allows and the
              importer has always kept — `taskId` null, `projectId` set. Until
              now nothing read them, so they were synced, served and reachable
              by neither a person nor an agent. They sit under the description
              because that is what they are: something about the project rather
              than about any one task in it. */}
          {project !== null && (
            <TaskComments
              key={project.id}
              comments={commentsOnProject(store, project.id)}
              onAdd={(text) => commit(ops.addProjectComment(project.id, text).ops)}
            />
          )}

          {view.kind === "search" ? (
            // Plain text, not `type="search"`: WebKit and Blink clear a search
            // input on Escape, and Escape here is meant to let go of the field
            // and keep what was typed.
            <div className="dn-field search-field">
              <label className="dn-label dn-sr-only" htmlFor="search-input">
                Search tasks
              </label>
              <input
                id="search-input"
                className="dn-input"
                value={query}
                disabled={!ready}
                autoComplete="off"
                placeholder="Search titles, notes and labels"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : (
            view.kind !== "day" && (
              <AddTask onAdd={addTask} disabled={!ready} today={today} projects={namedProjects} />
            )
          )}

          {!ready ? (
            <p className="dn-hint pad">Loading your tasks…</p>
          ) : view.kind === "day" ? (
            <Day
              day={view.day}
              store={store}
              ops={ops}
              commit={commit}
              revision={revision}
              today={today}
              onDayChange={(day) => setView({ kind: "day", day })}
              onOpen={(task) => setEditingId(task.id)}
              onComplete={complete}
            />
          ) : rows.length === 0 && (groups === null || sectionIds.size === 0) ? (
            <>
              <p className="dn-hint pad">
                {view.kind === "search"
                  ? query.trim() === ""
                    ? "Type to search titles, notes and labels."
                    : `Nothing matches “${query.trim()}”.`
                  : view.kind === "today"
                    ? "Nothing due today."
                    : view.kind === "upcoming"
                      ? "Nothing scheduled ahead."
                      : view.kind === "completed"
                        ? "Nothing finished yet."
                        : view.kind === "label"
                          ? "No open tasks carry this label."
                          : "No tasks here yet."}
              </p>
              {view.kind === "project" && <AddSection onAdd={(name) => addSection(view.projectId, name)} />}
            </>
          ) : view.kind === "upcoming" && agenda !== null ? (
            // A heading per day, and every day is a drop target whether or not
            // anything is due on it: see `dayUnder`. The rows in a day are
            // `arrangeSubtasks` of that day's list, so a parent and its subtasks
            // nest within a day and a subtask whose parent is due another day
            // stands alone, naming it — the same rule as every other list.
            agenda.map((group) => {
              const label = dayLabel(group.day, today);
              return (
                <section className="section day-group" key={group.day} data-day={group.day}>
                  <div className="section-heading__bar">
                    <h2 className="section-heading__name">{label.name}</h2>
                    {label.date !== "" && <span className="dn-hint">{label.date}</span>}
                    <span className="dn-badge" title={`${group.rows.length} task${group.rows.length === 1 ? "" : "s"}`}>
                      {group.rows.length}
                    </span>
                  </div>
                  {group.rows.length === 0 ? (
                    <p className="dn-hint day-group__empty">Nothing yet. Drag a task here to schedule it.</p>
                  ) : (
                    <ul className="tasks">{group.rows.filter((row) => !row.hidden).map(renderRow)}</ul>
                  )}
                </section>
              );
            })
          ) : groups === null ? (
            <ul className="tasks">{rows.filter((row) => !row.hidden).map(renderRow)}</ul>
          ) : (
            <>
              {groups.map((group) =>
                group.section === null ? (
                  group.rows.length > 0 && (
                    <ul className="tasks" key="root">
                      {group.rows.filter((row) => !row.hidden).map(renderRow)}
                    </ul>
                  )
                ) : (
                  <section className="section" key={group.section.id}>
                    <SectionHeading
                      section={group.section}
                      count={group.rows.length}
                      onToggle={() => toggleSection(group.section!, group)}
                      onRename={(name) => commit(ops.updateSection(group.section!.id, { name }).ops)}
                      onDelete={() => removeSection(group.section!)}
                      {...sectionMoves(group.section)}
                    />
                    {!group.section.isCollapsed && group.rows.length > 0 && (
                      <ul className="tasks">{group.rows.filter((row) => !row.hidden).map(renderRow)}</ul>
                    )}
                  </section>
                ),
              )}
              {view.kind === "project" && <AddSection onAdd={(name) => addSection(view.projectId, name)} />}
            </>
          )}
        </main>
      </div>

      {/* The sheets stay mounted: the library animates an element it already
          holds, so unmounting one would cost it its closing animation. */}
      <TaskEditor
        task={editingId === null ? null : store.get("task", editingId)}
        store={store}
        ops={ops}
        commit={commit}
        rewardsEnabled={rewardsEnabled}
        onClose={() => setEditingId(null)}
      />
      <Shortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Preferences
        open={preferencesOpen}
        ops={ops}
        commit={commit}
        rewardsEnabled={rewardsEnabled}
        onClose={() => setPreferencesOpen(false)}
      />
    </div>
  );
}
