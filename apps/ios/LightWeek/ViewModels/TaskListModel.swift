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

    /// One row of the list as it is drawn: the task and what it needs, beside
    /// where it sits among its subtasks.
    struct Entry: Identifiable {
        var row: Row
        var outline: Outline.Row

        var id: String { row.id }
    }

    /// A run of entries under one heading, or the ones above the first.
    ///
    /// The heading is a section when the list is one project's, or a day when it
    /// is Upcoming: a view has one grouping axis, chosen by the view, and never
    /// both (see `Agenda`). Both are nil for the unheaded rows, and for a list
    /// with no headings at all.
    struct Block: Identifiable {
        var section: LightKit.Section?
        /// `YYYY-MM-DD`, for an Upcoming day.
        var day: String?
        var entries: [Entry]

        var id: String { section?.id ?? day ?? "" }
    }

    /// What the home list says about each place, each the length of the rows
    /// that place renders — see `Agenda` — so the badge and the list cannot
    /// disagree, and the web's sidebar says the same numbers for the same account.
    struct Counts {
        var inbox = 0
        var today = 0
        var upcoming = 0
        var done = 0
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var projects: [Project] = []
    @Published private(set) var sections: [LightKit.Section] = []
    @Published private(set) var labels: [Label] = []
    /// Every comment the snapshot held. Read-only here; see `Comment`.
    private var comments: [Comment] = []
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
            sections = []
            comments = []
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
        sections = snapshot.entities.section ?? []
        labels = snapshot.entities.label ?? []
        comments = snapshot.entities.comment ?? []
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
    /// This is a project's order. Today and Upcoming are not in it: they sort by
    /// `dayOrder` where a task has one (`Agenda`), which is how a day can be
    /// arranged on the web without arranging any project.
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

    /// A project's open tasks, arranged for the screen: subtasks beneath their
    /// parents, under their section headings.
    ///
    /// Everything about *what the arrangement is* lives in `Outline`, the twin of
    /// the web's, so the two clients cannot read the same account differently.
    /// This only attaches the rest of what a row needs.
    func blocks(in project: Project) -> [Block] {
        let scoped = openRows.filter { $0.task.projectId == project.id }.map(\.task)
        let arranged = Outline.arrange(scoped, among: all)
        return Outline
            .groups(arranged, sections: sections.filter { $0.projectId == project.id })
            .map { Block(section: $0.section, day: nil, entries: entries($0.rows)) }
    }

    /// Completed tasks as one block, flat: a record of what was done, not a plan,
    /// so nothing nests and nothing is folded.
    func completedBlocks() -> [Block] {
        [Block(section: nil, day: nil, entries: completedRows.map {
            Entry(row: $0, outline: Outline.flat($0.task))
        })]
    }

    /// Entries for rows an arrangement produced: the task's row, beside where it
    /// sits. Rows the model does not hold (a hidden project's) are left out.
    private func entries(_ arranged: [Outline.Row]) -> [Entry] {
        let byId = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return arranged.compactMap { outline in byId[outline.id].map { Entry(row: $0, outline: outline) } }
    }

    private var openTasks: [LightKit.Task] { openRows.map(\.task) }
    private var todayLocal: String { Schedule.localDay(Date()) }

    /// Today: everything due on or before today, overdue included, in the order
    /// the web shows it — `dayOrder` where the task has one.
    func todayBlocks() -> [Block] {
        let arranged = Agenda.today(open: openTasks, today: todayLocal, among: all)
        return [Block(section: nil, day: nil, entries: entries(arranged))]
    }

    /// Upcoming, a heading per day that has something on it.
    ///
    /// Read-only on the phone. The web's version is also a place to drag a task
    /// from one day to another, and that is not done here: this client is not
    /// local-first, every write is pushed at once and the screen reloaded if the
    /// push fails, which is honest for a checkbox and not for a rearrangement — a
    /// failed push would visibly reshuffle a list the person had just arranged.
    /// A day with nothing due has no heading here, because there is nothing to
    /// drop on it; the counts are the same either way.
    func upcomingBlocks() -> [Block] {
        Agenda.upcoming(open: openTasks, today: todayLocal, among: all)
            .filter { !$0.rows.isEmpty }
            .map { Block(section: nil, day: $0.day, entries: entries($0.rows)) }
    }

    var counts: Counts {
        let open = openTasks
        let today = todayLocal
        return Counts(
            inbox: inbox.map { project in open.filter { $0.projectId == project.id }.count } ?? 0,
            today: Agenda.today(open: open, today: today, among: all).count,
            upcoming: Agenda.count(Agenda.upcoming(open: open, today: today, among: all)),
            done: completedRows.count)
    }

    /// Open tasks in a project, as the web's sidebar counts them.
    func openCount(in project: Project) -> Int {
        openRows.filter { $0.task.projectId == project.id }.count
    }

    /// The projects as a tree, for the home list.
    var projectTree: [Navigation.Entry] {
        Navigation.projectTree(projects, rewardsEnabled: rewardsEnabled)
    }

    /// Where a new project can be filed: the tree as drawn, without the trophy
    /// cabinet. See `Navigation.parentChoices`.
    var parentChoices: [Navigation.Entry] {
        Navigation.parentChoices(projects, rewardsEnabled: rewardsEnabled)
    }

    /// The inbox, if the account has one. Only the web makes one.
    var inbox: Project? { Navigation.inbox(visibleProjects) }

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

    /// A task's comments, oldest first, for the foot of its editor. The
    /// ordering is `Comment.thread`, the twin of the web's `commentsOnTask`.
    func thread(for task: LightKit.Task) -> [Comment] {
        Comment.thread(for: task.id, among: comments)
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
        if let inbox { return inbox }
        return movableProjects.min(by: { $0.order < $1.order })
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

    /// Adds a subtask under a task, last among its subtasks.
    ///
    /// The parent decides the project and section, so neither is passed; see
    /// `Operations.createSubtask`. A folded parent is unfolded in the same push,
    /// because the one gesture that adds a subtask should not leave it out of
    /// sight — the web does the same.
    func createSubtask(content: String, under parent: LightKit.Task) {
        _Concurrency.Task {
            await write { operations in
                let made = try operations.createSubtask(
                    content: content, under: parent, existing: self.all)
                var ops = made.ops
                self.all.append(made.task)
                if let at = self.all.firstIndex(where: { $0.id == parent.id }) {
                    let open = operations.setCollapsed(self.all[at], false)
                    self.all[at] = open.task
                    ops += open.ops
                }
                self.rebuild()
                return ops
            }
        }
    }

    /// Adds a project, at the top level or under another.
    ///
    /// On screen first and over the wire immediately after, like every other
    /// write here; a refusal (the parent was deleted elsewhere) or a failed push
    /// raises the alert and reloads, so the project is not left on screen if the
    /// server never heard of it.
    func createProject(name: String, parentId: String?) {
        _Concurrency.Task {
            await write { operations in
                let made = try operations.createProject(
                    name: name, parentId: parentId, among: self.projects)
                self.projects.append(made.project)
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

    /// Puts a task on a day by name, or takes it off the calendar with `nil`.
    ///
    /// Through `Operations.reschedule`, so "next week" is the same Monday here
    /// as on the web and for an agent. `today` is this device's local day.
    func reschedule(_ task: LightKit.Task, to target: Reschedule?) {
        _Concurrency.Task {
            await write { operations in
                let moved = try operations.reschedule(
                    task, to: target, today: Schedule.localDay(Date()))
                self.replace(moved.task)
                return moved.ops
            }
        }
    }

    func setPriority(_ task: LightKit.Task, _ priority: Priority) {
        guard priority != task.priority else { return }
        update(task, .init(priority: priority))
    }

    /// The projects a task can be moved into: not the trophy cabinet, and not
    /// one that has been archived — the same rule the web's `#Name` uses.
    var movableProjects: [Project] {
        projects.filter { !$0.isArchived && !$0.isRewards }
    }

    /// Files a task under another project, with its subtasks.
    func move(_ task: LightKit.Task, to project: Project) {
        _Concurrency.Task {
            await write { operations in
                let moved = operations.move(task, to: project.id, among: self.all)
                for changed in moved.tasks {
                    if let index = self.all.firstIndex(where: { $0.id == changed.id }) {
                        self.all[index] = changed
                    }
                }
                self.rebuild()
                return moved.ops
            }
        }
    }

    /// How many tasks hang beneath this one, at any depth, for a confirmation
    /// that says what it is about to take with it.
    func subtaskCount(of task: LightKit.Task) -> Int {
        // The same walk the delete itself makes, so the number and the effect
        // cannot disagree.
        Operations.subtaskIds(of: task, among: all).count
    }

    /// Deletes a task, and with it every subtask.
    func delete(_ task: LightKit.Task) {
        _Concurrency.Task {
            await write { operations in
                let deletion = operations.delete(task, among: self.all, comments: self.comments)
                let gone = Set(deletion.deleted)
                let goneComments = Set(deletion.deletedComments)
                self.all.removeAll { gone.contains($0.id) }
                self.comments.removeAll { goneComments.contains($0.id) }
                self.rebuild()
                return deletion.ops
            }
        }
    }

    /// Folds or unfolds a task's subtasks. Synced: it is the same flag the web
    /// writes, so a task folded there is folded here and the reverse.
    func setCollapsed(_ task: LightKit.Task, _ collapsed: Bool) {
        _Concurrency.Task {
            await write { operations in
                let folded = operations.setCollapsed(task, collapsed)
                self.replace(folded.task)
                return folded.ops
            }
        }
    }

    /// Folds or unfolds a section. The one thing about a section this client
    /// writes; making, renaming and deleting them stay on the web.
    func setCollapsed(_ section: LightKit.Section, _ collapsed: Bool) {
        _Concurrency.Task {
            await write { operations in
                let folded = operations.setCollapsed(section, collapsed)
                if let index = self.sections.firstIndex(where: { $0.id == section.id }) {
                    self.sections[index] = folded.section
                }
                return folded.ops
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
