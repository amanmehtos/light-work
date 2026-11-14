import XCTest
@testable import LightKit

/// Comments, which reach the phone read-only and from an import.
///
/// The first half is about *not failing*, as in `StructureTests`: a comment
/// that cannot be decoded takes the whole snapshot with it, so every task on
/// the account vanishes because of one note. The importer's rows are the
/// realistic input, and they differ from what a client writes — microsecond
/// timestamps, an epoch where Todoist gave no date, someone else's user id,
/// keys this model has no field for.
final class CommentDecodingTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let imported = """
    {"id":"c1","taskId":"t1","projectId":null,"content":"Lead with economics.\\nThen the roadmap.",
     "attachment":null,"postedById":"todoist-uid-1234","postedAt":"2024-03-01T09:30:00.123456Z",
     "reactions":{"x":["y"]},"uidsToNotify":[]}
    """

    func testAnImportedCommentDecodesAndKeepsItsLineBreak() throws {
        let comment = try decode(Comment.self, imported)
        XCTAssertEqual(comment.taskId, "t1")
        XCTAssertNil(comment.projectId)
        XCTAssertEqual(comment.content, "Lead with economics.\nThen the roadmap.")
        XCTAssertEqual(comment.postedById, "todoist-uid-1234")
    }

    func testTheSnapshotCarriesCommentsAndStillDecodesWithoutThem() throws {
        let with = try decode(LightWeekClient.Snapshot.self, """
        {"cursor":3,"entities":{"comment":[\(imported)]}}
        """)
        XCTAssertEqual(with.entities.comment?.count, 1)

        let without = try decode(LightWeekClient.Snapshot.self, #"{"cursor":1,"entities":{}}"#)
        XCTAssertNil(without.entities.comment)
    }

    func testOnlyTheIdIsRequired() throws {
        let bare = try decode(Comment.self, #"{"id":"c2"}"#)
        XCTAssertEqual(bare.content, "")
        XCTAssertNil(bare.taskId)
        XCTAssertNil(bare.attachment)
        XCTAssertEqual(bare.postedAt, "")
        XCTAssertNil(bare.postedDate)
    }

    func testAnAttachmentDecodes() throws {
        let comment = try decode(Comment.self, """
        {"id":"c3","taskId":"t1","content":"Deck v3","attachment":
         {"fileName":"deck.pdf","fileType":"application/pdf","fileUrl":"https://example.com/deck.pdf","fileSize":2048}}
        """)
        XCTAssertEqual(comment.attachment,
                       .init(fileName: "deck.pdf", fileType: "application/pdf",
                             fileUrl: "https://example.com/deck.pdf", fileSize: 2048))
    }

    func testAnAttachmentThatIsNotOneIsAbsentRatherThanAFailedSnapshot() throws {
        let nonsense = try decode(Comment.self, #"{"id":"c4","attachment":"deck.pdf"}"#)
        XCTAssertNil(nonsense.attachment)

        let oddSize = try decode(Comment.self, """
        {"id":"c5","attachment":{"fileName":"a.png","fileSize":1.5}}
        """)
        XCTAssertEqual(oddSize.attachment?.fileName, "a.png")
        XCTAssertNil(oddSize.attachment?.fileSize)
    }

    func testACommentSurvivesAnEncodeAndDecode() throws {
        let comment = try decode(Comment.self, imported)
        let again = try decode(Comment.self, String(data: JSONEncoder().encode(comment), encoding: .utf8)!)
        XCTAssertEqual(again, comment)
    }

    // MARK: - dates

    func testATodoistTimestampWithMicrosecondsIsADate() throws {
        XCTAssertNotNil(try decode(Comment.self, imported).postedDate)
    }

    func testAPlainTimestampIsADateToo() {
        XCTAssertNotNil(Comment(id: "a", postedAt: "2026-11-14T10:00:00Z").postedDate)
        XCTAssertNotNil(Comment(id: "a", postedAt: "2026-11-14T10:00:00.000Z").postedDate)
    }

    func testTheEpochPlaceholderAndGarbageAreUndated() {
        XCTAssertNil(Comment(id: "a", postedAt: "1970-01-01T00:00:00.000Z").postedDate)
        XCTAssertNil(Comment(id: "a", postedAt: "last tuesday").postedDate)
    }
}

final class CommentThreadTests: XCTestCase {

    private func comment(_ id: String, on task: String? = "t1", project: String? = nil,
                         at posted: String = "2024-03-01T00:00:00.000Z") -> Comment {
        Comment(id: id, taskId: task, projectId: project, content: id, postedAt: posted)
    }

    func testOldestFirstWithTiesBrokenByID() {
        let thread = Comment.thread(for: "t1", among: [
            comment("c", at: "2024-03-03T00:00:00.000Z"),
            comment("b", at: "2024-03-02T00:00:00.000Z"),
            comment("a", at: "2024-03-02T00:00:00.000Z"),
        ])
        XCTAssertEqual(thread.map(\.id), ["a", "b", "c"])
    }

    func testOnlyThisTasksComments() {
        let thread = Comment.thread(for: "t1", among: [
            comment("mine"), comment("theirs", on: "t2"), comment("project", on: nil, project: "p1"),
        ])
        XCTAssertEqual(thread.map(\.id), ["mine"])
    }

    func testAnUndatedCommentSortsBeforeADatedOne() {
        let thread = Comment.thread(for: "t1", among: [
            comment("dated"), comment("undated", at: "1970-01-01T00:00:00.000Z"),
        ])
        XCTAssertEqual(thread.map(\.id), ["undated", "dated"])
    }
}

final class CommentDeletionTests: XCTestCase {
    private let ops = Operations(clock: Clock(node: "test-device"))

    private func task(_ id: String, parent: String? = nil) -> LightKit.Task {
        LightKit.Task(
            id: id, projectId: "p1", sectionId: nil, parentId: parent,
            content: id, description: "", priority: .none, order: "V",
            due: nil, deadline: nil, duration: nil, labelIds: [], reward: nil,
            isCompleted: false, completedAt: nil, createdAt: "2026-11-01T00:00:00.000Z")
    }

    func testDeletingATaskTombstonesItsCommentsAndItsSubtasksButNotOthers() {
        let all = [task("parent"), task("child", parent: "parent"), task("other")]
        let comments = [Comment(id: "c1", taskId: "parent"), Comment(id: "c2", taskId: "child"),
                        Comment(id: "c3", taskId: "other"), Comment(id: "c4", projectId: "p1")]
        let deletion = ops.delete(all[0], among: all, comments: comments)

        XCTAssertEqual(deletion.deleted, ["child", "parent"])
        XCTAssertEqual(Set(deletion.deletedComments), ["c1", "c2"])
        XCTAssertEqual(deletion.ops.map(\.kind), ["task", "task", "comment", "comment"])
        XCTAssertTrue(deletion.ops.allSatisfy { $0.type == "delete" && $0.fields == nil })
    }

    func testWithNoCommentsKnownItIsTheDeleteItAlwaysWas() {
        let a = task("a")
        let deletion = ops.delete(a, among: [a])
        XCTAssertEqual(deletion.ops.count, 1)
        XCTAssertTrue(deletion.deletedComments.isEmpty)
    }
}
