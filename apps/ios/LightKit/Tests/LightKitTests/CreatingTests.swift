import XCTest
@testable import LightKit

/// What a person on the phone can now make: a subtask under a task, and a
/// project under a project. The twins of the cases in
/// `packages/client-sdk/test/operations.test.ts` ("createTask, as a subtask" and
/// "createProject, nested"), so the two clients are held to the same rules.
final class SubtaskCreationTests: XCTestCase {

    private var ops: Operations!

    override func setUp() {
        super.setUp()
        ops = Operations(clock: Clock(node: "test-device"))
    }

    private func task(
        _ id: String, project: String = "p1", section: String? = nil, parent: String? = nil,
        order: String? = nil, done: Bool = false
    ) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: project, sectionId: section, parentId: parent,
            content: id, description: "", priority: .none, order: order ?? id,
            due: nil, deadline: nil, duration: nil, labelIds: [], reward: nil,
            isCompleted: done, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z")
    }

    private func fields(_ op: Op) -> [String: JSONValue] {
        guard case .object(let fields)? = op.fields else { return [:] }
        return fields
    }

    func testASubtaskLivesWhereItsParentDoesProjectAndSection() throws {
        let parent = task("parent", project: "p9", section: "s1")
        let made = try ops.createSubtask(content: "Book flights", under: parent, existing: [parent])

        XCTAssertEqual(made.task.parentId, "parent")
        XCTAssertEqual(made.task.projectId, "p9")
        XCTAssertEqual(made.task.sectionId, "s1")
        XCTAssertEqual(made.task.content, "Book flights")
        XCTAssertFalse(made.task.isCompleted)
    }

    func testItIsWrittenAsAWholeRowWithItsParentNamed() throws {
        let parent = task("parent")
        let made = try ops.createSubtask(content: "Book flights", under: parent, existing: [parent])
        let written = fields(made.ops[0])

        XCTAssertEqual(made.ops.count, 1)
        XCTAssertEqual(written["parentId"], JSONValue.string("parent"))
        // The twenty fields of `Task`, as for any other task made here: encoding
        // the struct would drop every nil, and the web reads a missing key as
        // "not null".
        XCTAssertEqual(written.keys.sorted(), [
            "addedById", "assigneeId", "completedAt", "content", "createdAt", "dayOrder",
            "deadline", "description", "due", "duration", "id", "isCollapsed", "isCompleted",
            "labelIds", "order", "parentId", "priority", "projectId", "reward", "sectionId",
        ])
        XCTAssertEqual(written["sectionId"], JSONValue.null)
    }

    func testItGoesLastAmongItsParentsSubtasksAndLeavesTheRootsAlone() throws {
        let parent = task("parent", order: "V")
        let first = task("first", parent: "parent", order: "V")
        let otherRoot = task("zzz", order: "z")
        let made = try ops.createSubtask(
            content: "second", under: parent, existing: [parent, first, otherRoot])

        // Placed among its parent's children: the key comes after the sibling's,
        // and is not pushed past the far-off root's, as it would be if the whole
        // project were the list it joined.
        XCTAssertGreaterThan(made.task.order, first.order)
        XCTAssertLessThan(made.task.order, otherRoot.order)
    }

    func testThePositionOfARootIsUnchangedByWhatIsMadeBeneathIt() throws {
        // `create` still reads only the top level of a project.
        let parent = task("parent", order: "V")
        let kid = task("kid", parent: "parent", order: "z")
        let made = try ops.create(content: "next root", projectId: "p1", existing: [parent, kid])
        XCTAssertGreaterThan(made.task.order, parent.order)
        XCTAssertNil(made.task.parentId)
    }

    func testAParentThatIsGoneIsRefused() {
        let ghost = task("ghost")
        XCTAssertThrowsError(try ops.createSubtask(content: "x", under: ghost, existing: [])) {
            XCTAssertEqual($0 as? Operations.CreateError, .noSuchParent)
        }
    }

    func testAnEmptyTitleIsRefused() {
        let parent = task("parent")
        XCTAssertThrowsError(try ops.createSubtask(content: "  ", under: parent, existing: [parent])) {
            XCTAssertEqual($0 as? Operations.CreateError, .emptyTitle)
        }
    }

    func testTheParentIsReadFromTheAccountNotFromTheCallersCopy() throws {
        // The screen drew the parent in s1; since then it was filed in s2.
        let stale = task("parent", section: "s1")
        let current = task("parent", section: "s2")
        let made = try ops.createSubtask(content: "x", under: stale, existing: [current])
        XCTAssertEqual(made.task.sectionId, "s2")
    }

    func testItIsDrawnBeneathItsParentAndTheCountIsTheLengthOfWhatIsDrawn() throws {
        let parent = task("parent")
        let other = task("other")
        let made = try ops.createSubtask(content: "Book flights", under: parent, existing: [parent, other])
        let all = [parent, other, made.task]

        let rows = Outline.arrange(all, among: all)
        XCTAssertEqual(rows.map(\.task.id), ["parent", made.task.id, "other"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 0])
        // The home list's number for a project is the rows its screen renders.
        XCTAssertEqual(rows.count, all.count)
        XCTAssertEqual(rows[0].subtasksTotal, 1)
        XCTAssertEqual(rows[0].subtasksDone, 0)
    }

    func testDeletingTheParentTakesIt() throws {
        let parent = task("parent")
        let made = try ops.createSubtask(content: "x", under: parent, existing: [parent])
        let deeper = try ops.createSubtask(content: "y", under: made.task, existing: [parent, made.task])

        let deletion = ops.delete(parent, among: [parent, made.task, deeper.task])
        XCTAssertEqual(deletion.deleted, [deeper.task.id, made.task.id, "parent"])
    }

    func testFoldedParentIsUnfoldedByASparseWriteAndNotWhenAlreadyOpen() {
        var folded = task("parent")
        folded.isCollapsed = true
        let open = ops.setCollapsed(folded, false)
        XCTAssertFalse(open.task.isCollapsed)
        XCTAssertEqual(open.ops.count, 1)
        XCTAssertEqual(fields(open.ops[0]).keys.sorted(), ["isCollapsed"])
        XCTAssertTrue(ops.setCollapsed(open.task, false).ops.isEmpty)
    }
}

final class ProjectCreationTests: XCTestCase {

    private var ops: Operations!

    override func setUp() {
        super.setUp()
        ops = Operations(clock: Clock(node: "test-device"))
    }

    private func project(
        _ id: String, parent: String? = nil, order: String? = nil,
        inbox: Bool = false, rewards: Bool = false, archived: Bool = false
    ) -> Project {
        Project(id: id, parentId: parent, name: id, color: "charcoal", order: order ?? id,
                isFavorite: false, isArchived: archived, isInbox: inbox, isRewards: rewards,
                description: "")
    }

    private func fields(_ op: Op) -> [String: JSONValue] {
        guard case .object(let fields)? = op.fields else { return [:] }
        return fields
    }

    func testMakesAProjectAtTheTopLevel() throws {
        let made = try ops.createProject(name: "  Home  ", among: [])
        XCTAssertEqual(made.project.name, "Home", "trimmed")
        XCTAssertNil(made.project.parentId)
        XCTAssertFalse(made.project.isInbox)
        XCTAssertFalse(made.project.isRewards)
        XCTAssertEqual(made.ops.count, 1)
        XCTAssertEqual(made.ops[0].kind, "project")
        XCTAssertEqual(made.ops[0].entityId, made.project.id)
    }

    func testNestsThreeLevelsDeepAndTheTreeDrawsIt() throws {
        var all: [Project] = []
        let root = try ops.createProject(name: "3WM", among: all).project
        all.append(root)
        let child = try ops.createProject(name: "BISNO", parentId: root.id, among: all).project
        all.append(child)
        let grandchild = try ops.createProject(name: "Light Week", parentId: child.id, among: all).project
        all.append(grandchild)

        XCTAssertEqual(grandchild.parentId, child.id)
        let drawn = Navigation.projectTree(all, rewardsEnabled: true).map { [$0.project.name, String($0.depth)] }
        XCTAssertEqual(drawn, [["3WM", "0"], ["BISNO", "1"], ["Light Week", "2"]])
    }

    func testGoesLastAmongItsOwnSiblingsOnly() throws {
        let root = project("root", order: "a")
        let kid = project("kid", parent: "root", order: "V")
        let elsewhere = project("zz", order: "z")

        let sibling = try ops.createProject(name: "next", parentId: "root", among: [root, kid, elsewhere]).project
        XCTAssertGreaterThan(sibling.order, kid.order)
        XCTAssertLessThan(sibling.order, elsewhere.order, "ordered among its siblings, not the account's")

        let top = try ops.createProject(name: "top", among: [root, kid, elsewhere]).project
        XCTAssertGreaterThan(top.order, elsewhere.order)
    }

    func testWritesEveryFieldTheWebReads() throws {
        let root = project("root")
        let written = fields(try ops.createProject(name: "Kid", parentId: "root", among: [root]).ops[0])

        // The twelve fields of `Project` in packages/core/src/entities.ts,
        // `view` and `isCollapsed` included though the phone's `Project` does
        // not carry them.
        XCTAssertEqual(written.keys.sorted(), [
            "color", "description", "id", "isArchived", "isCollapsed", "isFavorite", "isInbox",
            "isRewards", "name", "order", "parentId", "view",
        ])
        XCTAssertEqual(written["parentId"], JSONValue.string("root"))
        XCTAssertEqual(written["view"], JSONValue.string("list"))
        XCTAssertEqual(written["isCollapsed"], JSONValue.bool(false))
        // A top-level project says "no parent" in so many words.
        XCTAssertEqual(fields(try ops.createProject(name: "Top", among: [root]).ops[0])["parentId"], JSONValue.null)
    }

    func testTheRewardsProjectIsNowWrittenWholeToo() {
        let written = fields(ops.rewardsProject(after: []).ops[0])
        XCTAssertEqual(written.keys.sorted(), [
            "color", "description", "id", "isArchived", "isCollapsed", "isFavorite", "isInbox",
            "isRewards", "name", "order", "parentId", "view",
        ])
        XCTAssertEqual(written["isRewards"], JSONValue.bool(true))
        XCTAssertEqual(written["name"], JSONValue.string("Rewards"))
    }

    func testRefusesAnEmptyNameAParentThatIsGoneAndTheInboxAndTheTrophies() {
        let inbox = project("i", inbox: true)
        let cabinet = project("r", rewards: true)

        XCTAssertThrowsError(try ops.createProject(name: "   ", among: [])) {
            XCTAssertEqual($0 as? Operations.CreateError, .emptyName)
        }
        XCTAssertThrowsError(try ops.createProject(name: "x", parentId: "ghost", among: [inbox])) {
            XCTAssertEqual($0 as? Operations.CreateError, .noSuchParent)
        }
        XCTAssertThrowsError(try ops.createProject(name: "x", parentId: "i", among: [inbox, cabinet])) {
            XCTAssertEqual($0 as? Operations.CreateError, .cannotHoldProjects)
        }
        XCTAssertThrowsError(try ops.createProject(name: "x", parentId: "r", among: [inbox, cabinet])) {
            XCTAssertEqual($0 as? Operations.CreateError, .cannotHoldProjects)
        }
    }

    func testParentChoicesAreExactlyWhatWillBeAccepted() throws {
        let projects = [
            project("i", inbox: true), project("r", rewards: true),
            project("a", order: "a"), project("a1", parent: "a"), project("a1x", parent: "a1"),
            project("b", order: "b"), project("old", order: "c", archived: true),
            project("under-old", parent: "old"),
        ]
        let choices = Navigation.parentChoices(projects, rewardsEnabled: true)
        XCTAssertEqual(choices.map { String(repeating: "-", count: $0.depth) + $0.project.id },
                       ["a", "-a1", "--a1x", "b"])

        for choice in choices {
            XCTAssertNoThrow(try ops.createProject(name: "x", parentId: choice.project.id, among: projects))
        }
    }
}
