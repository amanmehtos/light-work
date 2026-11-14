import { useEffect, useMemo, useState } from "react";
import { compareOrder, type Priority, type Task } from "@light/core";
import type { RescheduleTarget } from "@light/client-sdk";
import { loadSession, logout, readConsentRequest, type StoredSession } from "./auth.js";
import { Sky, ThemeToggle, describeLight, useDiurnal, useScrolled } from "./diurnal.js";
import { useLightWeek } from "./store-hook.js";
import { AddTask, type AddRequest } from "./components/AddTask.js";
import { Consent } from "./components/Consent.js";
import { Day } from "./components/Day.js";
import { Preferences } from "./components/Preferences.js";
import { SignIn } from "./components/SignIn.js";
import { Sidebar, type View } from "./components/Sidebar.js";
import { TaskEditor } from "./components/TaskEditor.js";
import { TaskRow } from "./components/TaskRow.js";
import { planReorder, rowUnder } from "./reorder.js";
import { atDay, dueDay, localDay } from "./schedule.js";
import { foldSubtasks } from "./subtasks.js";

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
  // Why the last add did not happen, when it did not. Almost always nothing.
  const [addError, setAddError] = useState<string | null>(null);
  const today = todayISO();

  // Read through `ops` rather than the store so the default — on — lives in
  // one place, next to the rule that acts on it.
  const rewardsEnabled = ops.rewardsEnabled();

  // `revision` is the dependency that matters: the store lives outside React,
  // so this recomputes when it changes rather than when props do.
  const { visible, parentTitles, counts, inboxProjectId, namedProjects } = useMemo(() => {
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
    const open = all.filter((task) => !task.isCompleted);
    const completed = all.filter((task) => task.isCompleted);
    // Through `dueDay`, not off the front of the string: a timed task stores
    // a UTC instant, and slicing it puts a 23:00 task on the wrong day.
    const dueBy = (task: Task) => dueDay(task.due);

    const todayTasks = open.filter((task) => {
      const day = dueBy(task);
      return day !== null && day <= today;
    });
    const upcoming = open.filter((task) => {
      const day = dueBy(task);
      return day !== null && day > today;
    });

    let list: Task[];
    switch (view.kind) {
      case "today":
        list = todayTasks;
        break;
      case "upcoming":
        list = [...upcoming].sort((a, b) => (dueBy(a) ?? "").localeCompare(dueBy(b) ?? ""));
        break;
      case "all":
        list = open;
        break;
      case "completed":
        // Most recently finished first, which is the only ordering that makes
        // sense for a list you look at to remember what you did.
        list = [...completed].sort((a, b) =>
          (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
        );
        break;
      case "project":
        list = open.filter((task) => task.projectId === view.projectId && task.parentId === null);
        break;
      case "day":
        // The day view reads the store itself, because what it needs — timed
        // against untimed — is not a filter of one list.
        list = [];
        break;
    }

    if (view.kind !== "upcoming" && view.kind !== "completed" && view.kind !== "day") {
      list = [...list].sort((a, b) => compareOrder(a.order, b.order));
    }

    // The three views that are filters over everything share one rule for
    // subtasks; the others are already scoped (a project lists its roots) or are
    // a record rather than a plan (Completed).
    const fold = (tasks: Task[]) => foldSubtasks(tasks, (id) => store.get("task", id)).tasks;

    let parentTitles = new Map<string, string>();
    if (view.kind === "today" || view.kind === "upcoming" || view.kind === "all") {
      const folded = foldSubtasks(list, (id) => store.get("task", id));
      list = folded.tasks;
      parentTitles = folded.parentTitles;
    }

    const inbox = store.all("project").find((project) => project.isInbox);

    return {
      visible: list,
      parentTitles,
      counts: {
        // Counted after folding, and each list folded on its own, because the
        // sidebar shows all four at once while only one of them is the view
        // being rendered. Counting the unfolded list instead would put "5"
        // beside three rows the moment an account had a subtask — which reads
        // as the app having lost two tasks, not as a subtlety about nesting.
        // Completed is not folded, so it is not counted that way either.
        today: fold(todayTasks).length,
        upcoming: fold(upcoming).length,
        all: fold(open).length,
        completed: completed.length,
      },
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
  }, [store, view, today, revision, rewardsEnabled]);

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
    const staged = task.isCompleted ? ops.uncompleteTask(task.id) : ops.completeTask(task.id, today);
    commit(staged.ops);
  }

  function move(task: Task, direction: -1 | 1) {
    const siblings = visible;
    const index = siblings.findIndex((candidate) => candidate.id === task.id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= siblings.length) return;

    // Moving down means landing after the sibling currently below; moving up
    // means landing after the one two places above, or at the head.
    const afterId =
      direction === 1 ? siblings[targetIndex]!.id : (siblings[targetIndex - 1]?.id ?? null);

    try {
      commit(ops.reorderTask(task.id, afterId).ops);
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

  // Dragging a row only means something in a list that is ordered by `order`.
  // Upcoming is ordered by date and Completed by when each was finished, so a
  // dropped row would have nowhere to be; they keep the buttons alone.
  const reorderable = view.kind === "project" || view.kind === "today" || view.kind === "all";

  function drop(task: Task, event: PointerEvent) {
    const over = rowUnder(event.clientX, event.clientY);
    if (over === null) return;
    const plan = planReorder(visible, task.id, over.id, over.side);
    if (plan === null) return;
    try {
      commit(ops.reorderTask(task.id, plan.afterId).ops);
    } catch {
      // `planReorder` only names siblings, so this is a task that vanished
      // mid-drag; there is nothing to undo.
    }
  }

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
              : "All tasks";

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
            onSelect={setView}
            counts={counts}
            today={today}
            rewardsEnabled={rewardsEnabled}
          />
        </div>

        <main className="main-column">
          <h1>{heading}</h1>
          {project !== null && project.description !== "" && (
            <p className="dn-prose project-description">{project.description}</p>
          )}

          {view.kind !== "day" && (
            <AddTask onAdd={addTask} disabled={!ready} today={today} projects={namedProjects} />
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
          ) : visible.length === 0 ? (
            <p className="dn-hint pad">
              {view.kind === "today"
                ? "Nothing due today."
                : view.kind === "upcoming"
                  ? "Nothing scheduled ahead."
                  : view.kind === "completed"
                    ? "Nothing finished yet."
                    : "No tasks here yet."}
            </p>
          ) : (
            <ul className="tasks">
              {visible.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  store={store}
                  ops={ops}
                  today={today}
                  parentTitle={parentTitles.get(task.id) ?? null}
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
              ))}
            </ul>
          )}
        </main>
      </div>

      {/* Both sheets stay mounted: the library animates an element it already
          holds, so unmounting one would cost it its closing animation. */}
      <TaskEditor
        task={editingId === null ? null : store.get("task", editingId)}
        store={store}
        ops={ops}
        commit={commit}
        rewardsEnabled={rewardsEnabled}
        onClose={() => setEditingId(null)}
      />
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
