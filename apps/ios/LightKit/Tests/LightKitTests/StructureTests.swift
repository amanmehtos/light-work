import XCTest
@testable import LightKit

/// Sections, folding, and what the snapshot may now contain.
///
/// Everything here is additive on the wire. The server already syncs
/// `Section`, `Task.dayOrder` and both `isCollapsed` flags, and an account that
/// has been around since before them has rows without the keys. A phone that
/// failed to decode one of those rows would show nothing at all, so the first
/// half of this file is about *not* failing.
final class StructureDecodingTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // A task as it was stored before `dayOrder` and `isCollapsed` were read.
    private let olderTask = """
    {"id":"t1","projectId":"p1","sectionId":null,"parentId":null,"content":"Ready the deck",
     "description":"","priority":4,"order":"V","due":null,"deadline":null,"duration":null,
     "labelIds":[],"isCompleted":false,"completedAt":null,"createdAt":"2026-11-01T00:00:00.000Z"}
    """

    func testAnOlderTaskWithoutTheNewKeysStillDecodes() throws {
        let task = try decode(LightKit.Task.self, olderTask)
        XCTAssertEqual(task.content, "Ready the deck")
        XCTAssertNil(task.dayOrder)
        XCTAssertFalse(task.isCollapsed, "absent means not folded")
    }

    func testTheNewKeysAreReadWhenTheyArePresent() throws {
        let json = olderTask.replacingOccurrences(
            of: "\"createdAt\"", with: "\"dayOrder\":\"Vk\",\"isCollapsed\":true,\"createdAt\"")
        let task = try decode(LightKit.Task.self, json)
        XCTAssertEqual(task.dayOrder, "Vk")
        XCTAssertTrue(task.isCollapsed)
    }

    func testKeysTheModelDoesNotKnowAreStillIgnored() throws {
        // The other direction: what the web sends that this has no field for.
        let json = olderTask.replacingOccurrences(
            of: "\"createdAt\"", with: "\"assigneeId\":null,\"addedById\":null,\"createdAt\"")
        XCTAssertNoThrow(try decode(LightKit.Task.self, json))
    }

    func testATaskSurvivesAnEncodeAndDecode() throws {
        var task = try decode(LightKit.Task.self, olderTask)
        task.isCollapsed = true
        task.dayOrder = "Vk"
        let again = try decode(LightKit.Task.self, String(data: JSONEncoder().encode(task), encoding: .utf8)!)
        XCTAssertEqual(again, task)
    }

    func testASectionDecodes() throws {
        let section = try decode(Section.self, """
        {"id":"s1","projectId":"p1","name":"Phase one","description":"the plan","order":"V",
         "isArchived":false,"isCollapsed":true}
        """)
        XCTAssertEqual(section.name, "Phase one")
        XCTAssertEqual(section.description, "the plan")
        XCTAssertTrue(section.isCollapsed)
        XCTAssertFalse(section.isArchived)
    }

    func testASectionMissingItsFlagsIsAPlainOpenOne() throws {
        let section = try decode(Section.self, #"{"id":"s1","projectId":"p1","name":"x","order":"V"}"#)
        XCTAssertEqual(section.description, "")
        XCTAssertFalse(section.isArchived)
        XCTAssertFalse(section.isCollapsed)
    }

    func testTheSnapshotCarriesSectionsAndStillDecodesWithoutThem() throws {
        let withSections = try decode(LightWeekClient.Snapshot.self, """
        {"cursor":3,"entities":{"section":[{"id":"s1","projectId":"p1","name":"x","order":"V",
         "description":"","isArchived":false,"isCollapsed":false}],"task":[\(olderTask)]}}
        """)
        XCTAssertEqual(withSections.entities.section?.count, 1)
        XCTAssertEqual(withSections.entities.task?.count, 1)

        // An account that has never had a section sends no such array.
        let without = try decode(LightWeekClient.Snapshot.self, #"{"cursor":1,"entities":{}}"#)
        XCTAssertNil(without.entities.section)
    }
}

final class FoldingOpTests: XCTestCase {

    private let ops = Operations(clock: Clock(node: "test-device"))

    private func task(_ id: String = "t", collapsed: Bool = false) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: "p1", sectionId: nil, parentId: nil,
            content: id, description: "", priority: .urgent, order: "V",
            due: nil, deadline: nil, duration: nil, labelIds: [], reward: nil,
            isCompleted: false, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z",
            dayOrder: nil, isCollapsed: collapsed)
    }

    func testFoldingATaskWritesOnlyThatFlag() throws {
        let folded = ops.setCollapsed(task(), true)
        XCTAssertTrue(folded.task.isCollapsed)
        XCTAssertEqual(folded.ops.count, 1)
        XCTAssertEqual(folded.ops[0].kind, "task")
        // Sparse, so another device's edit to any other field is not clobbered.
        XCTAssertEqual(folded.ops[0].fields, .object(["isCollapsed": .bool(true)]))
    }

    func testFoldingASectionWritesOnlyThatFlag() {
        let section = Section(id: "s1", projectId: "p1", name: "x", order: "V")
        let folded = ops.setCollapsed(section, true)
        XCTAssertTrue(folded.section.isCollapsed)
        XCTAssertEqual(folded.ops[0].kind, "section")
        XCTAssertEqual(folded.ops[0].entityId, "s1")
        XCTAssertEqual(folded.ops[0].fields, .object(["isCollapsed": .bool(true)]))
    }

    func testAskingForWhatIsAlreadyTrueWritesNothing() {
        XCTAssertTrue(ops.setCollapsed(task(collapsed: true), true).ops.isEmpty)
        XCTAssertTrue(ops.setCollapsed(task(), false).ops.isEmpty)
        let section = Section(id: "s1", projectId: "p1", name: "x", order: "V", isCollapsed: true)
        XCTAssertTrue(ops.setCollapsed(section, true).ops.isEmpty)
    }

    /// `taskFields` names the whole task. Now that the model carries the two
    /// fields, a whole-task write must say what they are rather than a constant.
    func testAWholeTaskWriteCarriesTheTasksOwnFoldAndDayOrder() throws {
        var made = task()
        made.dayOrder = "Vk"
        made.isCollapsed = true
        guard case .object(let fields) = ops.taskFields(made) else { return XCTFail("object") }
        XCTAssertEqual(fields["dayOrder"], .string("Vk"))
        XCTAssertEqual(fields["isCollapsed"], .bool(true))
        XCTAssertEqual(fields.count, 20, "all twenty, nil keys included")
    }
}

final class OutlineTests: XCTestCase {

    private func task(_ id: String, parent: String? = nil, section: String? = nil,
                      folded: Bool = false, done: Bool = false) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: "p1", sectionId: section, parentId: parent,
            content: id, description: "", priority: .none, order: id,
            due: nil, deadline: nil, duration: nil, labelIds: [], reward: nil,
            isCompleted: done, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z",
            dayOrder: nil, isCollapsed: folded)
    }

    private func section(_ id: String, archived: Bool = false, folded: Bool = false) -> Section {
        Section(id: id, projectId: "p1", name: id, order: id, isArchived: archived, isCollapsed: folded)
    }

    private func ids(_ rows: [Outline.Row]) -> [String] { rows.map(\.task.id) }

    // MARK: - subtasks

    func testNoSubtasksLeavesTheListAsItWas() {
        let all = [task("a"), task("b")]
        let rows = Outline.arrange(all, among: all)
        XCTAssertEqual(ids(rows), ["a", "b"])
        XCTAssertTrue(rows.allSatisfy { $0.depth == 0 && $0.parentTitle == nil && $0.subtasksTotal == 0 })
    }

    func testASubtaskIsDrawnBeneathItsParentNotDropped() {
        let all = [task("p"), task("c", parent: "p")]
        let rows = Outline.arrange(all, among: all)
        XCTAssertEqual(ids(rows), ["p", "c"])
        XCTAssertEqual(rows.map(\.depth), [0, 1])
        XCTAssertNil(rows[1].parentTitle, "beside its parent, it need not say whose it is")
    }

    func testAChildIsBroughtUpUnderItsParentWhateverOrderItArrivedIn() {
        let all = [task("a"), task("b"), task("a1", parent: "a")]
        XCTAssertEqual(ids(Outline.arrange([task("a1", parent: "a"), task("a"), task("b")], among: all)),
                       ["a", "a1", "b"])
    }

    func testASubtaskWhoseParentIsElsewhereIsARootAndNamesIt() {
        let parent = task("p"), child = task("c", parent: "p")
        let rows = Outline.arrange([child], among: [parent, child])
        XCTAssertEqual(ids(rows), ["c"])
        XCTAssertEqual(rows[0].depth, 0)
        XCTAssertEqual(rows[0].parentTitle, "p")
    }

    func testAnOrphanWhoseParentCannotBeFoundGetsNoInventedHint() {
        let child = task("c", parent: "gone")
        XCTAssertNil(Outline.arrange([child], among: [child])[0].parentTitle)
    }

    func testTheRuleAppliesPerLevel() {
        let all = [task("a"), task("b", parent: "a"), task("c", parent: "b")]
        XCTAssertEqual(Outline.arrange(all, among: all).map(\.depth), [0, 1, 2])

        let rows = Outline.arrange([all[0], all[2]], among: all)
        XCTAssertEqual(rows.map(\.depth), [0, 0])
        XCTAssertEqual(rows[1].parentTitle, "b")
    }

    /// The sidebar-count contract, as on the web: an arrangement never drops or
    /// repeats a task, so its length *is* the count.
    func testNothingIsDroppedOrRepeatedEvenInBadData() {
        let lists: [[LightKit.Task]] = [
            [task("a"), task("b")],
            [task("p"), task("c1", parent: "p"), task("c2", parent: "p")],
            [task("p"), task("c", parent: "p"), task("o", parent: "elsewhere")],
            [task("p", folded: true), task("c", parent: "p")],
            [task("x", parent: "y"), task("y", parent: "x")],
            [task("s", parent: "s")],
        ]
        for list in lists {
            let rows = Outline.arrange(list, among: list)
            XCTAssertEqual(rows.count, list.count)
            XCTAssertEqual(Set(ids(rows)).count, list.count)
        }
    }

    func testFoldingHidesRowsButNeverRemovesThem() {
        let all = [task("p", folded: true), task("k", parent: "p"), task("g", parent: "k"), task("n")]
        let rows = Outline.arrange(all, among: all)
        XCTAssertEqual(rows.count, 4, "the count does not move when a chevron does")
        XCTAssertEqual(rows.map(\.isHidden), [false, true, true, false])
        XCTAssertTrue(rows[0].isCollapsed)
        XCTAssertTrue(rows[0].hasChildren)
    }

    func testAFoldFlagOnATaskWithNothingToFoldIsNotAFold() {
        let lone = task("l", folded: true)
        let row = Outline.arrange([lone], among: [lone])[0]
        XCTAssertFalse(row.hasChildren)
        XCTAssertFalse(row.isCollapsed)
        XCTAssertFalse(row.isHidden)
    }

    func testTheChipCountsFinishedSubtasksOverAllOfThemIncludingOnesNotInTheList() {
        let parent = task("p")
        let open = task("c1", parent: "p")
        let done1 = task("c2", parent: "p", done: true)
        let done2 = task("c3", parent: "p", done: true)
        let rows = Outline.arrange([parent, open], among: [parent, open, done1, done2])
        XCTAssertEqual(rows[0].subtasksDone, 2)
        XCTAssertEqual(rows[0].subtasksTotal, 3)
        XCTAssertEqual(rows[1].subtasksTotal, 0)
    }

    // MARK: - sections

    private func shape(_ groups: [Outline.SectionGroup]) -> [String] {
        groups.map { "\($0.section?.id ?? "-"):" + ids($0.rows).joined(separator: ",") }
    }

    private func groups(_ tasks: [LightKit.Task], _ sections: [Section]) -> [Outline.SectionGroup] {
        Outline.groups(Outline.arrange(tasks, among: tasks), sections: sections)
    }

    func testUnsectionedFirstThenEachSectionInItsOrder() {
        let tasks = [task("a", section: "s2"), task("loose"), task("b", section: "s1")]
        XCTAssertEqual(shape(groups(tasks, [section("s2"), section("s1")])),
                       ["-:loose", "s1:b", "s2:a"])
    }

    func testAnEmptySectionIsKept() {
        XCTAssertEqual(shape(groups([task("loose")], [section("s1")])), ["-:loose", "s1:"])
    }

    func testASubtaskFollowsItsParentWhateverItsOwnSectionSays() {
        let tasks = [task("p", section: "s1"), task("c", parent: "p", section: "s2"), task("q", section: "s2")]
        XCTAssertEqual(shape(groups(tasks, [section("s1"), section("s2")])), ["-:", "s1:p,c", "s2:q"])
    }

    func testATaskWhoseSectionIsGoneIsDrawnWithTheUnsectionedRows() {
        let tasks = [task("a", section: "deleted"), task("b")]
        XCTAssertEqual(shape(groups(tasks, [section("s1")]))[0], "-:a,b")
    }

    func testAnArchivedSectionIsHiddenUnlessItStillHoldsWork() {
        let found = groups([task("a", section: "live")],
                           [section("old", archived: true), section("live", archived: true)])
        XCTAssertEqual(found.map { $0.section?.id ?? "-" }, ["-", "live"])
    }

    func testEveryRowIsAccountedForExactlyOnce() {
        let tasks = [task("a", section: "s1"), task("a1", parent: "a", section: "s1"),
                     task("b", section: "gone"), task("c"), task("d", section: "s2")]
        let all = groups(tasks, [section("s1"), section("s2")]).flatMap { ids($0.rows) }
        XCTAssertEqual(all.sorted(), tasks.map(\.id).sorted())
    }

    func testOnScreenLeavesOutFoldedRowsAndFoldedSections() {
        let tasks = [
            task("loose"),
            task("p", section: "s1", folded: true), task("k", parent: "p", section: "s1"),
            task("q", section: "s1"),
            task("hidden", section: "s2"),
            task("shown", section: "s3"),
        ]
        let sections = [section("s1"), section("s2", folded: true), section("s3")]
        XCTAssertEqual(ids(Outline.onScreen(groups(tasks, sections))), ["loose", "p", "q", "shown"])
    }
}
