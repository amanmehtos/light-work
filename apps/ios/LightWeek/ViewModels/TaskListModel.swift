import Foundation
import LightKit

/// The account, as the app needs it.
///
/// Read-then-render against `/sync/snapshot`, not the local-first replica the
/// web client has. That replica is the right shape for this app eventually —
/// the store, the merge rule and the queue, ported from `@light/core` — but it
/// is a great deal of machinery to stand between a task list and the Focus
/// button.
///
/// Writes are optimistic without being local-first: an edit is applied to the
/// rows here and pushed in the same breath, so the screen answers immediately,
/// and a failure says so and reloads rather than leaving a lie on screen. That
/// is honest for a connected app, and it is not a substitute for the queue.
@MainActor
final class TaskListModel: ObservableObject {

    /// One task as the list needs it: the task itself, the name of the project
    /// it sits in, and the focus accumulated against it.
    struct Row: Identifiable {
        var task: LightKit.Task
        var projectName: String?
        var focus: FocusStats

        var id: String { task.id }
    }

    /// Mirrors `ops.focusStatsForTask` in `@light/client-sdk`, including what it
    /// leaves out: breaks are not focus, so `short_break` and `long_break` rows
    /// are not counted even when they carry a `taskId`.
    struct FocusStats {
        var sessions: Int = 0
        var focusedSeconds: Int = 0
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var labels: [Label] = []
    /// On unless it has been switched off. The default lives in one place.
    @Published private(set) var rewardsEnabled = true
    @Published private(set) var isLoading = false
    /// A message, not an error: nothing here is recoverable by the app itself,
    /// and the only useful thing to do with a failure is say it.
    @Published private(set) var loadError: String?
    /// What went wrong with the last write, for an alert.
    @Published var writeError: String?

    private let auth: LightWeekAuth
    private let client: LightWeekClient
    /// Every task, completed included — the list shows the open ones, but
    /// reopening and the Rewards project need the rest.
    private var all: [LightKit.Task] = []
    private var focus: [String: FocusStats] = [:]

    init(auth: LightWeekAuth) {
        self.auth = auth
        self.client = LightWeekClient(baseURL: LightWeek.origin)
    }

    // MARK: - Reading

    func load() async {
        guard auth.isSignedIn else {
            rows = []
            all = []
            projects = []
            return
        }
        isLoading = true
        loadError = nil
        do {
            // Re-set every time: a refresh rotates the access token, and a
            // client still holding the previous one would start answering 401
            // at some unpredictable point after an hour.
            await client.setToken(try await auth.accessToken())
            apply(try await client.snapshot())
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
    }

    private func apply(_ snapshot: LightWeekClient.Snapshot) {
        projects = snapshot.entities.project ?? []
        labels = snapshot.entities.label ?? []
        all = snapshot.entities.task ?? []
        rewardsEnabled = (snapshot.entities.preference ?? [])
            .first { $0.id == Preference.wellKnownId }?.rewardsEnabled ?? true

        focus = [:]
        for session in snapshot.entities.focusSession ?? [] {
            guard let taskId = session.taskId, session.kind == .focus else { continue }
            var stats = focus[taskId] ?? FocusStats()
            stats.sessions += 1
            stats.focusedSeconds += session.focusedSeconds
            focus[taskId] = stats
        }
        rebuild()
    }

    /// With rewards off the project and its contents go quiet together —
    /// leaving the trophies loose in the list would be the opposite of hiding.
    private var hiddenProjectIds: Set<String> {
        rewardsEnabled ? [] : Set(projects.filter(\.isRewards).map(\.id))
    }

    private func rebuild() {
        let names = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0.name) })
        let hidden = hiddenProjectIds
        rows = all
            .filter { !hidden.contains($0.projectId) }
            .sorted(by: Self.inListOrder)
            .map { Row(task: $0, projectName: names[$0.projectId], focus: focus[$0.id] ?? FocusStats()) }
    }

    /// The order the web client shows the same tasks in: by `order`, the key the
    /// person arranged them with there, compared as a plain string just as
    /// `compareOrder` does. Priority and then title only break ties, which is
    /// what the phone used to sort by outright — so a list rearranged in the
    /// browser opened in a different order here.
    ///
    /// Each project numbers its own list, so across projects the keys say little;
    /// the web's All view sorts the same way regardless, and agreeing with it
    /// matters more than inventing a better cross-project rule on one side.
    static func inListOrder(_ a: LightKit.Task, _ b: LightKit.Task) -> Bool {
        if a.order != b.order { return a.order < b.order }
        if a.priority.rawValue != b.priority.rawValue {
            return a.priority.rawValue < b.priority.rawValue
        }
        return a.content.localizedCaseInsensitiveCompare(b.content) == .orderedAscending
    }

    /// The projects worth showing, which is all of them unless the trophies
    /// are switched off.
    var visibleProjects: [Project] {
        projects.filter { rewardsEnabled || !$0.isRewards }
    }

    var openRows: [Row] { rows.filter { !$0.task.isCompleted } }

    /// Most recently finished first, which is the only ordering that makes
    /// sense for a list you look at to remember what you did.
    var completedRows: [Row] {
        rows.filter(\.task.isCompleted)
            .sorted { ($0.task.completedAt ?? "") > ($1.task.completedAt ?? "") }
    }

    /// The open tasks on a given day, split into the timed and the waiting —
    /// which is exactly the shape the day view draws.
    func day(_ day: String) -> (timed: [LightKit.Task], waiting: [LightKit.Task]) {
        let open = rows.map(\.task).filter { !$0.isCompleted }
        let onDay = open.filter { Schedule.day(of: $0.due) == day }
        return (
            timed: onDay.filter { Schedule.minutes(of: $0.due) != nil }
                .sorted { (Schedule.minutes(of: $0.due) ?? 0) < (Schedule.minutes(of: $1.due) ?? 0) },
            // This day's untimed tasks first, then the genuinely unscheduled —
            // both are things you could decide to do today.
            waiting: onDay.filter { Schedule.minutes(of: $0.due) == nil }
                + open.filter { $0.due == nil }
        )
    }

    func labelNames(for task: LightKit.Task) -> [String] {
        let byId = Dictionary(uniqueKeysWithValues: labels.map { ($0.id, $0.name) })
        return task.labelIds.compactMap { byId[$0] }
    }

    // MARK: - Writing

    /// Applies an edit, on screen first and over the wire immediately after.
    func update(_ task: LightKit.Task, _ changes: Operations.TaskChanges) {
        _Concurrency.Task {
            await write { operations in
                let staged = try operations.update(task, changes)
                self.replace(staged.task)
                return staged.ops
            }
        }
    }

    /// Where a task goes when nobody said: the inbox, else the first ordinary
    /// project, else nowhere.
    ///
    /// "The inbox" is the project flagged `isInbox`, picked by lowest id when
    /// two devices each made one before syncing — the same rule `ensureInbox`
    /// uses on the web, so both clients agree which one is the real one. The
    /// trophy cabinet and archived projects are never somewhere to file a task
    /// by hand. Nowhere is possible: only the web makes an inbox, and an
    /// account that has never been opened there has no project at all.
    var defaultProject: Project? {
        let usable = projects.filter { !$0.isArchived && !$0.isRewards }
        if let inbox = usable.filter(\.isInbox).min(by: { $0.id < $1.id }) { return inbox }
        return usable.min(by: { $0.order < $1.order })
    }

    /// Adds a task to the end of a project's list.
    ///
    /// On screen first and over the wire immediately after, like every other
    /// write here. If the push fails the model reloads from the server, which
    /// has never heard of this task, so the row disappears and the alert says
    /// the write failed — rather than leaving a task on screen that exists
    /// nowhere.
    func create(content: String, projectId: String) {
        _Concurrency.Task {
            await write { operations in
                let made = try operations.create(
                    content: content, projectId: projectId, existing: self.all)
                self.all.append(made.task)
                self.rebuild()
                return made.ops
            }
        }
    }

    /// Finishes a task, which is also what files its reward.
    func complete(_ task: LightKit.Task) {
        _Concurrency.Task {
            await write { operations in
                let done = try operations.complete(
                    task, rewardsEnabled: self.rewardsEnabled, projects: self.projects)
                self.replace(done.task)
                if let made = done.createdProject { self.projects.append(made) }
                if let earned = done.earned { self.all.append(earned) }
                self.rebuild()
                return done.ops
            }
        }
    }

    func reopen(_ task: LightKit.Task) {
        _Concurrency.Task {
            await write { operations in
                let open = operations.reopen(task)
                self.replace(open.task)
                return open.ops
            }
        }
    }

    func setRewardsEnabled(_ enabled: Bool) {
        _Concurrency.Task {
            await write { operations in
                self.rewardsEnabled = enabled
                self.rebuild()
                return operations.setRewardsEnabled(enabled)
            }
        }
    }

    private func replace(_ task: LightKit.Task) {
        if let index = all.firstIndex(where: { $0.id == task.id }) { all[index] = task }
        rebuild()
    }

    /// Stages a change on screen, then pushes it.
    ///
    /// On failure the screen is reloaded from the server rather than patched
    /// back: whatever the server has is the truth, and guessing at an undo is
    /// how a client ends up showing something that exists nowhere.
    private func write(_ build: (Operations) throws -> [Op]) async {
        do {
            await client.setToken(try await auth.accessToken())
            let ops = try build(await client.operations())
            guard !ops.isEmpty else { return }
            try await client.push(ops)
        } catch {
            writeError = error.localizedDescription
            await load()
        }
    }
}

extension TaskListModel.FocusStats {
    /// `45m`, `2h`, `1h 20m` — the same rounding the web row uses, so the same
    /// task does not read as a different amount of work on the two screens.
    var humanFocusedTime: String {
        let minutes = Int((Double(focusedSeconds) / 60).rounded())
        if minutes < 60 { return "\(minutes)m" }
        let (hours, rest) = (minutes / 60, minutes % 60)
        return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
    }
}
