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
    /// web does, using the same `Order` keys, so a task added here sorts where
    /// the web would have put it.
    ///
    /// The op names every field, `null` where there is nothing — not only the
    /// ones that have a value. `Task` here has no `dayOrder`, `isCollapsed` or
    /// the assignee fields, and encoding it would simply omit those and every
    /// optional left nil. The web reads a missing `parentId` as "not null",
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

        let fields: JSONValue = .object([
            "id": .string(created.id),
            "projectId": .string(projectId),
            "sectionId": .null,
            "parentId": .null,
            "content": .string(created.content),
            "description": .string(""),
            "priority": .integer(priority.rawValue),
            "order": .string(created.order),
            "dayOrder": .null,
            "due": .null,
            "deadline": .null,
            "duration": .null,
            "labelIds": .array([]),
            "reward": .null,
            "isCompleted": .bool(false),
            "completedAt": .null,
            "isCollapsed": .bool(false),
            "assigneeId": .null,
            "addedById": .null,
            "createdAt": .string(created.createdAt),
        ])
        return (created, [op(kind: "task", id: created.id, fields: fields)])
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
    /// web's version of this is the editor's project field; making that agree is
    /// a structural change for the sections and subtasks phase.
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
        ops.append(op(kind: "task", id: trophy.id, fields: try JSONValue.encoding(trophy)))

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
