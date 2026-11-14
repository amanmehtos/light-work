import Foundation

/// Today and Upcoming, as days.
///
/// The Swift twin of `apps/web/src/days.ts` and of `packages/client-sdk/src/day-order.ts`,
/// for the same reason `Outline` is a twin: it is a rule about what the account
/// *means*, and two clients that read it differently show the same tasks in
/// different places. The cases in `AgendaTests` are the web's.
///
/// - **What a day's list sorts by**: `dayOrder` when the task has one, `order`
///   otherwise, ties broken by id. `dayOrder` is what lets Today be arranged
///   without arranging any project; this client only *reads* it — reordering
///   stays on the web this phase, because a failed push would visibly reshuffle
///   a list the person had just arranged (this client is not local-first).
/// - **Today** is every open task due on or before today. Overdue work is on it
///   and on no other day.
/// - **Upcoming** is a group per day: the next week's days whether or not
///   anything is due, then each later day that has work.
/// - **The count is the rows.** Every count on the home list is the length of
///   what its screen renders, read off the same call, so a badge and its list
///   cannot disagree. `Outline.arrange` never drops a task, a day is the
///   arrangement of that day's list, and every upcoming task is on one day.
public enum Agenda {

    /// Days ahead that always have a heading, whether or not anything is due.
    public static let lookaheadDays = 7

    /// What a task sorts by in a day's list.
    public static func key(_ task: Task) -> String {
        task.dayOrder ?? task.order
    }

    /// Plain string comparison, as `compareOrder` does on the web; the id only
    /// breaks a tie, so the same list reads the same on every device.
    public static func inDayOrder(_ a: Task, _ b: Task) -> Bool {
        let (left, right) = (key(a), key(b))
        return left == right ? a.id < b.id : left < right
    }

    /// The open tasks on a day's list, in the order they are drawn.
    ///
    /// `today` decides whether overdue work belongs: it does on today's list and
    /// on no other day's.
    public static func tasks(
        on day: String, today: String, among tasks: [Task], calendar: Calendar = .current
    ) -> [Task] {
        tasks
            .filter { task in
                guard !task.isCompleted, let due = Schedule.day(of: task.due, calendar: calendar) else {
                    return false
                }
                return day == today ? due <= day : due == day
            }
            .sorted(by: inDayOrder)
    }

    /// Today, arranged around its subtasks. `all` is every task the account holds.
    public static func today(
        open: [Task], today: String, among all: [Task], calendar: Calendar = .current
    ) -> [Outline.Row] {
        Outline.arrange(tasks(on: today, today: today, among: open, calendar: calendar), among: all)
    }

    /// One day of Upcoming.
    public struct DayGroup: Identifiable, Equatable, Sendable {
        /// `YYYY-MM-DD`, the local calendar day.
        public var day: String
        public var rows: [Outline.Row]

        public var id: String { day }
    }

    /// Upcoming, a group per day, earliest first. Today's own work and the
    /// overdue are `today`'s, not these.
    public static func upcoming(
        open: [Task], today: String, among all: [Task], calendar: Calendar = .current
    ) -> [DayGroup] {
        var days: Set<String> = []
        for step in 1...lookaheadDays {
            days.insert(Schedule.shift(day: today, by: step, calendar: calendar))
        }
        for task in open {
            if let due = Schedule.day(of: task.due, calendar: calendar), due > today { days.insert(due) }
        }
        return days.sorted().map { day in
            DayGroup(day: day, rows: Outline.arrange(
                tasks(on: day, today: today, among: open, calendar: calendar), among: all))
        }
    }

    /// Every row the groups hold, folded ones included: what a count is the length of.
    public static func count(_ groups: [DayGroup]) -> Int {
        groups.reduce(0) { $0 + $1.rows.count }
    }

    /// The rows that are on the screen.
    public static func onScreen(_ groups: [DayGroup]) -> [Outline.Row] {
        groups.flatMap { $0.rows.filter { !$0.isHidden } }
    }
}
