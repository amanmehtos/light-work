import Foundation

/// The Light Week domain model, as it travels.
///
/// These mirror `packages/core/src/entities.ts` field for field. The wire
/// format is the contract between the clients, so the names here are not free
/// to drift — a rename on either side is a protocol change.

/// Priority as the user reads it: 1 is urgent, 4 is none.
///
/// Todoist's API inverts this internally. Light Week stores the user-facing
/// order, and the importer is what converts.
public enum Priority: Int, Codable, Sendable, CaseIterable {
    case urgent = 1
    case high = 2
    case medium = 3
    case none = 4
}

/// When a task is scheduled.
public struct Due: Codable, Sendable, Equatable {
    /// `YYYY-MM-DD` when all-day, a full ISO 8601 instant when timed.
    public var date: String
    public var hasTime: Bool
    /// The phrase the user typed. Authoritative for a recurring task: the next
    /// occurrence is derived from this, not from `date`.
    public var text: String?
    public var timezone: String?
    public var isRecurring: Bool

    public init(date: String, hasTime: Bool = false, text: String? = nil,
                timezone: String? = nil, isRecurring: Bool = false) {
        self.date = date
        self.hasTime = hasTime
        self.text = text
        self.timezone = timezone
        self.isRecurring = isRecurring
    }
}

/// When a task is actually owed. Distinct from `Due` on purpose: a task can be
/// due on Monday with a deadline three weeks out, and collapsing the two loses
/// something the user put in deliberately.
public struct Deadline: Codable, Sendable, Equatable {
    public var date: String
    public init(date: String) { self.date = date }
}

public struct Duration: Codable, Sendable, Equatable {
    public enum Unit: String, Codable, Sendable { case minute, day }
    public var amount: Int
    public var unit: Unit
    public init(amount: Int, unit: Unit = .minute) {
        self.amount = amount
        self.unit = unit
    }
}

public struct Project: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var parentId: String?
    public var name: String
    public var color: String
    public var order: String
    public var isFavorite: Bool
    public var isArchived: Bool
    public var isInbox: Bool
    /// The trophy cabinet, holding the rewards that completed tasks have
    /// earned. Permanent in the same way the inbox is.
    public var isRewards: Bool
    public var description: String

    /// Spelled out for one field.
    ///
    /// `isRewards` was added after there were already accounts, so every
    /// project stored before it has no such key. The synthesised decoder
    /// throws on a missing non-optional, which would mean the whole snapshot
    /// failing to decode — so this one field is read as "false when absent",
    /// which is what an older project genuinely is.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        parentId = try values.decodeIfPresent(String.self, forKey: .parentId)
        name = try values.decode(String.self, forKey: .name)
        color = try values.decode(String.self, forKey: .color)
        order = try values.decode(String.self, forKey: .order)
        isFavorite = try values.decode(Bool.self, forKey: .isFavorite)
        isArchived = try values.decode(Bool.self, forKey: .isArchived)
        isInbox = try values.decode(Bool.self, forKey: .isInbox)
        isRewards = try values.decodeIfPresent(Bool.self, forKey: .isRewards) ?? false
        description = try values.decode(String.self, forKey: .description)
    }
}

public struct Task: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var projectId: String
    public var sectionId: String?
    public var parentId: String?
    public var content: String
    public var description: String
    public var priority: Priority
    public var order: String
    public var due: Due?
    public var deadline: Deadline?
    public var duration: Duration?
    public var labelIds: [String]
    /// What finishing this earns, in the user's own words.
    ///
    /// Nil and empty are different: nil means no reward was ever set, empty
    /// means one was set and then cleared. Optional, so a task stored before
    /// rewards existed decodes without help.
    public var reward: String?
    public var isCompleted: Bool
    public var completedAt: String?
    public var createdAt: String
    /// The task's place in the Today and Upcoming lists, kept apart from
    /// `order`. Read so that it round-trips; nothing here arranges by it yet.
    public var dayOrder: String? = nil
    /// Whether the task's subtasks are folded away. Synced, so a task folded on
    /// the laptop is folded here.
    public var isCollapsed: Bool = false

    enum CodingKeys: String, CodingKey {
        case id, projectId, sectionId, parentId, content, description, priority, order
        case due, deadline, duration, labelIds, reward, isCompleted, completedAt, createdAt
        case dayOrder, isCollapsed
    }
}

extension Task {
    /// Spelled out for the two fields that arrived after there were tasks.
    ///
    /// `dayOrder` is optional and would decode by itself, but `isCollapsed` is
    /// not, and the synthesised decoder throws on a missing non-optional — which
    /// would fail the whole snapshot, not one task. A task stored before the key
    /// existed is not folded, so absent reads as `false`. (This is the
    /// additive-in-both-directions the web relies on in the other direction:
    /// extra keys on the wire are ignored here, and the web's merge keeps the
    /// ones this client never sends.)
    ///
    /// In an extension so the memberwise initialiser survives.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        projectId = try values.decode(String.self, forKey: .projectId)
        sectionId = try values.decodeIfPresent(String.self, forKey: .sectionId)
        parentId = try values.decodeIfPresent(String.self, forKey: .parentId)
        content = try values.decode(String.self, forKey: .content)
        description = try values.decode(String.self, forKey: .description)
        priority = try values.decode(Priority.self, forKey: .priority)
        order = try values.decode(String.self, forKey: .order)
        due = try values.decodeIfPresent(Due.self, forKey: .due)
        deadline = try values.decodeIfPresent(Deadline.self, forKey: .deadline)
        duration = try values.decodeIfPresent(Duration.self, forKey: .duration)
        labelIds = try values.decode([String].self, forKey: .labelIds)
        reward = try values.decodeIfPresent(String.self, forKey: .reward)
        isCompleted = try values.decode(Bool.self, forKey: .isCompleted)
        completedAt = try values.decodeIfPresent(String.self, forKey: .completedAt)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        dayOrder = try values.decodeIfPresent(String.self, forKey: .dayOrder)
        isCollapsed = try values.decodeIfPresent(Bool.self, forKey: .isCollapsed) ?? false
    }
}

/// A heading in a project, under which a run of its tasks sits.
///
/// A heading and not a container of record: deleting one keeps its tasks (see
/// `Operations.deleteSection` in `@light/client-sdk`), and a task whose section
/// has gone is simply drawn with the unsectioned ones. This client reads them;
/// making them stays on the web for now.
///
/// Named `Section`, as in the model it mirrors. In a file that also imports
/// SwiftUI the two collide, so SwiftUI's is written `SwiftUI.Section` there —
/// the same accommodation `Task` already asks of `_Concurrency.Task`.
public struct Section: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var projectId: String
    public var name: String
    /// Markdown. Several of the imported sections hold the plan for their phase.
    public var description: String
    public var order: String
    public var isArchived: Bool
    public var isCollapsed: Bool

    public init(id: String, projectId: String, name: String, description: String = "",
                order: String, isArchived: Bool = false, isCollapsed: Bool = false) {
        self.id = id
        self.projectId = projectId
        self.name = name
        self.description = description
        self.order = order
        self.isArchived = isArchived
        self.isCollapsed = isCollapsed
    }

    /// Forgiving about the three fields that are only ever flags or prose. A
    /// section that arrives without them is a plain, open, unarchived one; the
    /// alternative is a single odd row failing the whole snapshot, and the whole
    /// account with it.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        projectId = try values.decode(String.self, forKey: .projectId)
        name = try values.decode(String.self, forKey: .name)
        description = try values.decodeIfPresent(String.self, forKey: .description) ?? ""
        order = try values.decode(String.self, forKey: .order)
        isArchived = try values.decodeIfPresent(Bool.self, forKey: .isArchived) ?? false
        isCollapsed = try values.decodeIfPresent(Bool.self, forKey: .isCollapsed) ?? false
    }
}

/// The account's settings. One record, at a well-known id.
///
/// Synced rather than kept on the device, because the switch it holds governs
/// whether a synced project is part of the account — a phone with it off and a
/// laptop with it on would disagree about what the account contains.
public struct Preference: Codable, Sendable, Identifiable, Equatable {
    public static let wellKnownId = "preferences"

    public var id: String
    /// Whether tasks carry rewards, and the Rewards project is shown.
    public var rewardsEnabled: Bool

    public init(id: String = Preference.wellKnownId, rewardsEnabled: Bool = true) {
        self.id = id
        self.rewardsEnabled = rewardsEnabled
    }
}

public struct Label: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var name: String
    public var color: String
    public var order: String
    public var isFavorite: Bool
}

/// A block of intentional focus.
///
/// This is the whole reason the suite is one thing rather than two apps sharing
/// a name. Light Minute writes these when a timer finishes; Light Week shows
/// the accumulated time on the task and hands it to an agent through MCP, so
/// planning can be informed by where attention actually went.
public struct FocusSession: Codable, Sendable, Identifiable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case focus, shortBreak = "short_break", longBreak = "long_break"
    }

    public enum Outcome: String, Codable, Sendable {
        case running, completed, abandoned
    }

    public var id: String
    /// Null when the timer was started without picking a task.
    public var taskId: String?
    public var projectId: String?
    public var startedAt: String
    public var endedAt: String?
    /// What the timer was set to.
    public var plannedSeconds: Int
    /// What was actually spent, excluding paused time.
    public var focusedSeconds: Int
    public var kind: Kind
    public var outcome: Outcome
    /// How many times the session was paused or the app left.
    public var interruptions: Int
    /// Which app wrote it, e.g. `light-minute-ios`.
    public var source: String
    public var note: String?

    public init(
        id: String = LightID.new(),
        taskId: String? = nil,
        projectId: String? = nil,
        startedAt: Date,
        endedAt: Date? = nil,
        plannedSeconds: Int,
        focusedSeconds: Int,
        kind: Kind = .focus,
        outcome: Outcome = .completed,
        interruptions: Int = 0,
        source: String,
        note: String? = nil
    ) {
        self.id = id
        self.taskId = taskId
        self.projectId = projectId
        self.startedAt = ISO8601DateFormatter.lightWeek.string(from: startedAt)
        self.endedAt = endedAt.map { ISO8601DateFormatter.lightWeek.string(from: $0) }
        self.plannedSeconds = plannedSeconds
        self.focusedSeconds = focusedSeconds
        self.kind = kind
        self.outcome = outcome
        self.interruptions = interruptions
        self.source = source
        self.note = note
    }
}

extension ISO8601DateFormatter {
    /// Fractional seconds, because two sessions can start inside one second.
    public static let lightWeek: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// Client-generated, time-prefixed, lexicographically sortable ids.
///
/// Generated on the device so that creating something works offline and never
/// waits on a round trip to become real.
public enum LightID {
    private static let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")

    public static func new(now: Date = Date()) -> String {
        let millis = Int(now.timeIntervalSince1970 * 1000)
        let prefix = String(String(millis, radix: 36).suffix(8))
            .leftPadded(to: 8, with: "0")
        return prefix + random(16)
    }

    public static func newNode() -> String { "n" + random(10) }

    private static func random(_ count: Int) -> String {
        var out = ""
        out.reserveCapacity(count)
        for _ in 0..<count {
            out.append(alphabet[Int.random(in: 0..<alphabet.count)])
        }
        return out
    }
}

extension String {
    func leftPadded(to width: Int, with pad: Character) -> String {
        count >= width ? self : String(repeating: pad, count: width - count) + self
    }
}
