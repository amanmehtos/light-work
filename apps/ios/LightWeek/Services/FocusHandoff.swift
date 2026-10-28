import Foundation
import UIKit
import LightKit

/// Handing a task to Light Minute to be focused on.
///
/// This is the link the whole suite turns on, and until now nothing emitted it:
/// Light Minute has read it since it was written, but the only way to send one
/// was `xcrun simctl openurl`. The arc is pick a task here, tap Focus, run the
/// timer there, and have the finished block come back against the task — and
/// this is its first half.
///
/// Everything the timer needs to put on screen travels in the link, so Light
/// Minute never waits on a round trip, or on being signed in at all, to show
/// what is being counted. Only `taskId` means anything to the server.
enum FocusHandoff {

    enum Failure: LocalizedError {
        case lightMinuteMissing

        var errorDescription: String? {
            switch self {
            case .lightMinuteMissing:
                return "Light Minute isn’t installed on this iPhone, so there is nothing to hand this task to."
            }
        }
    }

    /// The default block, for a task that does not say how long it should take.
    /// Twenty-five minutes, which is Light Minute's own default.
    private static let defaultPlannedSeconds = 1500

    /// `com.lightminute.app:/focus?taskId=…&title=…&projectName=…&projectId=…&planned=1500`
    ///
    /// RFC 8252's single-slash form, so the verb lands in the path rather than
    /// in a host. Light Minute reads the two-slash spelling too, but there is no
    /// reason to send the form that only works by its forgiveness.
    static func url(for task: Task, projectName: String?) -> URL {
        var fields = [("taskId", task.id), ("title", task.content)]
        if let projectName, !projectName.isEmpty { fields.append(("projectName", projectName)) }
        if !task.projectId.isEmpty { fields.append(("projectId", task.projectId)) }
        fields.append(("planned", String(plannedSeconds(for: task))))

        var components = URLComponents()
        components.scheme = "com.lightminute.app"
        components.path = "/focus"
        // Encoded by hand rather than through `queryItems`, which leaves `+`
        // alone: a title like "C++ rewrite" then arrives as a space wherever the
        // reader follows the form-encoding convention instead of RFC 3986's.
        components.percentEncodedQuery = fields
            .map { "\($0)=\(encoded($1))" }
            .joined(separator: "&")
        return components.url!
    }

    /// What the timer should be set to.
    ///
    /// A task's own estimate when it has one, which is the user's judgement
    /// about this task rather than a default about tasks in general. Floored at
    /// a minute to match what Light Minute will accept — and a `day` duration
    /// is an estimate of elapsed time, not of focus, so it is no guide to how
    /// long to sit with this.
    private static func plannedSeconds(for task: Task) -> Int {
        guard let duration = task.duration, duration.unit == .minute else {
            return defaultPlannedSeconds
        }
        return max(60, duration.amount * 60)
    }

    /// Whether there is anything to hand off to.
    ///
    /// `com.lightminute.app` is declared in `LSApplicationQueriesSchemes`;
    /// without that this answers `false` however installed the app is.
    @MainActor
    static var isAvailable: Bool {
        guard let probe = URL(string: "com.lightminute.app:/focus") else { return false }
        return UIApplication.shared.canOpenURL(probe)
    }

    /// Opens Light Minute on this task, or says why it could not.
    @MainActor
    static func open(_ task: Task, projectName: String?) async throws {
        guard isAvailable else { throw Failure.lightMinuteMissing }
        let opened = await UIApplication.shared.open(url(for: task, projectName: projectName))
        // `canOpenURL` can pass and the open still fail — the app was deleted
        // between the two, or iOS declined. Saying so is the point: the one
        // outcome this must never have is a Focus button that does nothing.
        guard opened else { throw Failure.lightMinuteMissing }
    }

    /// RFC 3986 unreserved only. Everything else goes as a percent-triplet,
    /// which is why `&`, `=` and `+` in a task's title cannot change the shape
    /// of the query they sit in.
    private static func encoded(_ value: String) -> String {
        var unreserved = CharacterSet.alphanumerics
        unreserved.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}
