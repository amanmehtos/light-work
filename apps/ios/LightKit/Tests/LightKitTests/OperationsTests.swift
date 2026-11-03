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
