import Foundation

/// Talks to a Light Week server.
///
/// Scoped to what the Light Suite apps actually need from Swift today: sign in,
/// read the account, and write focus sessions. It is deliberately not a full
/// local-first replica — that belongs in the Light Week iPhone app, and until
/// that exists, Light Minute needs only enough to pick a task and log time
/// against it.
public actor LightWeekClient {
    public enum Failure: Error, LocalizedError {
        case notSignedIn
        case http(status: Int, body: String)
        case transport(Error)

        public var errorDescription: String? {
            switch self {
            case .notSignedIn:
                return "Not signed in to Light Week."
            case .http(let status, let body):
                return status == 401
                    ? "Light Week rejected the session — sign in again."
                    : "Light Week returned \(status): \(body)"
            case .transport(let error):
                return error.localizedDescription
            }
        }
    }

    private let baseURL: URL
    private let session: URLSession
    private var token: String?
    private var cursor: Int = 0
    private let clock: Clock

    public init(baseURL: URL, token: String? = nil, node: String = LightID.newNode(),
                session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.clock = Clock(node: node)
    }

    public func setToken(_ token: String?) { self.token = token }

    public var isSignedIn: Bool { token != nil }

    // MARK: - Sign in

    /// Asks the server to email a six-digit code.
    public func requestCode(email: String) async throws {
        _ = try await send(
            "POST", "/auth/request-code", body: ["email": email], authenticated: false)
    }

    /// Exchanges a code for a session token, which is then kept for later calls.
    @discardableResult
    public func verifyCode(email: String, code: String, device: String) async throws -> String {
        struct Response: Decodable { let token: String }
        let data = try await send(
            "POST", "/auth/verify-code",
            body: ["email": email, "code": code, "device": device],
            authenticated: false)
        let response = try JSONDecoder().decode(Response.self, from: data)
        token = response.token
        return response.token
    }

    // MARK: - Reading

    public struct Snapshot: Decodable, Sendable {
        public var cursor: Int
        public var entities: Entities

        public struct Entities: Decodable, Sendable {
            public var project: [Project]?
            public var task: [Task]?
            public var label: [Label]?
            public var focusSession: [FocusSession]?
        }
    }

    /// The whole account.
    public func snapshot() async throws -> Snapshot {
        let data = try await send("GET", "/sync/snapshot")
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
        cursor = snapshot.cursor
        return snapshot
    }

    /// Open tasks, for a picker. Ordered by priority then title, which is the
    /// order someone choosing what to focus on wants.
    public func openTasks() async throws -> [Task] {
        let snapshot = try await snapshot()
        return (snapshot.entities.task ?? [])
            .filter { !$0.isCompleted }
            .sorted {
                $0.priority.rawValue != $1.priority.rawValue
                    ? $0.priority.rawValue < $1.priority.rawValue
                    : $0.content.localizedCaseInsensitiveCompare($1.content) == .orderedAscending
            }
    }

    // MARK: - Writing

    /// Records a block of focus. This is the call Light Minute makes.
    @discardableResult
    public func log(_ focusSession: FocusSession) async throws -> FocusSession {
        let op = Op(
            kind: "focusSession",
            entityId: focusSession.id,
            fields: try JSONValue.encoding(focusSession),
            clock: clock.next().encoded,
            node: clock.node)
        try await push([op])
        return focusSession
    }

    /// Marks a task complete.
    ///
    /// Note this does *not* handle recurrence: a recurring task completed this
    /// way is marked done rather than rescheduled. Recurrence lives in
    /// `@light/client-sdk` and belongs in the Light Week app, not here — Light
    /// Minute has no business rescheduling someone's repeating task.
    public func completeTask(id: String) async throws {
        let fields: JSONValue = .object([
            "isCompleted": .bool(true),
            "completedAt": .string(ISO8601DateFormatter.lightWeek.string(from: Date())),
        ])
        let op = Op(kind: "task", entityId: id, fields: fields,
                    clock: clock.next().encoded, node: clock.node)
        try await push([op])
    }

    private func push(_ ops: [Op]) async throws {
        let request = PushRequest(version: lightWeekProtocolVersion, since: cursor, ops: ops)
        let data = try await send("POST", "/sync", encodable: request)
        let response = try JSONDecoder().decode(SyncResponse.self, from: data)
        cursor = response.cursor

        for op in response.ops {
            if let remote = HLC(encoded: op.clock) { clock.observe(remote) }
        }
        if let rejected = response.rejected, !rejected.isEmpty {
            // The server refuses only what it will never accept, so retrying
            // would loop. Surface it instead.
            throw Failure.http(
                status: 422,
                body: rejected.map(\.reason).joined(separator: "; "))
        }
    }

    // MARK: - Transport

    private func send(
        _ method: String,
        _ path: String,
        body: [String: String]? = nil,
        authenticated: Bool = true
    ) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await perform(request, authenticated: authenticated)
    }

    private func send<T: Encodable>(
        _ method: String, _ path: String, encodable: T
    ) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.httpBody = try JSONEncoder().encode(encodable)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await perform(request, authenticated: true)
    }

    private func perform(_ request: URLRequest, authenticated: Bool) async throws -> Data {
        var request = request
        if authenticated {
            guard let token else { throw Failure.notSignedIn }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Failure.transport(error)
        }

        guard let http = response as? HTTPURLResponse else { return data }
        guard (200..<300).contains(http.statusCode) else {
            throw Failure.http(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }
}
