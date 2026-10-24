import { useMemo, useState } from "react";
import { compareOrder, type Task } from "@light/core";
import {
  Button,
  Chip,
  DiurnalProvider,
  Heading,
  Panel,
  Stack,
  SunDial,
  Surface,
  Text,
} from "@light/diurnal";
import { loadSession, logout, type StoredSession } from "./auth.js";
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

  return (
    // The sun drives the whole page: shadow direction, shadow length, and
    // whether the palette is the daytime or the night one.
    <DiurnalProvider>
      <Surface>
        {session === null ? (
          <SignIn onSignedIn={setSession} />
        ) : (
          <Workspace session={session} onSignOut={() => setSession(null)} />
        )}
      </Surface>
    </DiurnalProvider>
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

  const statusTone = status.state === "offline" || status.state === "error" ? "danger" : "neutral";

  return (
    <div className="app">
      <Panel level={1.2} flush className="topbar" role="banner">
        <SunDial />
        <Heading level={2}>Light Week</Heading>
        <Chip tone={statusTone} className={`status ${status.state}`}>
          {status.state === "syncing" && "Syncing…"}
          {status.state === "idle" && (status.pending > 0 ? `${status.pending} queued` : "Synced")}
          {status.state === "offline" && "Offline — changes are saved locally"}
          {status.state === "error" && (status.lastError ?? "Sync problem")}
        </Chip>
        <span className="spacer" />
        <Text tone="soft" size="small">
          {session.user.email}
        </Text>
        <Button
          variant="ghost"
          onClick={() => {
            void logout(session.token).then(onSignOut);
          }}
        >
          Sign out
        </Button>
      </Panel>

      {error !== null && (
        <Panel inset role="alert" className="banner">
          <Text size="small">{error}</Text>
        </Panel>
      )}

      <div className="body">
        <Panel level={0.8} flush className="sidebar-panel">
          <Sidebar store={store} view={view} onSelect={setView} counts={counts} />
        </Panel>

        <main className="main-column">
          <Stack gap={4}>
            <Stack gap={1}>
              <Heading level={1}>{heading}</Heading>
              {project !== null && project.description !== "" && (
                <Text tone="soft" as="p" className="project-description">
                  {project.description}
                </Text>
              )}
            </Stack>

            <AddTask onAdd={addTask} disabled={!ready} />

            {!ready ? (
              <Text tone="soft" className="pad">
                Loading your tasks…
              </Text>
            ) : visible.length === 0 ? (
              <Text tone="soft" className="pad">
                {view.kind === "today"
                  ? "Nothing due today."
                  : view.kind === "upcoming"
                    ? "Nothing scheduled ahead."
                    : view.kind === "completed"
                      ? "Nothing finished yet."
                      : "No tasks here yet."}
              </Text>
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
          </Stack>
        </main>
      </div>
    </div>
  );
}
