import XCTest
@testable import LightKit

/// Today, Upcoming and the project list: the web's cases, held to the same
/// answers (see `apps/web/test/days.test.ts`).
final class AgendaTests: XCTestCase {

    private let today = "2026-11-14" // a Saturday

    private func due(_ date: String?) -> Due? {
        date.map { Due(date: $0, hasTime: false, text: nil, timezone: nil, isRecurring: false) }
    }

    private func task(
        _ id: String, _ date: String?, order: String? = nil, dayOrder: String? = nil,
        parent: String? = nil, collapsed: Bool = false, done: Bool = false
    ) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: "p", sectionId: nil, parentId: parent, content: id, description: "",
            priority: .none, order: order ?? id, due: due(date), deadline: nil, duration: nil,
            labelIds: [], reward: nil, isCompleted: done, completedAt: nil,
            createdAt: "2026-11-01T00:00:00.000Z", dayOrder: dayOrder, isCollapsed: collapsed)
    }

    private func ids(_ rows: [Outline.Row]) -> [String] { rows.map(\.task.id) }

    private func upcoming(_ all: [LightKit.Task]) -> [Agenda.DayGroup] {
        Agenda.upcoming(open: all.filter { !$0.isCompleted }, today: today, among: all)
    }

    private func shape(_ groups: [Agenda.DayGroup]) -> [String] {
        groups.filter { !$0.rows.isEmpty }.map { "\($0.day): \(ids($0.rows).joined(separator: ","))" }
    }

    // MARK: - the order of a day

    func testADaySortsByDayOrderWhereSetAndOrderOtherwise() {
        let all = [
            task("a", "2026-11-16", order: "a"),
            task("b", "2026-11-16", order: "c"),
            // Filed last, but arranged on the web to sit between the other two.
            task("c", "2026-11-16", order: "e", dayOrder: "b"),
        ]
        XCTAssertEqual(shape(upcoming(all)), ["2026-11-16: a,c,b"])
    }

    func testTiesAreBrokenByIdSoEveryDeviceReadsTheSameList() {
        let all = [task("b", TODAY, order: "V"), task("a", TODAY, order: "V")]
        XCTAssertEqual(ids(Agenda.today(open: all, today: today, among: all)), ["a", "b"])
    }

    private let TODAY = "2026-11-14"

    // MARK: - what is on which list

    func testTodayHoldsOverdueAndTodayAndNothingElse() {
        let all = [task("late", "2026-11-01"), task("now", TODAY), task("soon", "2026-11-15"),
                   task("never", nil), task("done", TODAY, done: true)]
        let open = all.filter { !$0.isCompleted }
        XCTAssertEqual(Set(ids(Agenda.today(open: open, today: today, among: all))), ["late", "now"])
    }

    func testUpcomingLeavesTodayOverdueAndUndatedAlone() {
        let all = [task("late", "2026-11-01"), task("now", TODAY), task("never", nil), task("soon", "2026-11-15")]
        XCTAssertEqual(shape(upcoming(all)), ["2026-11-15: soon"])
    }

    func testUpcomingHasAHeadingForEachOfTheNextWeeksDaysAndThenLaterDaysWithWork() {
        XCTAssertEqual(upcoming([]).map(\.day), [
            "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18",
            "2026-11-19", "2026-11-20", "2026-11-21",
        ])
        let all = [task("far", "2027-01-05"), task("mid", "2026-12-01")]
        XCTAssertEqual(upcoming(all).map(\.day).suffix(2), ["2026-12-01", "2027-01-05"])
    }

    func testASubtaskNestsUnderItsParentWithinADayAndStandsAloneAcrossDays() {
        let all = [task("p", "2026-11-16"), task("c", "2026-11-16", parent: "p"),
                   task("x", "2026-11-17"), task("away", "2026-11-19", parent: "x")]
        let groups = upcoming(all)
        let monday = groups.first { $0.day == "2026-11-16" }!
        XCTAssertEqual(monday.rows.map(\.depth), [0, 1])
        let thursday = groups.first { $0.day == "2026-11-19" }!
        XCTAssertEqual(thursday.rows.first?.depth, 0)
        XCTAssertEqual(thursday.rows.first?.parentTitle, "x")
    }

    // MARK: - the count is the rows

    func testTheCountIsEveryRowIncludingFoldedOnesAndEqualsTheArrangement() {
        let all = [
            task("p", "2026-11-16", collapsed: true),
            task("c1", "2026-11-16", parent: "p"),
            task("gc", "2026-11-16", parent: "c1"),
            task("x", "2026-11-17"),
            task("away", "2026-11-19", parent: "x"),
            task("orphan", "2026-11-19", parent: "deleted"),
            task("ca", "2026-11-20", parent: "cb"),
            task("cb", "2026-11-20", parent: "ca"),
            task("late", "2026-11-01"),
            task("never", nil),
            task("far", "2027-03-03"),
        ]
        let groups = upcoming(all)
        let upcomingTasks = all.filter { t in
            guard let due = Schedule.day(of: t.due) else { return false }
            return due > today
        }
        XCTAssertEqual(Agenda.count(groups), upcomingTasks.count)
        XCTAssertEqual(Agenda.count(groups), Outline.arrange(upcomingTasks, among: all).count)

        // The screen shows fewer: gc and c1 are inside the folded p.
        XCTAssertLessThan(Agenda.onScreen(groups).count, Agenda.count(groups))
        XCTAssertFalse(ids(Agenda.onScreen(groups)).contains("c1"))
        XCTAssertFalse(Agenda.onScreen(groups).contains { $0.isHidden })

        // Every upcoming task is on exactly one day.
        let everyId = groups.flatMap { ids($0.rows) }
        XCTAssertEqual(Set(everyId).count, everyId.count)

        // And a chevron does not move it.
        let unfolded = all.map { t -> LightKit.Task in var t = t; t.isCollapsed = false; return t }
        XCTAssertEqual(Agenda.count(upcoming(unfolded)), Agenda.count(groups))
    }

    // MARK: - the project list

    private func project(
        _ id: String, _ name: String, parent: String? = nil, order: String? = nil,
        inbox: Bool = false, rewards: Bool = false, archived: Bool = false
    ) -> Project {
        Project(id: id, parentId: parent, name: name, color: "charcoal", order: order ?? id,
                isFavorite: false, isArchived: archived, isInbox: inbox, isRewards: rewards, description: "")
    }

    private func tree(_ projects: [Project], rewards: Bool = true) -> [String] {
        Navigation.projectTree(projects, rewardsEnabled: rewards)
            .map { String(repeating: "-", count: $0.depth) + $0.project.id }
    }

    func testTheTreeIsDepthFirstInOrderAndLeavesTheInboxOut() {
        let projects = [
            project("i", "Inbox", inbox: true),
            project("b", "B", order: "b"), project("a", "A", order: "a"),
            project("a2", "A2", parent: "a", order: "b"), project("a1", "A1", parent: "a", order: "a"),
            project("a1x", "deep", parent: "a1"),
        ]
        XCTAssertEqual(tree(projects), ["a", "-a1", "--a1x", "-a2", "b"])
    }

    func testAProjectFiledUnderTheInboxRisesToTheTopLevel() {
        let projects = [project("i", "Inbox", inbox: true), project("k", "Kept", parent: "i")]
        XCTAssertEqual(tree(projects), ["k"])
    }

    func testInboxIsByFlagAndTheLowestIdWinsWhenThereAreTwo() {
        let projects = [project("z", "Inbox", inbox: true), project("m", "Inbox", inbox: true),
                        project("n", "Inbox")]
        XCTAssertEqual(Navigation.inbox(projects)?.id, "m")
        // The stray flagged one is not drawn; the one merely called Inbox is a project.
        XCTAssertEqual(tree(projects), ["n"])
    }

    func testArchivedProjectsAndTheSwitchedOffTrophyCabinetAreLeftOut() {
        let projects = [project("a", "A"), project("old", "Old", archived: true),
                        project("t", "Rewards", rewards: true)]
        XCTAssertEqual(tree(projects, rewards: true), ["a", "t"])
        XCTAssertEqual(tree(projects, rewards: false), ["a"])
    }
}
