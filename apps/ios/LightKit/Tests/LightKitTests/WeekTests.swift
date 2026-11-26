import XCTest
@testable import LightKit

/// Light Week's arithmetic, against the same cases as `apps/web/test/week.test.ts`.
///
/// The bucketing tests are the owner's complaint written down: an undated task
/// appeared in Waiting, and Waiting is only for a task with a date and no time.
final class WeekTests: XCTestCase {

    private func task(_ id: String, due: Due?, done: Bool = false) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: "p1", sectionId: nil, parentId: nil, content: id,
            description: "", priority: .none, order: "V", due: due,
            deadline: nil, duration: nil, labelIds: [],
            reward: nil, isCompleted: done, completedAt: nil,
            createdAt: "2026-11-01T00:00:00.000Z")
    }

    // MARK: - Which days

    func testAWeekStartsOnTheMondayOnOrBeforeTheDay() {
        // 2026-11-26 is a Thursday.
        XCTAssertEqual(Schedule.weekStart(of: "2026-11-26"), "2026-11-23")
        XCTAssertEqual(Schedule.weekStart(of: "2026-11-23"), "2026-11-23")
    }

    func testASundayEndsItsWeekRatherThanStartingTheNext() {
        XCTAssertEqual(Schedule.weekStart(of: "2026-11-29"), "2026-11-23")
    }

    func testAWeekCrossesAMonthAndAYear() {
        XCTAssertEqual(Schedule.weekStart(of: "2027-01-01"), "2026-12-28")
        XCTAssertEqual(Schedule.week(from: "2026-12-28"), [
            "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31",
            "2027-01-01", "2027-01-02", "2027-01-03",
        ])
    }

    // MARK: - Which tasks

    private let days = Schedule.week(from: "2026-11-23")

    func testAnUndatedTaskIsNotInTheWeekAtAll() {
        let byDay = Schedule.bucket([task("undated", due: nil)], into: days)
        for day in days {
            XCTAssertEqual(byDay[day]?.waiting.count, 0)
            XCTAssertEqual(byDay[day]?.timed.count, 0)
        }
    }

    func testADatedUntimedTaskWaitsOnItsOwnDay() {
        let byDay = Schedule.bucket([task("a", due: Schedule.at(day: "2026-11-25"))], into: days)
        XCTAssertEqual(byDay["2026-11-25"]?.waiting.map(\.id), ["a"])
        XCTAssertEqual(byDay["2026-11-25"]?.timed.count, 0)
        XCTAssertEqual(byDay["2026-11-24"]?.waiting.count, 0)
    }

    func testATimedTaskIsInTheHoursEarliestFirst() {
        let byDay = Schedule.bucket([
            task("late", due: Schedule.at(day: "2026-11-24", minutes: 15 * 60)),
            task("early", due: Schedule.at(day: "2026-11-24", minutes: 9 * 60)),
        ], into: days)
        XCTAssertEqual(byDay["2026-11-24"]?.timed.map(\.id), ["early", "late"])
        XCTAssertEqual(byDay["2026-11-24"]?.waiting.count, 0)
    }

    func testWhatIsDoneOrInAnotherWeekIsLeftOut() {
        let byDay = Schedule.bucket([
            task("done", due: Schedule.at(day: "2026-11-24"), done: true),
            task("next", due: Schedule.at(day: "2026-11-30")),
        ], into: days)
        XCTAssertTrue(byDay.values.allSatisfy { $0.waiting.isEmpty && $0.timed.isEmpty })
    }

    // MARK: - Snapping

    func testASlotSnapsToTheQuarterHour() {
        XCTAssertEqual(Schedule.slot(at: 9 * 60 + 7, grab: 0, length: 30), 9 * 60)
        XCTAssertEqual(Schedule.slot(at: 9 * 60 + 8, grab: 0, length: 30), 9 * 60 + 15)
    }

    func testASlotKeepsTheGrabUnderTheFinger() {
        XCTAssertEqual(Schedule.slot(at: 10 * 60 + 20, grab: 20, length: 60), 10 * 60)
    }

    func testASlotKeepsTheWholeBlockInTheDay() {
        XCTAssertEqual(Schedule.slot(at: 23 * 60 + 50, grab: 0, length: 60), 23 * 60)
        XCTAssertEqual(Schedule.slot(at: 23 * 60 + 50, grab: 0, length: 50), 23 * 60)
        XCTAssertEqual(Schedule.slot(at: -30, grab: 0, length: 30), 0)
    }

    // MARK: - The day while a block is in hand

    private func at(_ id: String, _ start: Int, _ length: Int) -> Schedule.Span {
        Schedule.Span(id: id, start: start, end: start + length)
    }

    func testABlockHoveringOverAnotherIsGivenRoomBesideIt() {
        let live = Schedule.layOut(spans: Schedule.preview(
            [at("a", 540, 60)], day: "2026-11-24", moving: ("m", 60),
            landing: .slot(day: "2026-11-24", minutes: 570)))
        XCTAssertEqual(live["a"]?.column, 0)
        XCTAssertEqual(live["a"]?.columns, 2)
        XCTAssertEqual(live["m"]?.column, 1)
    }

    func testADayGetsItsWidthBackWhenTheBlockInHandLeavesIt() {
        let spans = [at("a", 540, 60), at("m", 540, 60)]
        let elsewhere = Schedule.preview(spans, day: "2026-11-24", moving: ("m", 60),
                                         landing: .slot(day: "2026-11-25", minutes: 540))
        XCTAssertEqual(elsewhere, [at("a", 540, 60)])
        XCTAssertEqual(Schedule.layOut(spans: elsewhere)["a"]?.columns, 1)
    }

    func testABlockMovedWithinItsDayIsNotCountedTwice() {
        let spans = [at("a", 540, 60), at("m", 540, 60)]
        let moved = Schedule.preview(spans, day: "2026-11-24", moving: ("m", 60),
                                     landing: .slot(day: "2026-11-24", minutes: 720))
        XCTAssertEqual(moved, [at("a", 540, 60), at("m", 720, 60)])
    }

    func testABlockOverAStripLeavesTheHours() {
        let spans = [at("a", 540, 60), at("m", 540, 60)]
        XCTAssertEqual(Schedule.preview(spans, day: "2026-11-24", moving: ("m", 60),
                                        landing: .strip(day: "2026-11-24")), [at("a", 540, 60)])
    }

    func testNothingInHandLeavesTheDayAsItIs() {
        let spans = [at("a", 540, 60), at("m", 540, 60)]
        XCTAssertEqual(Schedule.preview(spans, day: "2026-11-24", moving: nil, landing: nil), spans)
        XCTAssertEqual(Schedule.preview(spans, day: "2026-11-24", moving: ("m", 60), landing: nil), spans)
    }
}
