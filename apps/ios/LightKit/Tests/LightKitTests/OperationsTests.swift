import XCTest
@testable import LightKit

/// The reward rule, as the phone implements it.
///
/// These are the same four cases as `packages/client-sdk/test/operations.test.ts`
/// — rewarded, unrewarded, switched off, repeating — because the rule exists
/// twice and nothing but a shared set of cases keeps the two from drifting.
/// The one deliberate difference is spelled out in the repeating test.
final class RewardTests: XCTestCase {

    private var ops: Operations!

    override func setUp() {
        super.setUp()
        ops = Operations(clock: Clock(node: "test-device"))
    }

    private func project(name: String = "Work", isRewards: Bool = false) -> Project {
        Project(id: LightID.new(), parentId: nil, name: name, color: "charcoal",
                order: Order.first, isFavorite: false, isArchived: false,
                isInbox: false, isRewards: isRewards, description: "")
    }

    private func task(
        in project: Project, content: String = "Ready the deck",
        reward: String? = nil, due: Due? = nil
    ) -> LightKit.Task {
        LightKit.Task(
            id: LightID.new(), projectId: project.id, sectionId: nil, parentId: nil,
            content: content, description: "", priority: .none, order: Order.first,
            due: due, deadline: nil, duration: nil, labelIds: [], reward: reward,
            isCompleted: false, completedAt: nil,
            createdAt: ISO8601DateFormatter.lightWeek.string(from: Date()))
    }

    func testFilesTheRewardAndMakesTheProjectTheFirstTime() throws {
        let work = project()
        let done = try ops.complete(task(in: work, reward: "An hour in the sun"),
                                    rewardsEnabled: true, projects: [work])

        XCTAssertTrue(done.task.isCompleted)
        XCTAssertEqual(done.createdProject?.name, "Rewards")
        XCTAssertEqual(done.createdProject?.isRewards, true)
        XCTAssertEqual(done.earned?.content, "An hour in the sun")
        XCTAssertEqual(done.earned?.projectId, done.createdProject?.id)
        XCTAssertEqual(done.earned?.description, "Earned by finishing “Ready the deck”.")
    }

    func testFilesIntoTheExistingProjectWhenThereIsOne() throws {
        let work = project()
        let cabinet = project(name: "Rewards", isRewards: true)
        let done = try ops.complete(task(in: work, reward: "A long walk"),
                                    rewardsEnabled: true, projects: [work, cabinet])

        XCTAssertNil(done.createdProject, "a second cabinet would split the trophies")
        XCTAssertEqual(done.earned?.projectId, cabinet.id)
    }

    func testFilesNothingWhenTheTaskCarriesNoReward() throws {
        let work = project()
        let done = try ops.complete(task(in: work), rewardsEnabled: true, projects: [work])

        XCTAssertTrue(done.task.isCompleted)
        XCTAssertNil(done.earned)
        XCTAssertNil(done.createdProject)
        XCTAssertEqual(done.ops.count, 1, "only the completion itself")
    }

    func testFilesNothingWhenRewardsAreSwitchedOff() throws {
        let work = project()
        let done = try ops.complete(task(in: work, reward: "An hour in the sun"),
                                    rewardsEnabled: false, projects: [work])

        XCTAssertTrue(done.task.isCompleted, "the task still finishes")
        XCTAssertNil(done.earned)
        XCTAssertNil(done.createdProject)
    }

    func testARewardOfOnlySpacesIsNoReward() throws {
        let work = project()
        let done = try ops.complete(task(in: work, reward: "   "),
                                    rewardsEnabled: true, projects: [work])
        XCTAssertNil(done.earned)
    }

    func testARepeatingTaskStillEarnsItsReward() throws {
        let work = project()
        let repeating = task(
            in: work, content: "Log wishlists", reward: "A good coffee",
            due: Due(date: "2026-10-24", text: "every saturday", isRecurring: true))
        let done = try ops.complete(repeating, rewardsEnabled: true, projects: [work])

        XCTAssertEqual(done.earned?.content, "A good coffee")
        // The deliberate difference from the web: the recurrence parser is not
        // ported, so this marks the task done rather than rescheduling it.
        // Guessing the next occurrence would be worse than completing
        // honestly, and the reward — the half that does carry over — fires.
        XCTAssertTrue(done.task.isCompleted)
    }

    func testReopeningClearsTheCompletionWithoutTouchingAnythingElse() {
        let work = project()
        var done = task(in: work, reward: "An hour in the sun")
        done.isCompleted = true
        done.completedAt = "2026-11-03T09:00:00.000Z"

        let open = ops.reopen(done)
        XCTAssertFalse(open.task.isCompleted)
        XCTAssertNil(open.task.completedAt)
        XCTAssertEqual(open.task.reward, "An hour in the sun", "reopening is not un-rewarding")
    }
}

/// Sparse edits: what is said is written, what is not said is left alone.
final class TaskChangesTests: XCTestCase {

    private var ops: Operations!

    override func setUp() {
        super.setUp()
        ops = Operations(clock: Clock(node: "test-device"))
    }

    private func sample() -> LightKit.Task {
        LightKit.Task(
            id: "t1", projectId: "p1", sectionId: nil, parentId: nil,
            content: "Ready the deck", description: "", priority: .none, order: "V",
            due: Due(date: "2026-11-03"), deadline: nil, duration: nil, labelIds: [],
            reward: nil, isCompleted: false, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z")
    }

    private func patch(_ op: Op) -> [String: JSONValue] {
        guard case .object(let fields)? = op.fields else { return [:] }
        return fields
    }

    func testWritesOnlyTheFieldsItWasGiven() throws {
        let (updated, ops) = try ops.update(sample(), .init(priority: .urgent))
        XCTAssertEqual(ops.count, 1)
        XCTAssertEqual(patch(ops[0]).keys.sorted(), ["priority"])
        XCTAssertEqual(updated.priority, .urgent)
        XCTAssertEqual(updated.due?.date, "2026-11-03", "the due date was not mentioned")
    }

    func testClearingIsDifferentFromSayingNothing() throws {
        // `.some(nil)` means unschedule; `.none` means leave it.
        let cleared = try ops.update(sample(), .init(due: .some(nil)))
        XCTAssertEqual(patch(cleared.ops[0])["due"], JSONValue.null)
        XCTAssertNil(cleared.task.due)

        let untouched = try ops.update(sample(), .init(content: "Ready the other deck"))
        XCTAssertNil(patch(untouched.ops[0])["due"])
        XCTAssertNotNil(untouched.task.due)
    }

    func testAnEmptyRewardIsWrittenAsEmptyNotAsNull() throws {
        // Set-then-cleared is a thing the user did, and is not the same as
        // never having set one.
        let (task, ops) = try ops.update(sample(), .init(reward: .some("")))
        XCTAssertEqual(patch(ops[0])["reward"], JSONValue.string(""))
        XCTAssertEqual(task.reward, "")
    }

    func testAnEmptyChangeSetWritesNothingAtAll() throws {
        let (task, ops) = try ops.update(sample(), .init())
        XCTAssertTrue(ops.isEmpty)
        XCTAssertEqual(task, sample())
    }

    func testATimedDueRoundTripsThroughThePatch() throws {
        let timed = Due(date: "2026-11-03T09:00:00.000Z", hasTime: true)
        let (task, ops) = try ops.update(sample(), .init(due: .some(timed)))
        XCTAssertEqual(task.due, timed)
        guard case .object(let due)? = patch(ops[0])["due"] else {
            return XCTFail("due should be an object")
        }
        XCTAssertEqual(due["hasTime"], JSONValue.bool(true))
        XCTAssertEqual(due["date"], JSONValue.string("2026-11-03T09:00:00.000Z"))
    }
}

/// Making a task, on the phone.
final class CreateTests: XCTestCase {

    private var ops: Operations!

    override func setUp() {
        super.setUp()
        ops = Operations(clock: Clock(node: "test-device"))
    }

    private func existing(_ order: String, in project: String = "p1",
                          section: String? = nil, parent: String? = nil) -> LightKit.Task {
        LightKit.Task(
            id: LightID.new(), projectId: project, sectionId: section, parentId: parent,
            content: "x", description: "", priority: .none, order: order,
            due: nil, deadline: nil, duration: nil, labelIds: [], reward: nil,
            isCompleted: false, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z")
    }

    private func patch(_ op: Op) -> [String: JSONValue] {
        guard case .object(let fields)? = op.fields else { return [:] }
        return fields
    }

    func testMakesAnOpenTaskInTheProjectItWasGiven() throws {
        let (task, staged) = try ops.create(content: "Buy milk", projectId: "p1", existing: [])
        XCTAssertEqual(task.content, "Buy milk")
        XCTAssertEqual(task.projectId, "p1")
        XCTAssertFalse(task.isCompleted)
        XCTAssertEqual(task.priority, .none)
        XCTAssertEqual(staged.count, 1)
        XCTAssertEqual(staged[0].kind, "task")
        XCTAssertEqual(staged[0].entityId, task.id)
    }

    func testTrimsTheTitle() throws {
        let (task, _) = try ops.create(content: "  Buy milk \n", projectId: "p1", existing: [])
        XCTAssertEqual(task.content, "Buy milk")
    }

    func testRefusesATitleOfOnlySpaces() {
        XCTAssertThrowsError(try ops.create(content: "   ", projectId: "p1", existing: [])) { error in
            XCTAssertEqual(error as? Operations.CreateError, .emptyTitle)
        }
        XCTAssertThrowsError(try ops.create(content: "", projectId: "p1", existing: []))
    }

    func testGoesAtTheEndOfItsOwnList() throws {
        let list = [existing("V"), existing("a"), existing("k")]
        let (task, _) = try ops.create(content: "Last", projectId: "p1", existing: list)
        XCTAssertGreaterThan(task.order, "k", "after everything already there")
    }

    func testIsNotPlacedByOtherListsOrBySubtasks() throws {
        // Another project's keys, a section's, and a subtask's say nothing
        // about where the end of this list is — and the web ignores them too.
        let others = [
            existing("z", in: "p2"),
            existing("y", section: "s1"),
            existing("x", parent: "t1"),
        ]
        let (task, _) = try ops.create(content: "First here", projectId: "p1", existing: others)
        XCTAssertEqual(task.order, Order.afterLast([]))
    }

    func testTwoInARowKeepTheirOrder() throws {
        var list: [LightKit.Task] = []
        var made: [LightKit.Task] = []
        for title in ["one", "two", "three"] {
            let (task, _) = try ops.create(content: title, projectId: "p1", existing: list)
            list.append(task)
            made.append(task)
        }
        XCTAssertEqual(made.sorted { $0.order < $1.order }.map(\.content), ["one", "two", "three"])
    }

    func testWritesEveryFieldTheWebReadsOrNullWhereThereIsNone() throws {
        let (_, staged) = try ops.create(content: "Buy milk", projectId: "p1", existing: [])
        let written = patch(staged[0])

        // The twenty fields of `Task` in packages/core/src/entities.ts. A
        // missing `parentId` is read there as "not null", which would hide the
        // task from its project, so absence is not an acceptable way to say
        // "none".
        XCTAssertEqual(written.keys.sorted(), [
            "addedById", "assigneeId", "completedAt", "content", "createdAt", "dayOrder",
            "deadline", "description", "due", "duration", "id", "isCollapsed", "isCompleted",
            "labelIds", "order", "parentId", "priority", "projectId", "reward", "sectionId",
        ])
        for key in ["parentId", "sectionId", "dayOrder", "due", "deadline", "duration",
                    "reward", "completedAt", "assigneeId", "addedById"] {
            XCTAssertEqual(written[key], JSONValue.null, key)
        }
        XCTAssertEqual(written["isCompleted"], JSONValue.bool(false))
        XCTAssertEqual(written["isCollapsed"], JSONValue.bool(false))
        XCTAssertEqual(written["labelIds"], JSONValue.array([]))
        XCTAssertEqual(written["description"], JSONValue.string(""))
    }

    func testTheOpAndTheTaskAgree() throws {
        let (task, staged) = try ops.create(
            content: "Buy milk", projectId: "p1", existing: [existing("V")], priority: .urgent)
        let written = patch(staged[0])
        XCTAssertEqual(written["id"], JSONValue.string(task.id))
        XCTAssertEqual(written["content"], JSONValue.string(task.content))
        XCTAssertEqual(written["order"], JSONValue.string(task.order))
        XCTAssertEqual(written["priority"], JSONValue.integer(1))
        XCTAssertEqual(written["createdAt"], JSONValue.string(task.createdAt))
    }

    func testEveryTaskGetsItsOwnId() throws {
        let a = try ops.create(content: "a", projectId: "p1", existing: []).task
        let b = try ops.create(content: "b", projectId: "p1", existing: []).task
        XCTAssertNotEqual(a.id, b.id)
    }
}

/// Putting a task on a day by name.
///
/// The table is the one in `packages/client-sdk/test/operations.test.ts`, row
/// for row. "Next week" and "this weekend" are vague words, and this is what
/// stops them meaning a different Monday on the phone than on the web or for an
/// agent: change a row in either file and the other fails until it follows.
final class RescheduleTests: XCTestCase {

    private var ops: Operations!

    override func setUp() {
        super.setUp()
        ops = Operations(clock: Clock(node: "test-device"))
    }

    /// today, tomorrow, next week, weekend. 2026-11-09 is a Monday.
    private let week: [(name: String, today: String, tomorrow: String, nextWeek: String, weekend: String)] = [
        ("Monday", "2026-11-09", "2026-11-10", "2026-11-16", "2026-11-14"),
        ("Tuesday", "2026-11-10", "2026-11-11", "2026-11-16", "2026-11-14"),
        ("Wednesday", "2026-11-11", "2026-11-12", "2026-11-16", "2026-11-14"),
        ("Thursday", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-14"),
        ("Friday", "2026-11-13", "2026-11-14", "2026-11-16", "2026-11-14"),
        // The weekend is already here, so it means today.
        ("Saturday", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-14"),
        ("Sunday", "2026-11-15", "2026-11-16", "2026-11-16", "2026-11-15"),
        // Across a year end, and across 29 February.
        ("Thursday, New Year's Eve", "2026-12-31", "2027-01-01", "2027-01-04", "2027-01-02"),
        ("Monday, the day before a leap day", "2028-02-28", "2028-02-29", "2028-03-06", "2028-03-04"),
    ]

    private func task(due: Due? = nil, priority: Priority = .none, reward: String? = nil) -> LightKit.Task {
        LightKit.Task(
            id: "t1", projectId: "p1", sectionId: nil, parentId: nil,
            content: "Ring the vet", description: "", priority: priority, order: "V",
            due: due, deadline: nil, duration: nil, labelIds: [], reward: reward,
            isCompleted: false, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z")
    }

    private func patch(_ op: Op) -> [String: JSONValue] {
        guard case .object(let fields)? = op.fields else { return [:] }
        return fields
    }

    func testEachWordMeansTheSameDayAsOnTheWeb() {
        for row in week {
            XCTAssertEqual(Schedule.day(for: .today, today: row.today), row.today, row.name)
            XCTAssertEqual(Schedule.day(for: .tomorrow, today: row.today), row.tomorrow, row.name)
            XCTAssertEqual(Schedule.day(for: .nextWeek, today: row.today), row.nextWeek, row.name)
            XCTAssertEqual(Schedule.day(for: .weekend, today: row.today), row.weekend, row.name)
        }
    }

    func testNextWeekIsNeverToday() {
        XCTAssertEqual(Schedule.day(for: .nextWeek, today: "2026-11-09"), "2026-11-16")
    }

    func testTheNamesAreTheOnesTheWebAndTheAgentUse() {
        XCTAssertEqual(Reschedule.allCases.map(\.rawValue), ["today", "tomorrow", "next-week", "weekend"])
    }

    func testWritesOnlyTheDueDate() throws {
        let (moved, staged) = try ops.reschedule(
            task(priority: .high, reward: "A long walk"), to: .tomorrow, today: "2026-11-13")
        XCTAssertEqual(staged.count, 1)
        XCTAssertEqual(patch(staged[0]).keys.sorted(), ["due"])
        XCTAssertEqual(moved.due?.date, "2026-11-14")
        XCTAssertEqual(moved.due?.hasTime, false)
        XCTAssertEqual(moved.priority, .high)
        XCTAssertEqual(moved.reward, "A long walk")
    }

    func testEveryTargetLandsOnItsDay() throws {
        for (target, day) in [(Reschedule.today, "2026-11-13"), (.tomorrow, "2026-11-14"),
                              (.nextWeek, "2026-11-16"), (.weekend, "2026-11-14")] {
            let (moved, _) = try ops.reschedule(task(due: Due(date: "2026-12-01")), to: target,
                                                today: "2026-11-13")
            XCTAssertEqual(moved.due?.date, day, target.rawValue)
        }
    }

    func testNoDateClearsItAndSaysSoInThePatch() throws {
        let (moved, staged) = try ops.reschedule(
            task(due: Due(date: "2026-12-01")), to: nil, today: "2026-11-13")
        XCTAssertNil(moved.due)
        XCTAssertEqual(patch(staged[0])["due"], JSONValue.null)
    }

    func testSchedulesATaskThatHadNoDate() throws {
        let (moved, _) = try ops.reschedule(task(), to: .tomorrow, today: "2026-11-13")
        XCTAssertEqual(moved.due?.date, "2026-11-14")
    }

    func testTheTimeOfDayIsDropped() throws {
        let timed = Due(date: "2026-11-13T09:30:00.000Z", hasTime: true, timezone: "Europe/London")
        let (moved, _) = try ops.reschedule(task(due: timed), to: .tomorrow, today: "2026-11-13")
        XCTAssertEqual(moved.due?.hasTime, false)
        XCTAssertEqual(moved.due?.date, "2026-11-14")
    }

    func testARepeatKeepsRepeatingAndNoDateEndsIt() throws {
        let weekly = Due(date: "2026-11-09", text: "every monday", isRecurring: true)
        let (moved, _) = try ops.reschedule(task(due: weekly), to: .nextWeek, today: "2026-11-13")
        XCTAssertEqual(moved.due?.date, "2026-11-16")
        XCTAssertEqual(moved.due?.text, "every monday")
        XCTAssertEqual(moved.due?.isRecurring, true)

        let (cleared, _) = try ops.reschedule(task(due: weekly), to: nil, today: "2026-11-13")
        XCTAssertNil(cleared.due)
    }
}

/// Deleting a task, with whatever hangs from it.
final class DeleteTests: XCTestCase {

    private var ops: Operations!

    override func setUp() {
        super.setUp()
        ops = Operations(clock: Clock(node: "test-device"))
    }

    private func task(_ id: String, parent: String? = nil, project: String = "p1",
                      done: Bool = false) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: project, sectionId: nil, parentId: parent,
            content: id, description: "", priority: .none, order: "V",
            due: nil, deadline: nil, duration: nil, labelIds: [], reward: nil,
            isCompleted: done, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z")
    }

    func testDeletesJustTheTaskWhenItHasNoSubtasks() {
        let a = task("a"), b = task("b")
        let deletion = ops.delete(a, among: [a, b])
        XCTAssertEqual(deletion.deleted, ["a"])
        XCTAssertEqual(deletion.ops.count, 1)
        XCTAssertEqual(deletion.ops[0].type, "delete")
        XCTAssertEqual(deletion.ops[0].kind, "task")
        XCTAssertEqual(deletion.ops[0].entityId, "a")
        XCTAssertNil(deletion.ops[0].fields, "a tombstone carries no patch")
    }

    func testSubtasksGoWithTheirParentAtEveryDepth() {
        let all = [task("parent"), task("child", parent: "parent"),
                   task("grandchild", parent: "child"), task("sibling"),
                   task("cousin", parent: "sibling")]
        let deletion = ops.delete(all[0], among: all)

        XCTAssertEqual(Set(deletion.deleted), ["parent", "child", "grandchild"])
        XCTAssertEqual(deletion.ops.count, 3, "one tombstone each, because nothing cascades in storage")
        XCTAssertTrue(deletion.ops.allSatisfy { $0.type == "delete" })
        XCTAssertFalse(deletion.deleted.contains("sibling"))
        XCTAssertFalse(deletion.deleted.contains("cousin"))
    }

    func testChildrenAreDeletedBeforeTheirParent() {
        let all = [task("parent"), task("child", parent: "parent"), task("grandchild", parent: "child")]
        let deletion = ops.delete(all[0], among: all)
        XCTAssertEqual(deletion.deleted, ["grandchild", "child", "parent"],
                       "depth first, the same order as deleteTask on the web")
    }

    func testACompletedSubtaskIsStillASubtask() {
        let all = [task("parent"), task("child", parent: "parent", done: true)]
        XCTAssertEqual(Set(ops.delete(all[0], among: all).deleted), ["parent", "child"])
    }

    func testDeletingASubtaskLeavesItsParent() {
        let all = [task("parent"), task("child", parent: "parent")]
        XCTAssertEqual(ops.delete(all[1], among: all).deleted, ["child"])
    }

    func testABadParentCycleEndsInsteadOfLoopingForEver() {
        let all = [task("a", parent: "b"), task("b", parent: "a")]
        let deletion = ops.delete(all[0], among: all)
        XCTAssertEqual(Set(deletion.deleted), ["a", "b"])
    }

    func testEachTombstoneIsStampedLaterThanTheLast() {
        let all = [task("parent"), task("child", parent: "parent")]
        let clocks = ops.delete(all[0], among: all).ops.compactMap { HLC(encoded: $0.clock) }
        XCTAssertEqual(clocks, clocks.sorted())
        XCTAssertEqual(Set(clocks.map(\.encoded)).count, clocks.count)
    }
}

/// Moving a task to another project.
final class MoveTests: XCTestCase {

    private var ops: Operations!

    override func setUp() {
        super.setUp()
        ops = Operations(clock: Clock(node: "test-device"))
    }

    private func task(_ id: String, project: String, order: String = "V",
                      section: String? = nil, parent: String? = nil) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: project, sectionId: section, parentId: parent,
            content: id, description: "", priority: .none, order: order,
            due: nil, deadline: nil, duration: nil, labelIds: [], reward: nil,
            isCompleted: false, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z")
    }

    private func patch(_ op: Op) -> [String: JSONValue] {
        guard case .object(let fields)? = op.fields else { return [:] }
        return fields
    }

    func testChangesTheProjectAndPlacesTheTaskLast() {
        let moving = task("moving", project: "p1")
        let there = [task("x", project: "p2", order: "V"), task("y", project: "p2", order: "k")]
        let moved = ops.move(moving, to: "p2", among: [moving] + there)

        XCTAssertEqual(moved.tasks[0].projectId, "p2")
        XCTAssertGreaterThan(moved.tasks[0].order, "k", "after everything already there")
        XCTAssertEqual(moved.ops.count, 1)
        XCTAssertEqual(patch(moved.ops[0]).keys.sorted(), ["order", "parentId", "projectId", "sectionId"])
        XCTAssertEqual(patch(moved.ops[0])["projectId"], JSONValue.string("p2"))
        XCTAssertEqual(patch(moved.ops[0])["order"], JSONValue.string(moved.tasks[0].order))
    }

    func testIsPlacedByTheTopLevelOfTheNewProjectOnly() {
        // A section's keys and a subtask's say nothing about where the end of
        // the project's own list is.
        let moving = task("moving", project: "p1")
        let others = [task("s", project: "p2", order: "z", section: "sec"),
                      task("c", project: "p2", order: "y", parent: "x")]
        let moved = ops.move(moving, to: "p2", among: [moving] + others)
        XCTAssertEqual(moved.tasks[0].order, Order.afterLast([]))
    }

    func testLeavesItsSectionAndParentBehind() {
        let inSection = task("a", project: "p1", section: "sec", parent: "b")
        let moved = ops.move(inSection, to: "p2", among: [inSection])
        XCTAssertNil(moved.tasks[0].sectionId)
        XCTAssertNil(moved.tasks[0].parentId)
        XCTAssertEqual(patch(moved.ops[0])["sectionId"], JSONValue.null)
        XCTAssertEqual(patch(moved.ops[0])["parentId"], JSONValue.null)
    }

    func testSubtasksComeAlongAndKeepTheirParent() {
        let parent = task("parent", project: "p1")
        let child = task("child", project: "p1", parent: "parent")
        let grandchild = task("grandchild", project: "p1", parent: "child")
        let stay = task("stay", project: "p1")
        let moved = ops.move(parent, to: "p2", among: [parent, child, grandchild, stay])

        XCTAssertEqual(moved.tasks.map(\.id), ["parent", "child", "grandchild"])
        XCTAssertTrue(moved.tasks.allSatisfy { $0.projectId == "p2" })
        XCTAssertEqual(moved.tasks[1].parentId, "parent", "the parent is now beside it")
        XCTAssertEqual(moved.tasks[2].parentId, "child")
        XCTAssertEqual(moved.ops.count, 3)
        XCTAssertFalse(moved.ops.contains { $0.entityId == "stay" })
        // A subtask's patch is only what changed for it.
        XCTAssertEqual(patch(moved.ops[1]).keys.sorted(), ["projectId", "sectionId"])
    }

    func testMovingToTheProjectItIsAlreadyInWritesNothing() {
        let here = task("a", project: "p1", section: "sec")
        let moved = ops.move(here, to: "p1", among: [here])
        XCTAssertTrue(moved.ops.isEmpty)
        XCTAssertEqual(moved.tasks, [here], "and does not quietly drop its section")
    }
}
