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
