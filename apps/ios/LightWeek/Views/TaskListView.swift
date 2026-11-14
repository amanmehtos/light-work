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
    /// The project the list is narrowed to, or nil for every open task. Kept as
    /// an id so a project deleted elsewhere simply stops matching.
    ///
    /// A stopgap for the project navigation that belongs to a later phase: the
    /// list used to be one flat run of every task on the account, which has no
    /// place for a section heading. Narrowed to a project it has one.
    @State private var scopeId: String?
    @State private var day = Schedule.localDay(Date())
    @State private var editing: LightKit.Task?
    @State private var rescheduling: LightKit.Task?
    @State private var deleting: LightKit.Task?
    @State private var showingPreferences = false
    @State private var handoffError: String?

    init(auth: LightWeekAuth) {
        self.auth = auth
        _model = StateObject(wrappedValue: TaskListModel(auth: auth))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
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

    private var scope: Project? {
        scopeId.flatMap { id in model.visibleProjects.first { $0.id == id } }
    }

    private var title: String {
        switch surface {
        case .day: return "Your day"
        case .list: return scope?.name ?? "This week"
        case .done: return "This week"
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

            if surface == .list {
                // Into the project being looked at, when one is: a task added
                // while viewing a project that landed in the inbox would be a
                // task that vanished from the screen it was typed on.
                ComposeBar(destination: (scope ?? model.defaultProject)?.name) { title in
                    guard let project = scope ?? model.defaultProject else { return }
                    model.create(content: title, projectId: project.id)
                }
            }

            switch surface {
            case .day:
                DayView(model: model, day: $day) { editing = $0 }
            case .list:
                list(model.blocks(in: scope), nests: true, empty: "Nothing open",
                     detail: "Every task on this account is done.")
            case .done:
                list(model.completedBlocks(), nests: false, empty: "Nothing finished yet",
                     detail: "Tasks you complete collect here, and can be reopened.")
            }
        }
    }

    @ViewBuilder
    private func list(_ blocks: [TaskListModel.Block], nests: Bool, empty: String, detail: String) -> some View {
        let total = blocks.reduce(0) { $0 + $1.entries.count }
        // A project that is all headings and no tasks is still a project to look
        // at: the headings are the structure, and they are what a task is
        // dropped into on the web.
        let hasHeadings = blocks.contains { $0.section != nil }
        if let error = model.loadError, model.rows.isEmpty {
            message(title: "Could not load your tasks", detail: error)
        } else if total == 0 && !hasHeadings && !model.isLoading {
            message(title: empty, detail: detail)
        } else {
            List {
                ForEach(blocks) { block in
                    if let section = block.section {
                        SectionHeadingRow(
                            section: section, count: block.entries.count,
                            onToggle: { model.setCollapsed(section, !section.isCollapsed) })
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                    // A folded section keeps its rows out of the list but its
                    // count on the heading, so it says what is folded in it.
                    if block.section?.isCollapsed != true {
                        ForEach(block.entries.filter { !$0.outline.isHidden }) { entry in
                            rowView(entry, nests: nests)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .refreshable { await model.load() }
            .confirmationDialog(
                "Reschedule", isPresented: Binding(
                    get: { rescheduling != nil },
                    set: { shown in if !shown { rescheduling = nil } }),
                titleVisibility: .visible, presenting: rescheduling
            ) { task in
                ForEach(Reschedule.allCases, id: \.self) { target in
                    Button(target.title) { model.reschedule(task, to: target) }
                }
                Button("No date") { model.reschedule(task, to: nil) }
            } message: { task in
                Text(task.content)
            }
            .confirmationDialog(
                deleting.map { "Delete “\($0.content)”?" } ?? "Delete", isPresented: Binding(
                    get: { deleting != nil },
                    set: { shown in if !shown { deleting = nil } }),
                titleVisibility: .visible, presenting: deleting
            ) { task in
                Button("Delete") { model.delete(task) }
            } message: { task in
                let count = model.subtaskCount(of: task)
                Text(count == 0
                     ? "This can’t be undone."
                     : "Its \(count) subtask\(count == 1 ? "" : "s") will be deleted too. This can’t be undone.")
            }
        }
    }

    /// One row, with everything that hangs off it.
    private func rowView(_ entry: TaskListModel.Entry, nests: Bool) -> some View {
        let row = entry.row
        return TaskRowView(
            row: row,
            outline: nests ? entry.outline : nil,
            labels: model.labelNames(for: row.task),
            onToggle: { toggle(row.task) },
            onEdit: { editing = row.task },
            onFocus: { focus(row) },
            onFold: { model.setCollapsed(row.task, !row.task.isCollapsed) })
            .listRowSeparatorTint(Color.dnLine)
            .listRowBackground(Color.clear)
            // Leading is the one you do most: finishing. It goes through
            // `toggle`, which is `Operations.complete` — the rule that
            // files a task's reward — and not a write of `isCompleted`
            // of its own, or a swipe would finish a task and quietly
            // earn nothing.
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button { toggle(row.task) } label: {
                    Label(row.task.isCompleted ? "Reopen" : "Complete",
                          systemImage: row.task.isCompleted ? "arrow.uturn.backward" : "checkmark")
                }
                // Tinted with ink: the system would otherwise paint the
                // action in its own colour, and this app has no hue.
                .tint(Color.dnInk)
            }
            // Not a full swipe: a delete that one long drag can reach
            // by accident is how a task with subtasks goes unnoticed.
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                // No `.destructive` role anywhere here: the system paints
                // that red, and red is spoken for by overdue.
                Button { deleting = row.task } label: {
                    Label("Delete", systemImage: "trash")
                }
                .tint(Color.dnInk)

                Button { rescheduling = row.task } label: {
                    Label("Reschedule", systemImage: "calendar")
                }
                .tint(Color.dnInk2)
            }
            .contextMenu { menu(for: row.task) }
    }

    /// Done and not done, from one place: the swipe and the box on the row both
    /// come through here, so neither can finish a task without the reward.
    private func toggle(_ task: LightKit.Task) {
        task.isCompleted ? model.reopen(task) : model.complete(task)
    }

    /// What a long press on a row offers: everything the swipe does and the
    /// edits that would not fit on it.
    @ViewBuilder
    private func menu(for task: LightKit.Task) -> some View {
        Menu {
            ForEach(Priority.allCases, id: \.self) { priority in
                Button {
                    model.setPriority(task, priority)
                } label: {
                    if priority == task.priority {
                        Label(Self.priorityTitle(priority), systemImage: "checkmark")
                    } else {
                        Text(Self.priorityTitle(priority))
                    }
                }
            }
        } label: {
            Label("Priority", systemImage: "flag")
        }

        Menu {
            ForEach(Reschedule.allCases, id: \.self) { target in
                Button(target.title) { model.reschedule(task, to: target) }
            }
            Button("No date") { model.reschedule(task, to: nil) }
        } label: {
            Label("Reschedule", systemImage: "calendar")
        }

        Menu {
            ForEach(model.movableProjects.filter { $0.id != task.projectId }) { project in
                Button(project.name) { model.move(task, to: project) }
            }
        } label: {
            Label("Move to project", systemImage: "folder")
        }

        Button { deleting = task } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    private static func priorityTitle(_ priority: Priority) -> String {
        let name = ["", "urgent", "high", "medium", "none"][priority.rawValue]
        return "p\(priority.rawValue) \(name)"
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
        if surface == .list {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Button { scopeId = nil } label: {
                        if scope == nil { Label("All projects", systemImage: "checkmark") } else { Text("All projects") }
                    }
                    ForEach(model.movableProjects) { project in
                        Button { scopeId = project.id } label: {
                            if scope?.id == project.id {
                                Label(project.name, systemImage: "checkmark")
                            } else {
                                Text(project.name)
                            }
                        }
                    }
                } label: {
                    Image(systemName: "folder")
                        .foregroundStyle(Color.dnInk)
                }
                .accessibilityLabel("Show a project")
            }
        }

        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Preferences") { showingPreferences = true }
                if case .signedIn(let email) = auth.state, let email {
                    SwiftUI.Section(email) {
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
    /// Where the row sits among its subtasks; nil in a list that does not nest.
    let outline: Outline.Row?
    let labels: [String]
    let onToggle: () -> Void
    let onEdit: () -> Void
    let onFocus: () -> Void
    let onFold: () -> Void

    private static let priorityName = ["", "urgent", "high", "medium", "none"]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if let outline {
                // A slot on every row, so titles line up whether or not a row has
                // a chevron. The glyph says what a tap will do.
                Group {
                    if outline.hasChildren {
                        Button(action: onFold) {
                            Image(systemName: outline.isCollapsed ? "chevron.right" : "chevron.down")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Color.dnMuted)
                                .frame(width: 20, height: 28)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            "\(outline.isCollapsed ? "Show" : "Hide") subtasks of \(row.task.content)")
                    } else {
                        Color.clear
                    }
                }
                .frame(width: 20)
            }

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
        // Indented by depth, which is how a subtask reads as belonging to the
        // row above it.
        .padding(.leading, CGFloat(outline?.depth ?? 0) * 22)
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

        // How far through its own subtasks, whether or not they are showing:
        // folded, this is all the row has to say what is inside.
        if let outline, outline.subtasksTotal > 0 {
            Badge(text: "\(outline.subtasksDone)/\(outline.subtasksTotal)", weight: .outline)
        }

        // A subtask standing away from its parent says whose it is.
        if let parent = outline?.parentTitle {
            Badge(text: "↳ \(parent)", weight: .outline)
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

/// A section's heading in a project list: a chevron, the name, how many tasks it
/// holds, and the notes beneath it while it is open.
///
/// Tapping folds it, and that is synced — the flag is the one the web writes.
/// Making, renaming and deleting sections stays on the web this phase.
struct SectionHeadingRow: View {
    let section: LightKit.Section
    let count: Int
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    Image(systemName: section.isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.dnMuted)
                        .frame(width: 16)
                    Text(section.name)
                        .font(DiurnalType.body(.headline, weight: .semibold))
                        .foregroundStyle(Color.dnInk)
                    Badge(text: "\(count)")
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(section.name), \(section.isCollapsed ? "folded" : "open"), \(count) tasks")

            if !section.isCollapsed && !section.description.isEmpty {
                Text(section.description)
                    .font(DiurnalType.body(.footnote))
                    .foregroundStyle(Color.dnInk2)
                    .lineLimit(3)
            }
        }
        .padding(.top, 10)
    }
}
