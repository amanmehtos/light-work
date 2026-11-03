import SwiftUI
import DiurnalUI
import LightKit

/// The tasks, as a list or as a day.
///
/// The list is urgent-first, which is the order someone deciding what to do
/// next wants — not the order they would file these in. The day is the
/// planning surface: the same tasks against the hours they are meant to happen
/// in. The two are a segmented control rather than two tabs, because they are
/// one set of tasks seen two ways.
struct TaskListView: View {
    @ObservedObject var auth: LightWeekAuth
    @StateObject private var model: TaskListModel

    private enum Surface: String, CaseIterable {
        case list = "List"
        case day = "Day"
        case done = "Done"
    }

    @State private var surface: Surface = .list
    @State private var day = Schedule.localDay(Date())
    @State private var editing: LightKit.Task?
    @State private var showingPreferences = false
    @State private var handoffError: String?

    init(auth: LightWeekAuth) {
        self.auth = auth
        _model = StateObject(wrappedValue: TaskListModel(auth: auth))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(surface == .day ? "Your day" : "This week")
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
        .sheet(item: $editing) { task in
            TaskEditorView(task: task, model: model) { editing = nil }
        }
        .sheet(isPresented: $showingPreferences) {
            PreferencesView(model: model) { showingPreferences = false }
        }
        .alert("Can’t start a focus block", isPresented: Binding(
            get: { handoffError != nil },
            set: { shown in if !shown { handoffError = nil } }
        )) {
            Button("OK") { handoffError = nil }
        } message: {
            Text(handoffError ?? "")
        }
        .alert("That change didn’t save", isPresented: Binding(
            get: { model.writeError != nil },
            set: { shown in if !shown { model.writeError = nil } }
        )) {
            Button("OK") { model.writeError = nil }
        } message: {
            // The model has already reloaded from the server, so what is on
            // screen is true again — this only says that the edit is not.
            Text(model.writeError ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        VStack(spacing: 0) {
            Picker("View", selection: $surface) {
                ForEach(Surface.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            switch surface {
            case .day:
                DayView(model: model, day: $day) { editing = $0 }
            case .list:
                list(model.openRows, empty: "Nothing open",
                     detail: "Every task on this account is done.")
            case .done:
                list(model.completedRows, empty: "Nothing finished yet",
                     detail: "Tasks you complete collect here, and can be reopened.")
            }
        }
    }

    @ViewBuilder
    private func list(_ rows: [TaskListModel.Row], empty: String, detail: String) -> some View {
        if let error = model.loadError, model.rows.isEmpty {
            message(title: "Could not load your tasks", detail: error)
        } else if rows.isEmpty && !model.isLoading {
            message(title: empty, detail: detail)
        } else {
            List(rows) { row in
                TaskRowView(
                    row: row,
                    labels: model.labelNames(for: row.task),
                    onToggle: {
                        row.task.isCompleted ? model.reopen(row.task) : model.complete(row.task)
                    },
                    onEdit: { editing = row.task },
                    onFocus: { focus(row) })
                    .listRowSeparatorTint(Color.dnLine)
                    .listRowBackground(Color.clear)
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
                Button("Preferences") { showingPreferences = true }
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
    let labels: [String]
    let onToggle: () -> Void
    let onEdit: () -> Void
    let onFocus: () -> Void

    private static let priorityName = ["", "urgent", "high", "medium", "none"]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Checkbox(isOn: row.task.isCompleted, label: row.task.content, action: onToggle)

            VStack(alignment: .leading, spacing: 6) {
                Text(row.task.content)
                    .font(DiurnalType.body())
                    .strikethrough(row.task.isCompleted)
                    .foregroundStyle(row.task.isCompleted ? Color.dnMuted : Color.dnInk)

                BadgeFlow(spacing: 6) { badges }
            }
            // Tapping the task opens it; the box and the Focus button are
            // their own targets and keep their own taps.
            .contentShape(Rectangle())
            .onTapGesture(perform: onEdit)

            Spacer(minLength: 0)

            if !row.task.isCompleted {
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
            Badge(text: Self.when(due))
        }

        // Outlined, so a deadline never reads as the same kind of thing as the
        // due date sitting next to it.
        if let deadline = row.task.deadline {
            Badge(text: "due by \(Self.day(deadline.date))", weight: .outline)
        }

        if let duration = row.task.duration {
            Badge(text: "\(duration.amount)\(duration.unit == .minute ? "m" : "d")")
        }

        ForEach(labels, id: \.self) { name in
            Badge(text: "@\(name)")
        }

        // Shown because it is the point: the reward is what makes finishing
        // worth starting.
        if let reward = row.task.reward, !reward.isEmpty {
            Badge(text: "★ \(reward)", weight: .outline)
        }

        // Outlined, so the time already spent never reads as the same kind of
        // thing as the estimate sitting next to it.
        if row.focus.sessions > 0 {
            Badge(text: "focused \(row.focus.humanFocusedTime)", weight: .outline)
        }
    }

    /// The day, plus the time when there is one.
    private static func when(_ due: Due) -> String {
        guard let day = Schedule.day(of: due) else { return due.date }
        guard let minutes = Schedule.minutes(of: due) else { return Self.day(day) }
        return "\(Self.day(day)) \(Schedule.clock(minutes))"
    }

    /// `today`, `tomorrow`, or a short date — the same three cases the web row
    /// shows. Through `Schedule` rather than off the front of the string,
    /// because a timed due stores a UTC instant and slicing it puts an evening
    /// task on tomorrow.
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
