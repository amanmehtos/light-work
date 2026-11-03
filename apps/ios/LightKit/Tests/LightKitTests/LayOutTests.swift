import XCTest
@testable import LightKit

/// The overlap sweep, against the same cases as `apps/web/test/lay-out.test.ts`.
///
/// The rule is that a *run* of overlaps shares its width: two tasks at nine
/// o'clock each get half, and a third at ten on its own gets all of it back.
/// Getting that wrong makes a calendar either hide a task or leave a day
/// looking half empty.
final class LayOutTests: XCTestCase {

    private func task(_ id: String, at start: Int, for length: Int) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: "p1", sectionId: nil, parentId: nil, content: id,
            description: "", priority: .none, order: "V",
            due: Schedule.at(day: "2026-11-03", minutes: start),
            deadline: nil, duration: Duration(amount: length), labelIds: [],
            reward: nil, isCompleted: false, completedAt: nil,
            createdAt: "2026-11-01T00:00:00.000Z")
    }

    func testGivesATaskOnItsOwnTheFullWidth() {
        let placed = Schedule.layOut([task("a", at: 540, for: 60)])
        XCTAssertEqual(placed["a"]?.column, 0)
        XCTAssertEqual(placed["a"]?.columns, 1)
    }

    func testSplitsTheWidthBetweenTwoThatOverlap() {
        let placed = Schedule.layOut([task("a", at: 540, for: 60), task("b", at: 570, for: 60)])
        XCTAssertEqual(placed["a"]?.column, 0)
        XCTAssertEqual(placed["b"]?.column, 1)
        XCTAssertEqual(placed["a"]?.columns, 2)
        XCTAssertEqual(placed["b"]?.columns, 2)
    }

    func testGivesTheWidthBackOnceTheOverlapIsOver() {
        let placed = Schedule.layOut([
            task("a", at: 540, for: 60), task("b", at: 570, for: 60), task("c", at: 720, for: 30),
        ])
        XCTAssertEqual(placed["c"]?.column, 0)
        XCTAssertEqual(placed["c"]?.columns, 1)
    }

    func testReusesAColumnThatHasFinished() {
        // b overlaps a; c starts after a ends but while b is still running, so
        // it belongs in a's column rather than a third one.
        let placed = Schedule.layOut([
            task("a", at: 540, for: 30), task("b", at: 550, for: 120), task("c", at: 580, for: 30),
        ])
        XCTAssertEqual(placed["c"]?.column, 0)
        XCTAssertEqual(placed["c"]?.columns, 2)
    }

    func testTreatsTouchingBlocksAsNotOverlapping() {
        // 09:00–10:00 and 10:00–11:00 are back to back, not on top of each other.
        let placed = Schedule.layOut([task("a", at: 540, for: 60), task("b", at: 600, for: 60)])
        XCTAssertEqual(placed["a"]?.columns, 1)
        XCTAssertEqual(placed["b"]?.columns, 1)
    }

    func testDoesNotDependOnTheOrderItIsGivenThem() {
        let a = task("a", at: 540, for: 60)
        let b = task("b", at: 570, for: 60)
        let forwards = Schedule.layOut([a, b])
        let backwards = Schedule.layOut([b, a])
        XCTAssertEqual(forwards["a"]?.column, backwards["a"]?.column)
        XCTAssertEqual(forwards["b"]?.column, backwards["b"]?.column)
        XCTAssertEqual(forwards["a"]?.columns, backwards["a"]?.columns)
    }

    func testHandlesThreeAtOnce() {
        let placed = Schedule.layOut([
            task("a", at: 540, for: 90), task("b", at: 550, for: 90), task("c", at: 560, for: 90),
        ])
        XCTAssertEqual(placed.values.map(\.columns), [3, 3, 3])
        XCTAssertEqual(placed.values.map(\.column).sorted(), [0, 1, 2])
    }

    func testAnUnestimatedBlockStillTakesUpHalfAnHour() {
        // Which is what makes it overlap the one starting fifteen minutes
        // later, rather than appearing to sit beside it.
        var short = task("a", at: 540, for: 30)
        short.duration = nil
        let placed = Schedule.layOut([short, task("b", at: 555, for: 30)])
        XCTAssertEqual(placed["a"]?.columns, 2)
    }
}
