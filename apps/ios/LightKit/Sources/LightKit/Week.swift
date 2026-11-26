import Foundation

/// The arithmetic Light Week, the week view, needs.
///
/// The twin of `apps/web/src/week.ts`, held to the same cases by `WeekTests`:
/// which seven days are on the page, which tasks go on each (and where), and
/// how blocks share a day's width while one is being carried. The last is
/// what makes dragging feel right — the overlap sweep runs on the day as it
/// would be if the block in hand were put down now, so the neighbours make
/// room while it is still in the air, not only after the drop.
extension Schedule {

    /// The first day of the week `day` is in.
    ///
    /// Monday, because nothing in the account says otherwise — there is no
    /// week-start preference yet — and Monday is the week `.nextWeek` already
    /// means. Worked in a fixed UTC Gregorian calendar, as `day(for:today:)`
    /// is, so a device whose locale starts weeks on Sunday cannot draw a
    /// different week from the web's.
    public static func weekStart(of day: String) -> String {
        let weekday = utcWeekday(of: day)  // 0 = Sunday
        return shift(day: day, by: -((weekday - 1 + 7) % 7), calendar: utc)
    }

    /// The seven days from `start`.
    public static func week(from start: String) -> [String] {
        (0..<7).map { shift(day: start, by: $0, calendar: utc) }
    }

    /// One day's worth of the week: the strip at the top, and the hours.
    public struct DayTasks: Sendable {
        /// On the day, at no particular time: the all-day strip, "Waiting".
        public var waiting: [Task] = []
        /// On the day, at a time: blocks, earliest first.
        public var timed: [Task] = []
    }

    /// The week's open tasks, dealt into its days.
    ///
    /// Only what has a date is on a calendar. A task with no date is not
    /// waiting for any of these days in particular, and putting the whole
    /// undated backlog at the top of every day buried the days under it.
    public static func bucket(
        _ tasks: [Task], into days: [String], calendar: Calendar = .current
    ) -> [String: DayTasks] {
        var byDay = Dictionary(uniqueKeysWithValues: days.map { ($0, DayTasks()) })
        for task in tasks where !task.isCompleted {
            guard let day = day(of: task.due, calendar: calendar), byDay[day] != nil else { continue }
            if minutes(of: task.due, calendar: calendar) == nil {
                byDay[day]?.waiting.append(task)
            } else {
                byDay[day]?.timed.append(task)
            }
        }
        for day in days {
            byDay[day]?.timed.sort {
                (minutes(of: $0.due, calendar: calendar) ?? 0) < (minutes(of: $1.due, calendar: calendar) ?? 0)
            }
        }
        return byDay
    }

    /// A block on a day, in minutes past midnight.
    public struct Span: Equatable, Sendable {
        public let id: String
        public let start: Int
        public let end: Int

        public init(id: String, start: Int, end: Int) {
            self.id = id
            self.start = start
            self.end = end
        }
    }

    public static func span(of task: Task, calendar: Calendar = .current) -> Span {
        let start = minutes(of: task.due, calendar: calendar) ?? 0
        return Span(id: task.id, start: start, end: start + blockMinutes(task.duration))
    }

    /// Where a block in hand would go if it were let go now: a time on a day,
    /// or a day's all-day strip. Nowhere is `nil`, which puts it back.
    public enum Landing: Equatable, Sendable {
        case slot(day: String, minutes: Int)
        case strip(day: String)
    }

    /// The start a finger means, snapped to the quarter hour.
    ///
    /// `grab` is how far below the block's top it was taken hold of, so the
    /// block keeps its place under the finger instead of jumping its top to
    /// it. Clamped so the whole block stays inside the day, not only its top.
    public static func slot(at pointer: Double, grab: Double, length: Int) -> Int {
        let latest = (24 * 60 - max(length, snapMinutes)) / snapMinutes * snapMinutes
        return min(snap(Int((pointer - grab).rounded())), latest)
    }

    /// One day's blocks as they would be with the block in hand put down.
    ///
    /// The block in hand leaves whatever day it was on, and if the landing is
    /// a time on *this* day it is here instead, at that time. With no landing
    /// the day is as it is: a block carried off the grid has not left yet.
    public static func preview(
        _ spans: [Span], day: String, moving: (id: String, length: Int)?, landing: Landing?
    ) -> [Span] {
        guard let moving, let landing else { return spans }
        var rest = spans.filter { $0.id != moving.id }
        if case .slot(day, let minutes) = landing {
            rest.append(Span(id: moving.id, start: minutes, end: minutes + moving.length))
        }
        return rest
    }

    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private static func utcWeekday(of day: String) -> Int {
        let parts = day.prefix(10).split(separator: "-").map { Int($0) ?? 1 }
        var components = DateComponents()
        components.year = parts.first
        components.month = parts.count > 1 ? parts[1] : 1
        components.day = parts.count > 2 ? parts[2] : 1
        guard let date = utc.date(from: components) else { return 1 }
        return utc.component(.weekday, from: date) - 1
    }
}
