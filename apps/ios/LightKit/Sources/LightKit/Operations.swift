import Foundation

/// The writes Light Week can make, as ops.
///
/// This is the Swift half of `packages/client-sdk/src/operations.ts`. It is
/// deliberately pure: everything takes the entities it needs as arguments and
/// returns ops, with no store and no network, so the rules can be tested
/// without either — and so the one rule that genuinely exists twice, the
/// reward on completion, can be checked against the same cases as the
/// TypeScript.
///
/// Ops carry sparse patches, so every method writes only the fields it means
/// to change. That is what lets two devices edit different fields of one task
/// without either losing the other's work.
public struct Operations: Sendable {
    private let clock: Clock

    public init(clock: Clock) {
        self.clock = clock
    }

    private func op(kind: String, id: String, fields: JSONValue) -> Op {
        Op(kind: kind, entityId: id, fields: fields,
           clock: clock.next().encoded, node: clock.node)
    }

    /// A tombstone. It carries no fields: a delete is the absence of a row, and
    /// the merge rule reads only its clock.
    private func tombstone(kind: String, id: String) -> Op {
        Op(kind: kind, entityId: id, type: "delete", fields: nil,
           clock: clock.next().encoded, node: clock.node)
    }

    // MARK: - Creating

    /// Why a task could not be made.
    public enum CreateError: Error, Sendable, Equatable, LocalizedError {
        case emptyTitle

        public var errorDescription: String? {
            switch self {
            case .emptyTitle: return "A task needs a title."
            }
        }
    }

    /// Makes a task, at the end of its list.
    ///
    /// The Swift twin of `Operations.createTask` in `@light/client-sdk`, for a
    /// phone that can finally add one. Deliberately no natural language: the
    /// date rules live in the TypeScript parser, and a second implementation of
    /// them in Swift would be a second place for them to drift — the rewards
    /// rule already shows what that costs. So this takes what a person has
    /// actually chosen: a title, a project, and the controls the editor has.
    ///
    /// `existing` is every task the caller knows about. The new one is placed
    /// after the others in the same project at the top level, exactly as the

    /// Every field of a task, `null` where there is nothing.
    ///
    /// Encoding a `Task` will not do. Swift's `Codable` omits an optional left
    /// nil, and `Task` does not carry the assignee fields at all — so the patch
    /// would arrive missing keys, and the web reads a missing `parentId` as
    /// "not null", which hides the task from its project list. That is not hypothetical: it is how a reward
    /// earned on the phone became invisible in the web's Rewards project.
    ///
    /// One place rather than two, because this has now been got wrong once and
    /// spelled out correctly once, and a third copy would eventually disagree
    /// with both.
    func taskFields(_ task: Task) -> JSONValue {
        func optional<T: Encodable>(_ value: T?) -> JSONValue {
            guard let value else { return .null }
            return (try? JSONValue.encoding(value)) ?? .null
        }
        return .object([
            "id": .string(task.id),
            "projectId": .string(task.projectId),
            "sectionId": task.sectionId.map { JSONValue.string($0) } ?? .null,
            "parentId": task.parentId.map { JSONValue.string($0) } ?? .null,
            "content": .string(task.content),
            "description": .string(task.description),
            "priority": .integer(task.priority.rawValue),
            "order": .string(task.order),
            "dayOrder": task.dayOrder.map { JSONValue.string($0) } ?? .null,
            "due": optional(task.due),
            "deadline": optional(task.deadline),
            "duration": optional(task.duration),
            "labelIds": .array(task.labelIds.map { JSONValue.string($0) }),
            "reward": task.reward.map { JSONValue.string($0) } ?? .null,
            "isCompleted": .bool(task.isCompleted),
            "completedAt": task.completedAt.map { JSONValue.string($0) } ?? .null,
            "isCollapsed": .bool(task.isCollapsed),
            "assigneeId": .null,
            "addedById": .null,
            "createdAt": .string(task.createdAt),
        ])
    }

    /// web does, using the same `Order` keys, so a task added here sorts where
    /// the web would have put it.
    ///
    /// The op names every field, `null` where there is nothing — not only the
    /// ones that have a value. Encoding a `Task` would omit every optional left
    /// nil and the assignee fields, which it does not carry. The web reads a missing `parentId` as "not null",
    /// which hides the task from its project list, so the patch is spelled out
    /// the way `createTask` writes it.
    public func create(
        content: String,
        projectId: String,
        existing: [Task],
        priority: Priority = .none,
        now: Date = Date()
    ) throws -> (task: Task, ops: [Op]) {
        let title = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw CreateError.emptyTitle }

        let siblings = existing.filter {
            $0.projectId == projectId && $0.sectionId == nil && $0.parentId == nil
        }
        let created = Task(
            id: LightID.new(now: now),
            projectId: projectId,
            sectionId: nil,
            parentId: nil,
            content: title,
            description: "",
            priority: priority,
            order: Order.afterLast(siblings.map(\.order)),
            due: nil,
            deadline: nil,
            duration: nil,
            labelIds: [],
            reward: nil,
            isCompleted: false,
            completedAt: nil,
            createdAt: ISO8601DateFormatter.lightWeek.string(from: now))

        return (created, [op(kind: "task", id: created.id, fields: taskFields(created))])
    }

    // MARK: - Editing

    /// A sparse edit. Each field is "leave it alone" unless it is set.
    ///
    /// Two levels of optional are the point: `.none` means the caller said
    /// nothing, `.some(nil)` means the caller said "clear it". Collapsing them
    /// would make it impossible to unschedule a task.
    public struct TaskChanges: Sendable {
        public var content: String?
        public var description: String?
        public var priority: Priority?
        public var due: Due??
        public var deadline: Deadline??
        public var duration: Duration??
        public var labelIds: [String]?
        public var reward: String??

        public init(
            content: String? = nil,
            description: String? = nil,
            priority: Priority? = nil,
            due: Due?? = nil,
            deadline: Deadline?? = nil,
            duration: Duration?? = nil,
            labelIds: [String]? = nil,
            reward: String?? = nil
        ) {
            self.content = content
            self.description = description
            self.priority = priority
            self.due = due
            self.deadline = deadline
            self.duration = duration
            self.labelIds = labelIds
            self.reward = reward
        }

        public var isEmpty: Bool {
            content == nil && description == nil && priority == nil && due == nil
                && deadline == nil && duration == nil && labelIds == nil && reward == nil
        }
    }

    /// Applies the changes to a task, both as ops to send and as the task the
    /// screen should show immediately. Writing waits for the network; seeing
    /// your own edit should not.
    public func update(_ task: Task, _ changes: TaskChanges) throws -> (task: Task, ops: [Op]) {
        guard !changes.isEmpty else { return (task, []) }

        var fields: [String: JSONValue] = [:]
        var updated = task

        if let content = changes.content {
            updated.content = content
            fields["content"] = .string(content)
        }
        if let description = changes.description {
            updated.description = description
            fields["description"] = .string(description)
        }
        if let priority = changes.priority {
            updated.priority = priority
            fields["priority"] = .integer(priority.rawValue)
        }
        if let due = changes.due {
            updated.due = due
            fields["due"] = try due.map { try JSONValue.encoding($0) } ?? .null
        }
        if let deadline = changes.deadline {
            updated.deadline = deadline
            fields["deadline"] = try deadline.map { try JSONValue.encoding($0) } ?? .null
        }
        if let duration = changes.duration {
            updated.duration = duration
            fields["duration"] = try duration.map { try JSONValue.encoding($0) } ?? .null
        }
        if let labelIds = changes.labelIds {
            updated.labelIds = labelIds
            fields["labelIds"] = .array(labelIds.map { .string($0) })
        }
        if let reward = changes.reward {
            updated.reward = reward
            fields["reward"] = reward.map { JSONValue.string($0) } ?? .null
        }

        return (updated, [op(kind: "task", id: task.id, fields: .object(fields))])
    }

    /// Moves a task to a day by name, or off the calendar with `nil`.
    ///
    /// The one-gesture edit behind the swipe and the context menu, and the Swift
    /// twin of `Operations.reschedule` in `@light/client-sdk`. The day comes from
    /// `Schedule.day(for:today:)`, so "next week" is the same Monday here as on
    /// the web and for an agent.
    ///
    /// It goes through `update`, so the patch is sparse — only `due` is written.
    /// The day lands all-day: a time of day is dropped, as it is on the web, and
    /// a repeat's phrase and flag are kept so a weekly task pushed to tomorrow
    /// is still weekly. `nil` clears the date and with it the repeat.
    public func reschedule(
        _ task: Task, to target: Reschedule?, today: String
    ) throws -> (task: Task, ops: [Op]) {
        guard let target else {
            return try update(task, .init(due: .some(nil)))
        }
        let due = Due(date: Schedule.day(for: target, today: today),
                      hasTime: false,
                      text: task.due?.text,
                      timezone: task.due?.timezone,
                      isRecurring: task.due?.isRecurring ?? false)
        return try update(task, .init(due: .some(due)))
    }

    // MARK: - Deleting

    /// What deleting a task took with it.
    public struct Deletion: Sendable {
        /// Every id that went, subtasks first and the task itself last.
        public var deleted: [String]
        public var ops: [Op]
    }

    /// Deletes a task and its subtasks, however deep.
    ///
    /// The same rule as `Operations.deleteTask` in `@light/client-sdk`, and for
    /// the same reason: a delete is a tombstone on one row, nothing cascades in
    /// storage, so every subtask needs a tombstone of its own or it outlives
    /// its parent pointing at an id that is gone. Depth first, children before
    /// the parent.
    ///
    /// `tasks` is every task the caller knows about, completed ones included —
    /// a finished subtask is still a subtask.
    public func delete(_ task: Task, among tasks: [Task]) -> Deletion {
        let deleted = Self.subtaskIds(of: task, among: tasks) + [task.id]
        return Deletion(deleted: deleted, ops: deleted.map { tombstone(kind: "task", id: $0) })
    }

    /// Every task beneath this one, at any depth, deepest first — the order a
    /// delete has to go in. Public so a confirmation can say how many are about
    /// to go using the very walk that will take them.
    public static func subtaskIds(of task: Task, among tasks: [Task]) -> [String] {
        var found: [String] = []
        // A guard against a parent cycle in bad data, which would otherwise
        // recurse for ever.
        var seen: Set<String> = [task.id]

        func collect(_ parentId: String) {
            for child in tasks where child.parentId == parentId && !seen.contains(child.id) {
                seen.insert(child.id)
                collect(child.id)
                found.append(child.id)
            }
        }
        collect(task.id)
        return found
    }

    // MARK: - Moving

    /// What moving a task changed.
    public struct Move: Sendable {
        /// The moved task first, then each of its subtasks, as they now stand.
        public var tasks: [Task]
        public var ops: [Op]
    }

    /// Moves a task to another project, last in that project's top level.
    ///
    /// Stricter than `moveTask` in `@light/client-sdk`, which leaves a task's
    /// section and parent alone: a section belongs to one project and a
    /// subtask's parent stays behind in the old one, so keeping either would
    /// leave the task pointing at something in a project it no longer lives in,
    /// and it would vanish from both lists. So the task lands outside any
    /// section and without a parent, and its subtasks come with it — they get
    /// the new project and keep their parent, which is now beside them. The
    /// web's project move does the same: a change of project clears the section
    /// and the parent unless it is told otherwise, and takes the subtasks along.
    ///
    /// Moving to the project it is already in writes nothing.
    public func move(_ task: Task, to projectId: String, among tasks: [Task]) -> Move {
        guard task.projectId != projectId else { return Move(tasks: [task], ops: []) }

        let siblings = tasks.filter {
            $0.projectId == projectId && $0.sectionId == nil && $0.parentId == nil
        }
        var moved = task
        moved.projectId = projectId
        moved.sectionId = nil
        moved.parentId = nil
        moved.order = Order.afterLast(siblings.map(\.order))

        var changed = [moved]
        var ops = [op(kind: "task", id: task.id, fields: .object([
            "projectId": .string(projectId),
            "sectionId": .null,
            "parentId": .null,
            "order": .string(moved.order),
        ]))]

        var seen: Set<String> = [task.id]
        func follow(_ parentId: String) {
            for child in tasks where child.parentId == parentId && !seen.contains(child.id) {
                seen.insert(child.id)
                var carried = child
                carried.projectId = projectId
                // A section belongs to the project it was made in.
                carried.sectionId = nil
                changed.append(carried)
                ops.append(op(kind: "task", id: child.id, fields: .object([
                    "projectId": .string(projectId),
                    "sectionId": .null,
                ])))
                follow(child.id)
            }
        }
        follow(task.id)

        return Move(tasks: changed, ops: ops)
    }

    // MARK: - Folding

    /// Folds or unfolds a task's subtasks.
    ///
    /// Sparse: only `isCollapsed` is written, so this cannot clobber an edit to
    /// any other field of the task from another device — which is why it does not
    /// go through `taskFields`, and need not. (A whole-task write must; this is
    /// not one.) A write of the value it already has is not a write: it would
    /// sync for nothing.
    public func setCollapsed(_ task: Task, _ collapsed: Bool) -> (task: Task, ops: [Op]) {
        guard task.isCollapsed != collapsed else { return (task, []) }
        var folded = task
        folded.isCollapsed = collapsed
        return (folded, [op(kind: "task", id: task.id,
                            fields: .object(["isCollapsed": .bool(collapsed)]))])
    }

    /// Folds or unfolds a section. Synced, like a task's: a section collapsed on
    /// the laptop is collapsed here. Folding is the one thing about a section
    /// this client writes; making, renaming and deleting them stay on the web.
    public func setCollapsed(_ section: Section, _ collapsed: Bool) -> (section: Section, ops: [Op]) {
        guard section.isCollapsed != collapsed else { return (section, []) }
        var folded = section
        folded.isCollapsed = collapsed
        return (folded, [op(kind: "section", id: section.id,
                            fields: .object(["isCollapsed": .bool(collapsed)]))])
    }

    // MARK: - Finishing

    /// What completing a task did.
    public struct Completion: Sendable {
        /// The task as it now stands, for the screen to show at once.
        public var task: Task
        /// The Rewards project, when this completion had to make it.
        public var createdProject: Project?
        /// The reward that was filed, when one was.
        public var earned: Task?
        public var ops: [Op]
    }

    /// Completes a task, filing its reward if it has one.
    ///
    /// The rule lives here rather than in a view for the same reason it lives
    /// in `Operations` on the web: finishing a task is not only something that
    /// happens on a screen, and a rule that fires in one place is a rule that
    /// is wrong everywhere else.
    ///
    /// Unlike the web, this does **not** reschedule a recurring task — the
    /// recurrence parser has not been ported, and guessing a next occurrence
    /// would be worse than completing honestly. A repeating task completed
    /// here still earns its reward, which is the half of the behaviour that
    /// does carry over.
    public func complete(
        _ task: Task,
        rewardsEnabled: Bool,
        projects: [Project],
        now: Date = Date()
    ) throws -> Completion {
        var done = task
        done.isCompleted = true
        done.completedAt = ISO8601DateFormatter.lightWeek.string(from: now)

        var ops = [op(kind: "task", id: task.id, fields: .object([
            "isCompleted": .bool(true),
            "completedAt": .string(done.completedAt!),
        ]))]

        let reward = (task.reward ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard rewardsEnabled, !reward.isEmpty else {
            return Completion(task: done, createdProject: nil, earned: nil, ops: ops)
        }

        var created: Project?
        var cabinet = projects.first(where: \.isRewards)
        if cabinet == nil {
            let made = rewardsProject(after: projects)
            created = made.project
            cabinet = made.project
            ops.append(contentsOf: made.ops)
        }

        let trophy = Task(
            id: LightID.new(now: now),
            projectId: cabinet!.id,
            sectionId: nil,
            parentId: nil,
            content: reward,
            description: "Earned by finishing “\(task.content)”.",
            priority: .none,
            order: Order.afterLast(projects.map(\.order)),
            due: nil,
            deadline: nil,
            duration: nil,
            labelIds: [],
            reward: nil,
            isCompleted: false,
            completedAt: nil,
            createdAt: ISO8601DateFormatter.lightWeek.string(from: now))
        ops.append(op(kind: "task", id: trophy.id, fields: taskFields(trophy)))

        return Completion(task: done, createdProject: created, earned: trophy, ops: ops)
    }

    /// Puts a completed task back.
    public func reopen(_ task: Task) -> (task: Task, ops: [Op]) {
        var open = task
        open.isCompleted = false
        open.completedAt = nil
        return (open, [op(kind: "task", id: task.id, fields: .object([
            "isCompleted": .bool(false),
            "completedAt": .null,
        ]))])
    }

    // MARK: - Rewards

    /// The trophy cabinet, made the first time something is put in it.
    public func rewardsProject(after projects: [Project]) -> (project: Project, ops: [Op]) {
        let made = Project(
            id: LightID.new(),
            parentId: nil,
            name: "Rewards",
            color: "charcoal",
            order: Order.afterLast(projects.map(\.order)),
            isFavorite: false,
            isArchived: false,
            isInbox: false,
            isRewards: true,
            description: "")
        let fields: JSONValue = .object([
            "id": .string(made.id),
            "parentId": .null,
            "name": .string(made.name),
            "color": .string(made.color),
            "order": .string(made.order),
            "isFavorite": .bool(false),
            "isArchived": .bool(false),
            "isInbox": .bool(false),
            "isRewards": .bool(true),
            "description": .string(""),
        ])
        return (made, [op(kind: "project", id: made.id, fields: fields)])
    }

    public func setRewardsEnabled(_ enabled: Bool) -> [Op] {
        [op(kind: "preference", id: Preference.wellKnownId,
            fields: .object(["id": .string(Preference.wellKnownId),
                             "rewardsEnabled": .bool(enabled)]))]
    }
}

extension Project {
    /// Spelled out because the decoder above is, and declaring one takes the
    /// memberwise initialiser away.
    public init(id: String, parentId: String?, name: String, color: String, order: String,
                isFavorite: Bool, isArchived: Bool, isInbox: Bool, isRewards: Bool,
                description: String) {
        self.id = id
        self.parentId = parentId
        self.name = name
        self.color = color
        self.order = order
        self.isFavorite = isFavorite
        self.isArchived = isArchived
        self.isInbox = isInbox
        self.isRewards = isRewards
        self.description = description
    }
}
