import Foundation
import LightKit

/// The open tasks, with the focus already spent on each.
///
/// Read-then-render against `/sync/snapshot`, not the local-first replica the
/// web client has. That replica is the right shape for this app eventually —
/// the store, the merge rule and the queue, ported from `@light/core` — but it
/// is a great deal of machinery to stand between a task list and the Focus
/// button, and nothing here writes yet, so there is no merge to get wrong.
@MainActor
final class TaskListModel: ObservableObject {

    /// One task as the list needs it: the task itself, the name of the project
    /// it sits in, and the focus accumulated against it.
    struct Row: Identifiable {
        var task: LightKit.Task
        var projectName: String?
        var focus: FocusStats

        var id: String { task.id }
    }

    /// Mirrors `ops.focusStatsForTask` in `@light/client-sdk`, including what it
    /// leaves out: breaks are not focus, so `short_break` and `long_break` rows
    /// are not counted even when they carry a `taskId`.
    struct FocusStats {
        var sessions: Int = 0
        var focusedSeconds: Int = 0
    }

    @Published private(set) var rows: [Row] = []
    @Published private(set) var isLoading = false
    /// A message, not an error: nothing here is recoverable by the app itself,
    /// and the only useful thing to do with a failure is say it.
    @Published private(set) var loadError: String?

    private let auth: LightWeekAuth
    private let client: LightWeekClient

    init(auth: LightWeekAuth) {
        self.auth = auth
        self.client = LightWeekClient(baseURL: LightWeek.origin)
    }

    func load() async {
        guard auth.isSignedIn else {
            rows = []
            return
        }
        isLoading = true
        loadError = nil
        do {
            // Re-set every time: a refresh rotates the access token, and a
            // client still holding the previous one would start answering 401
            // at some unpredictable point after an hour.
            await client.setToken(try await auth.accessToken())
            let snapshot = try await client.snapshot()
            rows = Self.rows(from: snapshot)
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
    }

    private static func rows(from snapshot: LightWeekClient.Snapshot) -> [Row] {
        var names: [String: String] = [:]
        for project in snapshot.entities.project ?? [] { names[project.id] = project.name }

        var focus: [String: FocusStats] = [:]
        for session in snapshot.entities.focusSession ?? [] {
            guard let taskId = session.taskId, session.kind == .focus else { continue }
            var stats = focus[taskId] ?? FocusStats()
            stats.sessions += 1
            stats.focusedSeconds += session.focusedSeconds
            focus[taskId] = stats
        }

        return snapshot.openTasks.map { task in
            Row(task: task,
                projectName: names[task.projectId],
                focus: focus[task.id] ?? FocusStats())
        }
    }
}

extension TaskListModel.FocusStats {
    /// `45m`, `2h`, `1h 20m` — the same rounding the web row uses, so the same
    /// task does not read as a different amount of work on the two screens.
    var humanFocusedTime: String {
        let minutes = Int((Double(focusedSeconds) / 60).rounded())
        if minutes < 60 { return "\(minutes)m" }
        let (hours, rest) = (minutes / 60, minutes % 60)
        return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
    }
}
