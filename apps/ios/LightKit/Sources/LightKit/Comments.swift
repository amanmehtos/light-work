import Foundation

/// A note on a task, imported or written on the web.
///
/// Read-only on the phone, as the plan has it (Phase 6): the thread is shown at
/// the foot of a task's editor and nothing here writes one. That is also why
/// there is no `commentFields` beside `Operations.taskFields` — the rule that
/// any op writing a whole entity must name every field has nothing to apply
/// to until a Swift op writes a comment, and if one ever does, it is the first
/// thing to add.
///
/// Mirrors `Comment` in `packages/core/src/entities.ts`, and decodes as
/// forgivingly as `Section` does and for the same reason: thirty-one of these
/// came from a Todoist import, a row can lack any key the importer had no value
/// for, and one that failed to decode would fail the whole snapshot — every
/// task with it. Only the id is required.
public struct Comment: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    /// A comment hangs off exactly one of a task or a project. Project-level
    /// ones (the importer keeps them) have no thread to appear in yet.
    public var taskId: String?
    public var projectId: String?
    public var content: String
    public var attachment: Attachment?
    public var postedById: String?
    /// ISO 8601, or the epoch where an import had no date to give.
    public var postedAt: String

    public struct Attachment: Codable, Sendable, Equatable {
        public var fileName: String
        public var fileType: String
        public var fileUrl: String
        public var fileSize: Int?

        public init(fileName: String = "", fileType: String = "", fileUrl: String = "",
                    fileSize: Int? = nil) {
            self.fileName = fileName
            self.fileType = fileType
            self.fileUrl = fileUrl
            self.fileSize = fileSize
        }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            fileName = try values.decodeIfPresent(String.self, forKey: .fileName) ?? ""
            fileType = try values.decodeIfPresent(String.self, forKey: .fileType) ?? ""
            fileUrl = try values.decodeIfPresent(String.self, forKey: .fileUrl) ?? ""
            // A size that is not a whole number is not worth losing the file over.
            fileSize = (try? values.decodeIfPresent(Int.self, forKey: .fileSize)) ?? nil
        }
    }

    public init(id: String, taskId: String? = nil, projectId: String? = nil, content: String = "",
                attachment: Attachment? = nil, postedById: String? = nil, postedAt: String = "") {
        self.id = id
        self.taskId = taskId
        self.projectId = projectId
        self.content = content
        self.attachment = attachment
        self.postedById = postedById
        self.postedAt = postedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        taskId = try values.decodeIfPresent(String.self, forKey: .taskId)
        projectId = try values.decodeIfPresent(String.self, forKey: .projectId)
        content = try values.decodeIfPresent(String.self, forKey: .content) ?? ""
        // An attachment that will not decode is an absent one, not a failed snapshot.
        attachment = (try? values.decodeIfPresent(Attachment.self, forKey: .attachment)) ?? nil
        postedById = try values.decodeIfPresent(String.self, forKey: .postedById)
        postedAt = try values.decodeIfPresent(String.self, forKey: .postedAt) ?? ""
    }
}

extension Comment {
    /// When it was posted, or nil when the row does not say.
    ///
    /// The importer writes the epoch for a comment Todoist gave no date, which
    /// is a placeholder and not a claim that it was written in 1970. Todoist's
    /// own dates carry microseconds; the formatter takes any number of
    /// fractional digits, and a plain one without them is tried second.
    public var postedDate: Date? {
        let date = ISO8601DateFormatter.lightWeek.date(from: postedAt)
            ?? ISO8601DateFormatter().date(from: postedAt)
        guard let date, date.timeIntervalSince1970 > 0 else { return nil }
        return date
    }

    /// The comments on one task, oldest first — the twin of `commentsOnTask`
    /// in `@light/client-sdk`, so the same task reads the same on both clients.
    /// A tie is broken by id, so a thread does not reshuffle between loads.
    public static func thread(for taskId: String, among comments: [Comment]) -> [Comment] {
        comments
            .filter { $0.taskId == taskId }
            .sorted {
                let (a, b) = ($0.postedDate?.timeIntervalSince1970 ?? 0,
                              $1.postedDate?.timeIntervalSince1970 ?? 0)
                return a != b ? a < b : $0.id < $1.id
            }
    }
}
