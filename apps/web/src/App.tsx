import { useMemo, useState } from "react";
import { compareOrder, type Task } from "@light/core";
import { loadSession, logout, type StoredSession } from "./auth.js";
import { useLightWeek } from "./store-hook.js";
import { AddTask, type ParsedEntry } from "./components/AddTask.js";
import { SignIn } from "./components/SignIn.js";
import { Sidebar, type View } from "./components/Sidebar.js";
import { TaskRow } from "./components/TaskRow.js";

function todayISO(): string {
  // Local calendar day, which is what "Today" has to mean to a user.
  const now = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function App() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());

  if (session === null) {
    return <SignIn onSignedIn={setSession} />;
  }
  return <Workspace session={session} onSignOut={() => setSession(null)} />;
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
      direction === 1
        ? siblings[targetIndex]!.id
        : (siblings[targetIndex - 1]?.id ?? null);

    try {
      commit(ops.reorderTask(task.id, afterId).ops);
    } catch {
      // Tasks in a filtered view are not necessarily siblings; reordering is
      // only meaningful inside a project list.
    }
  }

  const heading =
    view.kind === "project"
      ? (store.get("project", view.projectId)?.name ?? "Project")
      : view.kind === "today"
        ? "Today"
        : view.kind === "upcoming"
          ? "Upcoming"
          : view.kind === "completed"
            ? "Completed"
            : "All tasks";

  return (
    <div className="app">
      <header className="topbar">
        <strong>Light Week</strong>
        <span className={`status ${status.state}`}>
          {status.state === "syncing" && "Syncing…"}
          {status.state === "idle" && (status.pending > 0 ? `${status.pending} queued` : "Synced")}
          {status.state === "offline" && "Offline — changes are saved locally"}
          {status.state === "error" && (status.lastError ?? "Sync problem")}
        </span>
        <span className="spacer" />
        <span className="muted small">{session.user.email}</span>
        <button
          className="link"
          onClick={() => {
            void logout(session.token).then(onSignOut);
          }}
        >
          Sign out
        </button>
      </header>

      {error !== null && (
        <p role="alert" className="banner">
          {error}
        </p>
      )}

      <div className="body">
        <Sidebar store={store} view={view} onSelect={setView} counts={counts} />

        <main className="content">
          <h1>{heading}</h1>

          {view.kind === "project" &&
            store.get("project", view.projectId)?.description !== "" && (
              <p className="project-description">
                {store.get("project", view.projectId)?.description}
              </p>
            )}

          <AddTask onAdd={addTask} disabled={!ready} />

          {!ready ? (
            <p className="muted pad">Loading your tasks…</p>
          ) : visible.length === 0 ? (
            <p className="muted pad">
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
