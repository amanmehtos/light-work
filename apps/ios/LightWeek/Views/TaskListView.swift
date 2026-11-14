import SwiftUI
import DiurnalUI
import LightKit

/// The app's navigation: a list of places, and the screen each one opens.
///
/// The root is `HomeView` — Inbox, Today, Upcoming, Day, Done, and the projects —
/// and each place pushes onto it. A place is a list of tasks, or the day, and
/// they share everything under the list: the rows, the swipes, the editor.
///
/// It opens on Today. That is the screen someone opens this app for, and the
/// list of places is one step back from it.
struct TaskListView: View {
    @ObservedObject var auth: LightWeekAuth
    @StateObject private var model: TaskListModel

    /// Where in the navigation the person is. Starts on Today: see above.
    @State private var path: [Destination] = [.today]
    @State private var day = Schedule.localDay(Date())
    @State private var editing: LightKit.Task?
    @State private var rescheduling: LightKit.Task?
    @State private var deleting: LightKit.Task?
    /// The task a subtask is being typed for, and what has been typed so far.
    @State private var addingSubtaskTo: LightKit.Task?
    @State private var subtaskTitle = ""
    @State private var showingPreferences = false
    @State private var handoffError: String?

    init(auth: LightWeekAuth) {
        self.auth = auth
        _model = StateObject(wrappedValue: TaskListModel(auth: auth))
    }

    var body: some View {
        NavigationStack(path: $path) {
            HomeView(
                model: model,
                onPreferences: { showingPreferences = true },
                onSignOut: {
                    auth.signOut()
                    _Concurrency.Task { await model.load() }
                },
                email: { if case .signedIn(let email) = auth.state { return email } else { return nil } }())
                .sky()
                .navigationDestination(for: Destination.self) { destination in
                    screen(destination)
                        .navigationTitle(title(of: destination))
                        .sky()
                }
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
        // The subtask's title. An alert with one field, not a sheet: it is a
        // title and nothing else, and the sheet's other fields (a date, a
        // priority) are the editor, one tap on the new row.
        //
        // `presenting:` hands the actions the task as it was when the alert came
        // up, so the Add button does not depend on whether dismissal has already
        // cleared the state it would otherwise read.
        .alert(
            Text(addingSubtaskTo.map { "Subtask of “\($0.content)”" } ?? "Add subtask"),
            isPresented: Binding(
                get: { addingSubtaskTo != nil },
                set: { shown in if !shown { addingSubtaskTo = nil } }),
            presenting: addingSubtaskTo
        ) { parent in
            TextField("Title", text: $subtaskTitle)
            Button("Add") {
                // An empty title is a tap on Add by mistake, not a write to refuse
                // with an alert of its own.
                let title = subtaskTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty { model.createSubtask(content: title, under: parent) }
                subtaskTitle = ""
            }
            Button("Cancel", role: .cancel) { subtaskTitle = "" }
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

    /// The project a destination names, if it still exists: an id kept in the
    /// navigation path goes stale when the project is deleted elsewhere, and a
    /// screen that said so is better than one that crashed.
    private func project(for destination: Destination) -> Project? {
        switch destination {
        case .inbox: return model.inbox
        case .project(let id): return model.visibleProjects.first { $0.id == id }
        default: return nil
        }
    }

    private func title(of destination: Destination) -> String {
        switch destination {
        case .inbox: return "Inbox"
        case .today: return "Today"
        case .upcoming: return "Upcoming"
        case .day: return "Your day"
        case .done: return "Done"
        case .project: return project(for: destination)?.name ?? "Project"
        }
    }

    @ViewBuilder
    private func screen(_ destination: Destination) -> some View {
        VStack(spacing: 0) {
            switch destination {
            case .inbox, .project:
                if let project = project(for: destination) {
                    // Into the project being looked at: a task added while
                    // viewing one that landed in the inbox would be a task that
                    // vanished from the screen it was typed on. Only here — Today
                    // and Upcoming are lists of what is due, and a task typed into
                    // one would have no date and vanish just the same.
                    ComposeBar(destination: project.name) { title in
                        model.create(content: title, projectId: project.id)
                    }
                    list(model.blocks(in: project), nests: true, empty: "Nothing open",
                         detail: "Every task in this project is done.")
                } else {
                    message(title: "That project is gone",
                            detail: "It was deleted or archived on another device.")
                }
            case .today:
                list(model.todayBlocks(), nests: true, empty: "Nothing due today",
                     detail: "Nothing is due today, and nothing is overdue.")
            case .upcoming:
                list(model.upcomingBlocks(), nests: true, empty: "Nothing scheduled ahead",
                     detail: "Tasks with a date after today collect here, a day at a time.")
            case .day:
                DayView(model: model, day: $day) { editing = $0 }
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
                    if let day = block.day {
                        DayHeadingRow(day: day, today: Schedule.localDay(Date()), count: block.entries.count)
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

        // "Add subtask" on the task itself, as Todoist's task menu has it, and
        // not an indent gesture. Indenting turns a task into a subtask of the
        // row above, and what is above differs by list — in Today it is some
        // other project's task — so it cannot mean one thing here. This means
        // the same on every row, and it makes a task rather than rearranging
        // one. Not on a finished task, and not in Done, which does not nest.
        if !task.isCompleted {
            Button {
                subtaskTitle = ""
                addingSubtaskTo = task
            } label: {
                Label("Add subtask", systemImage: "plus")
            }
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
            // Takes the width the row has left, rather than whatever it would
            // like. `BadgeFlow` answers an unspecified width proposal with the
            // whole run of badges on one infinite line — it has no other
            // sensible answer — and SwiftUI asks exactly that when sizing a
            // row. Unbounded, the column claimed that width, the spacer
            // collapsed and Focus was pushed off the right edge of the screen.
            // Bounded, the flow is handed a real width and wraps inside it.
            .frame(maxWidth: .infinity, alignment: .leading)
            // Tapping the task opens it; the box and the Focus button are
            // their own targets and keep their own taps.
            .contentShape(Rectangle())
            .onTapGesture(perform: onEdit)

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
                // Never squeezed: it is the one control here with a fixed
                // size, and a half-drawn "Focus" is worse than a narrower title.
                .fixedSize()
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

/// A day's heading in Upcoming: "Tomorrow", or the weekday and date, and how many
/// tasks fall on it.
///
/// Read-only. On the web this is also where a task is dropped to move it to that
/// day; here it is a label, and a task is rescheduled from its swipe or its menu.
struct DayHeadingRow: View {
    let day: String
    let today: String
    let count: Int

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(DiurnalType.body(.headline, weight: .semibold))
                .foregroundStyle(Color.dnInk)
            if let detail {
                Text(detail)
                    .font(DiurnalType.body(.footnote))
                    .foregroundStyle(Color.dnMuted)
            }
            Badge(text: "\(count)")
            Spacer(minLength: 0)
        }
        .padding(.top, 10)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel("\(detail.map { "\(title), \($0)" } ?? title), \(count) tasks")
    }

    private var date: Date? {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = Calendar.current.timeZone
        return formatter.date(from: day)
    }

    private var formatted: String {
        date?.formatted(.dateTime.weekday(.wide).day().month(.abbreviated)) ?? day
    }

    /// The same two cases the web's heading has: tomorrow by name with its date
    /// beside it, and any other day by its date alone.
    private var isTomorrow: Bool { day == Schedule.shift(day: today, by: 1) }
    private var title: String { isTomorrow ? "Tomorrow" : formatted }
    private var detail: String? { isTomorrow ? formatted : nil }
}

private extension View {
    /// The sky behind the title rather than above the list: it is ambient, and a
    /// band that pushed the list down the screen would be charging real estate
    /// for weather. On every screen of the navigation, not only the first.
    func sky() -> some View {
        background(alignment: .top) {
            SkyHeader(height: .standard)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        }
        .toolbarBackground(.hidden, for: .navigationBar)
    }
}
