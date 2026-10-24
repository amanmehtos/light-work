import XCTest
@testable import LightKit

/// These mirror the TypeScript tests for the same primitives. The two
/// implementations have to agree byte for byte — a clock that encodes
/// differently on iOS sorts differently on the server, and the conflict
/// resolution quietly stops matching.
final class ClockTests: XCTestCase {
    func testEncodingMatchesTheTypeScriptFormat() {
        let hlc = HLC(wall: 1_761_300_000_000, counter: 7, node: "device-a")
        let encoded = hlc.encoded
        XCTAssertEqual(encoded.split(separator: ":").count, 3)
        XCTAssertEqual(HLC(encoded: encoded), hlc)
    }

    func testEncodedClocksSortLikeComparedOnes() {
        let clocks = [
            HLC(wall: 1, counter: 0, node: "a"),
            HLC(wall: 1, counter: 1, node: "a"),
            HLC(wall: 1, counter: 1, node: "b"),
            HLC(wall: 2, counter: 0, node: "a"),
            HLC(wall: 1_761_300_000_000, counter: 0, node: "a"),
        ]
        XCTAssertEqual(clocks.sorted().map(\.encoded), clocks.map(\.encoded).sorted())
    }

    func testTimestampsIncreaseEvenWithAFrozenDeviceClock() {
        let clock = Clock(node: "device-a", now: { 1000 })
        var previous = clock.next()
        for _ in 0..<100 {
            let next = clock.next()
            XCTAssertTrue(previous < next)
            previous = next
        }
    }

    func testOrdersItsOwnEventsAfterAnythingObserved() {
        let clock = Clock(node: "device-a", now: { 1000 })
        let remote = HLC(wall: 5000, counter: 2, node: "device-b")
        clock.observe(remote)
        XCTAssertTrue(remote < clock.next())
    }

    func testRejectsAMalformedClock() {
        XCTAssertNil(HLC(encoded: "nope"))
    }
}

final class FocusSessionTests: XCTestCase {
    func testEncodesTheFieldNamesTheServerExpects() throws {
        let session = FocusSession(
            taskId: "t1",
            startedAt: Date(timeIntervalSince1970: 1_761_300_000),
            endedAt: Date(timeIntervalSince1970: 1_761_301_500),
            plannedSeconds: 1500,
            focusedSeconds: 1500,
            source: "light-minute-ios")

        let data = try JSONEncoder().encode(session)
        let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(decoded?["taskId"] as? String, "t1")
        XCTAssertEqual(decoded?["plannedSeconds"] as? Int, 1500)
        XCTAssertEqual(decoded?["focusedSeconds"] as? Int, 1500)
        XCTAssertEqual(decoded?["kind"] as? String, "focus")
        XCTAssertEqual(decoded?["outcome"] as? String, "completed")
        XCTAssertEqual(decoded?["source"] as? String, "light-minute-ios")
    }

    func testBreakKindsUseTheSnakeCaseTheProtocolUses() throws {
        XCTAssertEqual(FocusSession.Kind.shortBreak.rawValue, "short_break")
        XCTAssertEqual(FocusSession.Kind.longBreak.rawValue, "long_break")
    }
}

final class PriorityTests: XCTestCase {
    func testOneIsUrgent() {
        // The opposite of Todoist's internal scale, and the single most likely
        // thing for an integration to get backwards.
        XCTAssertEqual(Priority.urgent.rawValue, 1)
        XCTAssertEqual(Priority.none.rawValue, 4)
    }
}
