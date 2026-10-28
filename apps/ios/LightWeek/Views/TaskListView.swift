import SwiftUI
import DiurnalUI
import LightKit

/// The open tasks, each with a way into Light Minute.
///
/// Urgent first, which is the order someone deciding what to do next wants —
/// not the order they would file these in.
struct TaskListView: View {
    @ObservedObject var auth: LightWeekAuth
    @StateObject private var model: TaskListModel

    @State private var handoffError: String?

    init(auth: LightWeekAuth) {
        self.auth = auth
        _model = StateObject(wrappedValue: TaskListModel(auth: auth))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("This week")
                .toolbar { toolbar }
                // Behind the title rather than above the list: the sky is
                // ambient, and a band that pushed the week down the screen
                // would be charging real estate for weather.
                .background(alignment: .top) {
                    SkyHeader(height: .standard)
                        .ignoresSafeArea(edges: .top)
                        .allowsHitTesting(false)
                }
                .toolbarBackground(.hidden, for: .navigationBar)
        }
        // No tint anywhere in this app: a monochrome system has no accent, and
        // SwiftUI's default blue is exactly the hue the design excludes.
        .tint(Color.dnInk)
        .task { await model.load() }
        .alert("Can’t start a focus block", isPresented: Binding(
            get: { handoffError != nil },
            set: { shown in if !shown { handoffError = nil } }
        )) {
            Button("OK") { handoffError = nil }
        } message: {
            Text(handoffError ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        if let error = model.loadError, model.rows.isEmpty {
            message(title: "Could not load your tasks", detail: error)
        } else if model.rows.isEmpty && !model.isLoading {
            message(title: "Nothing open",
                    detail: "Every task on this account is done. Add one in Light Week on the web.")
        } else {
            List(model.rows) { row in
                TaskRowView(row: row, onFocus: { focus(row) })
                    .listRowSeparatorTint(Color.dnLine)
            }
            .listStyle(.plain)
            .refreshable { await model.load() }
        }
    }

    private func message(title: String, detail: String) -> some View {
        VStack(spacing: 8) {
            Text(title).font(DiurnalType.body(.headline, weight: .semibold)).foregroundStyle(Color.dnInk)
            Text(detail)
                .font(DiurnalType.body(.callout))
                .foregroundStyle(Color.dnInk2)
                .multilineTextAlignment(.center)
            Button("Try again") {
                // `LightKit.Task` shadows `_Concurrency.Task` in any file that
                // imports LightKit, so the concurrency one has to be named in
                // full here and anywhere else this app starts work from a view.
                _Concurrency.Task { await model.load() }
            }
            .font(DiurnalType.mono(.footnote))
            .padding(.top, 4)
        }
        .padding(32)
        .frame(maxHeight: .infinity)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if case .signedIn(let email) = auth.state, let email {
                    Section(email) {
                        signOutButton
                    }
                } else {
                    signOutButton
                }
            } label: {
                Image(systemName: "person.crop.circle")
                    .foregroundStyle(Color.dnInk)
            }
        }
    }

    private var signOutButton: some View {
        // No `.destructive` role: the system paints that red, and signing out
        // here only forgets the tokens — the grant itself is revoked from the
        // account, so there is nothing destructive to warn about either.
        Button("Sign out") {
            auth.signOut()
            _Concurrency.Task { await model.load() }
        }
    }

    private func focus(_ row: TaskListModel.Row) {
        _Concurrency.Task {
            do {
                try await FocusHandoff.open(row.task, projectName: row.projectName)
            } catch {
                handoffError = error.localizedDescription
            }
        }
    }
}

/// One task, flat on the page.
struct TaskRowView: View {
    let row: TaskListModel.Row
    let onFocus: () -> Void

    private static let priorityName = ["", "urgent", "high", "medium", "none"]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(row.task.content)
                    .font(DiurnalType.body())

                BadgeFlow(spacing: 6) { badges }
            }

            Spacer(minLength: 0)

            Button(action: onFocus) {
                Text("Focus")
                    .font(DiurnalType.body(.footnote, weight: .medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .foregroundStyle(Color.dnBackground)
                    .background(Color.dnInk, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Focus on \(row.task.content) in Light Minute")
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var badges: some View {
        if row.task.priority != .none {
            Badge(text: "p\(row.task.priority.rawValue) \(Self.priorityName[row.task.priority.rawValue])",
                  weight: row.task.priority == .urgent ? .solid : (row.task.priority == .high ? .outline : .plain))
        }

        if let projectName = row.projectName {
            Badge(text: projectName)
        }

        if let due = row.task.due {
            Badge(text: Self.day(due.date))
        }

        if let duration = row.task.duration {
            Badge(text: "\(duration.amount)\(duration.unit == .minute ? "m" : "d")")
        }

        // Outlined, so the time already spent never reads as the same kind of
        // thing as the estimate sitting next to it.
        if row.focus.sessions > 0 {
            Badge(text: "focused \(row.focus.humanFocusedTime)", weight: .outline)
        }
    }

    /// `today`, `tomorrow`, or a short date — the same three cases the web row
    /// shows, read off the first ten characters because a due date is a
    /// calendar day whether or not it also carries a time.
    private static func day(_ iso: String) -> String {
        let day = String(iso.prefix(10))
        let calendar = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = calendar.timeZone
        guard let date = formatter.date(from: day) else { return day }
        if calendar.isDateInToday(date) { return "today" }
        if calendar.isDateInTomorrow(date) { return "tomorrow" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
