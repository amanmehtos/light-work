import Foundation

/// The arithmetic a day view needs.
///
/// A `Due` carries either a calendar day (`2026-11-03`) or a full instant
/// (`2026-11-03T09:00:00.000Z`), and which one it is comes from `hasTime`, not
/// from the string's shape. That difference is easy to get wrong by eye: the
/// instant is UTC, so reading ten characters off the front gives the wrong day
/// for anyone east of Greenwich in the morning or west of it in the evening.
///
/// The twin of `apps/web/src/schedule.ts`, which is tested the same way. "Day"
/// throughout means the local calendar day, because that is what Today and a
/// day view have to mean to the person reading them.
public enum Schedule {

    /// Minutes past midnight a block can start on: a quarter of an hour.
    public static let snapMinutes = 15

    /// The local calendar day of a date, as `YYYY-MM-DD`.
    public static func localDay(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// Which day a task sits on, or nil if it is not scheduled at all.
    public static func day(of due: Due?, calendar: Calendar = .current) -> String? {
        guard let due else { return nil }
        guard due.hasTime else { return String(due.date.prefix(10)) }
        guard let instant = ISO8601DateFormatter.lightWeek.date(from: due.date)
            ?? ISO8601DateFormatter.lightWeekWhole.date(from: due.date)
        else { return String(due.date.prefix(10)) }
        return localDay(instant, calendar: calendar)
    }

    /// Minutes past local midnight, or nil when the task is all-day.
    public static func minutes(of due: Due?, calendar: Calendar = .current) -> Int? {
        guard let due, due.hasTime else { return nil }
        guard let instant = ISO8601DateFormatter.lightWeek.date(from: due.date)
            ?? ISO8601DateFormatter.lightWeekWhole.date(from: due.date)
        else { return nil }
        let parts = calendar.dateComponents([.hour, .minute], from: instant)
        return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    }

    /// Nearest quarter hour, clamped into the day.
    public static func snap(_ minutes: Int, step: Int = snapMinutes) -> Int {
        let rounded = Int((Double(minutes) / Double(step)).rounded()) * step
        return max(0, min(24 * 60 - step, rounded))
    }

    /// The same task, now at a time on a day.
    ///
    /// Built from local date components rather than by joining a `Z` on the
    /// end, so dropping a task at 09:00 means nine in the morning where the
    /// person dropping it is standing.
    public static func at(
        day: String, minutes: Int, from: Due? = nil, calendar: Calendar = .current
    ) -> Due {
        var parts = components(of: day)
        parts.hour = 0
        parts.minute = minutes
        let when = calendar.date(from: parts) ?? Date()
        return Due(date: ISO8601DateFormatter.lightWeek.string(from: when),
                   hasTime: true,
                   text: from?.text,
                   timezone: from?.timezone,
                   isRecurring: from?.isRecurring ?? false)
    }

    /// The same task, on a day but at no particular time.
    public static func at(day: String, from: Due? = nil) -> Due {
        Due(date: String(day.prefix(10)), hasTime: false, text: from?.text,
            timezone: from?.timezone, isRecurring: from?.isRecurring ?? false)
    }

    /// `09:30`, for a label. Minutes past midnight in, clock face out.
    public static func clock(_ minutes: Int) -> String {
        String(format: "%02d:%02d", (minutes / 60) % 24, minutes % 60)
    }

    /// The day `offset` days from `day`, counted on the calendar.
    public static func shift(day: String, by offset: Int, calendar: Calendar = .current) -> String {
        guard let date = calendar.date(from: components(of: day)),
              let moved = calendar.date(byAdding: .day, value: offset, to: date)
        else { return day }
        return localDay(moved, calendar: calendar)
    }

    /// How long a block should be, in minutes.
    ///
    /// A task with no estimate still has to be big enough to grab, and one
    /// estimated in days is a body of work rather than a sitting — showing it
    /// as an eight-hour block would bury the day under one task.
    public static func blockMinutes(_ duration: Duration?) -> Int {
        guard let duration, duration.unit == .minute else { return 30 }
        return max(snapMinutes, duration.amount)
    }

    /// Overlap, resolved into columns.
    ///
    /// The same sweep as `layOut` in the web's `Day.tsx`: a block goes into
    /// the first column whose last block has already finished, and every block
    /// in a run of overlaps shares the width of that run. Two tasks at the
    /// same hour cannot both have the full width, or one of them would be
    /// invisible.
    public static func layOut(_ timed: [Task]) -> [String: (column: Int, columns: Int)] {
        struct Block { let id: String; let start: Int; let end: Int; var column = 0 }

        let sorted = timed
            .map { task -> Block in
                let start = minutes(of: task.due) ?? 0
                return Block(id: task.id, start: start, end: start + blockMinutes(task.duration))
            }
            .sorted { $0.start != $1.start ? $0.start < $1.start : $0.end < $1.end }

        var placed: [String: (column: Int, columns: Int)] = [:]
        var run: [Block] = []
        var runEnd = -1

        func flush() {
            let columns = run.reduce(1) { max($0, $1.column + 1) }
            for block in run { placed[block.id] = (block.column, columns) }
            run = []
            runEnd = -1
        }

        for var block in sorted {
            // A block starting after everything so far has ended begins a new
            // run, and the previous run's width is settled.
            if block.start >= runEnd { flush() }

            let taken = Set(run.filter { $0.end > block.start }.map(\.column))
            var column = 0
            while taken.contains(column) { column += 1 }
            block.column = column

            run.append(block)
            runEnd = max(runEnd, block.end)
        }
        flush()

        return placed
    }

    private static func components(of day: String) -> DateComponents {
        let parts = day.prefix(10).split(separator: "-").map { Int($0) ?? 1 }
        var out = DateComponents()
        out.year = parts.count > 0 ? parts[0] : 1970
        out.month = parts.count > 1 ? parts[1] : 1
        out.day = parts.count > 2 ? parts[2] : 1
        return out
    }
}

extension ISO8601DateFormatter {
    /// The same instants, without fractional seconds.
    ///
    /// The web writes `toISOString()`, which always has milliseconds, but an
    /// instant that came from anywhere else may not — and a parser set to
    /// require them returns nil rather than being lenient.
    public static let lightWeekWhole: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
