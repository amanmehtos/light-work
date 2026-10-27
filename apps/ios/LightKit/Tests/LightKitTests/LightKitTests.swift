import XCTest
@testable import LightKit

/// These mirror the TypeScript tests for the same primitives. The two
/// implementations have to agree byte for byte — a clock that encodes
/// differently on iOS sorts differently on the server, and the conflict
/// resolution quietly stops matching.
final class ClockTests: XCTestCase {
    /// The expected strings were produced by running `encodeHLC` from
    /// `packages/core/src/hlc.ts` on exactly these inputs, and pasted in.
    ///
    /// That provenance is the whole point. Asserting the shape — three parts,
    /// round-trips cleanly — is what this test used to do, and it would pass
    /// with the padding widths wrong, which is the one thing that actually
    /// breaks: a clock that pads differently sorts differently as a string,
    /// and conflict resolution quietly stops agreeing across platforms.
    ///
    /// The cases cover the base-36 carries, where an off-by-one in the width
    /// would show: 1295 is "zz" and 1296 rolls over to "100".
    func testEncodingMatchesVectorsFromTheTypeScript() {
        let vectors: [(HLC, String)] = [
            (HLC(wall: 0, counter: 0, node: "nabc0123456"), "00000000000:00000:nabc0123456"),
            (HLC(wall: 1, counter: 1, node: "nzzzzzzzzzz"), "00000000001:00001:nzzzzzzzzzz"),
            (HLC(wall: 35, counter: 35, node: "n0"), "0000000000z:0000z:n0"),
            (HLC(wall: 36, counter: 36, node: "n1"), "00000000010:00010:n1"),
            (HLC(wall: 1_761_609_600_000, counter: 0, node: "nq7x2k9mdp1"),
             "000mh9sveo0:00000:nq7x2k9mdp1"),
            (HLC(wall: 1_761_609_600_123, counter: 1295, node: "nq7x2k9mdp1"),
             "000mh9sverf:000zz:nq7x2k9mdp1"),
            (HLC(wall: 1_761_609_600_123, counter: 1296, node: "nq7x2k9mdp1"),
             "000mh9sverf:00100:nq7x2k9mdp1"),
            (HLC(wall: 9_007_199_254_740_991, counter: 60_466_175, node: "nmax"),
             "2gosa7pa2gv:zzzzz:nmax"),
        ]
        for (clock, expected) in vectors {
            XCTAssertEqual(clock.encoded, expected)
            XCTAssertEqual(HLC(encoded: expected), clock, "did not survive a round trip")
        }
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
