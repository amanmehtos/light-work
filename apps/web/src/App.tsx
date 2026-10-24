import { useMemo, useState } from "react";
import { compareOrder, type Task } from "@light/core";
import { loadSession, logout, type StoredSession } from "./auth.js";
import { ThemeToggle, describeLight, useDiurnal } from "./diurnal.js";
import { useLightWeek } from "./store-hook.js";
import { AddTask, type ParsedEntry } from "./components/AddTask.js";
import { SignIn } from "./components/SignIn.js";
import { Sidebar, type View } from "./components/Sidebar.js";
import { TaskRow } from "./components/TaskRow.js";

function todayISO(): string {
  // Local calendar day, which is what "Today" has to mean to a user.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function App() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());

  // Diurnal's runtime is installed by importing it in main.tsx; it writes the
  // light to :root by itself, so there is no provider to mount here.
  return session === null ? (
    <SignIn onSignedIn={setSession} />
  ) : (
    <Workspace session={session} onSignOut={() => setSession(null)} />
  );
}

function Workspace({
  session,
  onSignOut,
}: {
  session: StoredSession;
  onSignOut: () => void;
}) {
  const { store, ops, status, revision, commit, ready, error } = useLightWeek(session.token);
  const [view, setView] = useState<View>({ kind: "today" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const today = todayISO();

  // `revision` is the dependency that matters: the store lives outside React,
  // so this recomputes when it changes rather than when props do.
  const { visible, counts, inboxProjectId } = useMemo(() => {
    const all = store.all("task");
    const open = all.filter((task) => !task.isCompleted);
    const completed = all.filter((task) => task.isCompleted);
    const dueBy = (task: Task) => task.due?.date.slice(0, 10) ?? null;

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
    }

    if (view.kind !== "upcoming" && view.kind !== "completed") {
      list = [...list].sort((a, b) => compareOrder(a.order, b.order));
    }

    const inbox = store.all("project").find((project) => project.isInbox);
    const firstProject = store.ordered("project")[0];

    return {
      visible: list,
      counts: {
        today: todayTasks.length,
        upcoming: upcoming.length,
        all: open.length,
        completed: completed.length,
      },
      inboxProjectId: inbox?.id ?? firstProject?.id ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, view, today, revision]);

  const targetProjectId = view.kind === "project" ? view.projectId : inboxProjectId;

  function addTask(entry: ParsedEntry, dueDate: string | null) {
    let projectId = targetProjectId;

    // A brand-new account has no projects at all, so the first task creates
    // somewhere to put itself rather than failing.
    const staged = [];
    if (projectId === null) {
      const created = ops.createProject({ name: "Inbox" });
      staged.push(...created.ops);
      projectId = created.result.id;
    }

    const task = ops.createTask({
      projectId,
      content: entry.content,
      ...(entry.description !== "" ? { description: entry.description } : {}),
      priority: entry.priority,
      ...(entry.labels.length > 0 ? { labelNames: entry.labels } : {}),
      due:
        dueDate === null
          ? null
          : { date: dueDate, hasTime: false, text: null, timezone: null, isRecurring: false },
    });
    staged.push(...task.ops);
    commit(staged);
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

  const project = view.kind === "project" ? store.get("project", view.projectId) : null;
  const heading =
    view.kind === "project"
      ? (project?.name ?? "Project")
      : view.kind === "today"
        ? "Today"
        : view.kind === "upcoming"
          ? "Upcoming"
          : view.kind === "completed"
            ? "Completed"
            : "All tasks";

  const light = useDiurnal();

  return (
    <div className="app">
      <header className="dn-card dn-card--flat topbar" data-dn-scroll-edge>
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

      <div className="body">
        <div className="dn-card dn-card--flat sidebar-panel">
          <Sidebar store={store} view={view} onSelect={setView} counts={counts} />
        </div>

        <main className="main-column">
          <h1>{heading}</h1>
          {project !== null && project.description !== "" && (
            <p className="dn-prose project-description">{project.description}</p>
          )}

          <AddTask onAdd={addTask} disabled={!ready} />

          {!ready ? (
            <p className="dn-hint pad">Loading your tasks…</p>
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
                  selected={selectedId === task.id}
                  onComplete={() => complete(task)}
                  onSelect={() => setSelectedId(selectedId === task.id ? null : task.id)}
                  onMoveUp={() => move(task, -1)}
                  onMoveDown={() => move(task, 1)}
                />
              ))}
            </ul>
          )}
        </main>
      </div>
    </div>
  );
}
