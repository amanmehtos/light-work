import XCTest
@testable import LightKit

/// The conversions between a calendar day and an instant.
///
/// The same cases as `apps/web/test/schedule.test.ts`, for the same reason:
/// the bug being guarded against is invisible in a London afternoon and wrong
/// everywhere else. Everything goes through a round trip rather than an
/// expected literal, so the suite passes in whatever zone it runs in.
final class ScheduleTests: XCTestCase {

    func testReadsAnAllDayDateStraightOff() {
        XCTAssertEqual(Schedule.day(of: Schedule.at(day: "2026-11-03")), "2026-11-03")
    }

    func testKeepsATimedTaskOnTheLocalDayItWasPutOn() {
        // 23:00 and 00:30 are the two that cross the date line in UTC, in one
        // direction or the other, from almost anywhere.
        XCTAssertEqual(Schedule.day(of: Schedule.at(day: "2026-11-03", minutes: 23 * 60)),
                       "2026-11-03")
        XCTAssertEqual(Schedule.day(of: Schedule.at(day: "2026-11-03", minutes: 30)),
                       "2026-11-03")
    }

    func testIsNilWhenNothingIsScheduled() {
        XCTAssertNil(Schedule.day(of: nil))
        XCTAssertNil(Schedule.minutes(of: nil))
    }

    func testRoundTripsATimeOfDay() {
        for minutes in [0, 9 * 60 + 30, 23 * 60 + 45] {
            XCTAssertEqual(Schedule.minutes(of: Schedule.at(day: "2026-11-03", minutes: minutes)),
                           minutes)
        }
    }

    func testAnAllDayTaskHasNoTimeToGive() {
        XCTAssertNil(Schedule.minutes(of: Schedule.at(day: "2026-11-03")))
    }

    func testReadsAnInstantWithoutFractionalSeconds() {
        // Not everything that reaches this field was written by the web.
        let whole = Due(date: "2026-11-03T09:30:00Z", hasTime: true)
        XCTAssertNotNil(Schedule.minutes(of: whole))
    }

    func testCarriesTheRecurrencePhraseAcrossSoARepeatSurvivesADrag() {
        let repeating = Due(date: "2026-11-03", text: "every monday", isRecurring: true)
        let moved = Schedule.at(day: "2026-11-03", minutes: 600, from: repeating)
        XCTAssertEqual(moved.text, "every monday")
        XCTAssertTrue(moved.isRecurring)
    }

    func testDroppingBackOnTheRailKeepsTheDayButLosesTheTime() {
        let timed = Schedule.at(day: "2026-11-03", minutes: 14 * 60)
        let railed = Schedule.at(day: Schedule.day(of: timed)!, from: timed)
        XCTAssertFalse(railed.hasTime)
        XCTAssertEqual(railed.date, "2026-11-03")
    }

    func testSnapsToTheNearestQuarterHour() {
        XCTAssertEqual(Schedule.snap(7), 0)
        XCTAssertEqual(Schedule.snap(8), 15)
        XCTAssertEqual(Schedule.snap(9 * 60 + 22), 9 * 60 + 15)
    }

    func testNeverSnapsOutsideTheDay() {
        XCTAssertEqual(Schedule.snap(-40), 0)
        XCTAssertEqual(Schedule.snap(24 * 60 + 90), 23 * 60 + 45)
    }

    func testPadsBothHalvesOfTheClock() {
        XCTAssertEqual(Schedule.clock(0), "00:00")
        XCTAssertEqual(Schedule.clock(9 * 60 + 5), "09:05")
        XCTAssertEqual(Schedule.clock(23 * 60 + 45), "23:45")
    }

    func testShiftsOnTheCalendarAcrossAMonthAndAYear() {
        XCTAssertEqual(Schedule.shift(day: "2026-11-03", by: 1), "2026-11-04")
        XCTAssertEqual(Schedule.shift(day: "2026-11-30", by: 1), "2026-12-01")
        XCTAssertEqual(Schedule.shift(day: "2026-01-01", by: -1), "2025-12-31")
        XCTAssertEqual(Schedule.shift(day: "2028-02-28", by: 1), "2028-02-29")
    }

    func testGivesAnUnestimatedTaskSomethingGrabbable() {
        XCTAssertEqual(Schedule.blockMinutes(nil), 30)
    }

    func testUsesAMinuteEstimateAsGiven() {
        XCTAssertEqual(Schedule.blockMinutes(Duration(amount: 90)), 90)
    }

    func testRefusesToTurnAMultiDayTaskIntoABlockThatBuriesTheDay() {
        XCTAssertEqual(Schedule.blockMinutes(Duration(amount: 2, unit: .day)), 30)
    }

    func testFloorsATinyEstimateAtOneSlotSoItCanStillBeHit() {
        XCTAssertEqual(Schedule.blockMinutes(Duration(amount: 5)), 15)
    }
}
