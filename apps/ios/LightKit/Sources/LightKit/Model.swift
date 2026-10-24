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
    public var description: String
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
    public var isCompleted: Bool
    public var completedAt: String?
    public var createdAt: String
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
