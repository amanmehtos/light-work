import SwiftUI
import DiurnalUI
import LightKit

/// Editing a task.
///
/// The twin of `apps/web/src/components/TaskEditor.tsx`, down to the fields
/// and the way they are grouped. It is a form with local state and one Save
/// rather than a live edit: sync merges per field, so a live edit would be
/// correct, but it would also mean a round of ops per keystroke and no way to
/// change your mind. Cancel has to mean something.
///
/// Dates are held as a day string and an optional time, the same two-part
/// shape `Due` has, so the "all day or at a time" question is answered by the
/// form rather than inferred from a `Date` that always has one.
struct TaskEditorView: View {
    let task: LightKit.Task
    @ObservedObject var model: TaskListModel
    let onClose: () -> Void

    @State private var content: String
    @State private var notes: String
    @State private var priority: Priority
    @State private var isScheduled: Bool
    @State private var day: Date
    @State private var hasTime: Bool
    @State private var time: Date
    @State private var hasDeadline: Bool
    @State private var deadline: Date
    @State private var estimate: String
    @State private var reward: String

    init(task: LightKit.Task, model: TaskListModel, onClose: @escaping () -> Void) {
        self.task = task
        self.model = model
        self.onClose = onClose

        _content = State(initialValue: task.content)
        _notes = State(initialValue: task.description)
        _priority = State(initialValue: task.priority)

        let scheduledOn = Schedule.day(of: task.due)
        _isScheduled = State(initialValue: scheduledOn != nil)
        _day = State(initialValue: Self.date(from: scheduledOn) ?? Date())

        let minutes = Schedule.minutes(of: task.due)
        _hasTime = State(initialValue: minutes != nil)
        _time = State(initialValue: Self.time(atMinutes: minutes ?? 9 * 60))

        _hasDeadline = State(initialValue: task.deadline != nil)
        _deadline = State(initialValue: Self.date(from: task.deadline?.date) ?? Date())

        _estimate = State(initialValue: task.duration.flatMap {
            $0.unit == .minute ? String($0.amount) : nil
        } ?? "")
        _reward = State(initialValue: task.reward ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Task", text: $content, axis: .vertical)
                        .font(DiurnalType.body())
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...6)
                        .font(DiurnalType.body(.callout))
                        .foregroundStyle(Color.dnInk2)
                }

                Section {
                    Picker("Priority", selection: $priority) {
                        Text("p1 — urgent").tag(Priority.urgent)
                        Text("p2 — high").tag(Priority.high)
                        Text("p3 — medium").tag(Priority.medium)
                        Text("p4 — none").tag(Priority.none)
                    }
                }

                Section("When you will do it") {
                    Toggle("Scheduled", isOn: $isScheduled)
                    if isScheduled {
                        DatePicker("Day", selection: $day, displayedComponents: .date)
                        Toggle("At a time", isOn: $hasTime)
                        if hasTime {
                            DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                        }
                    }
                }

                Section {
                    Toggle("Has a deadline", isOn: $hasDeadline)
                    if hasDeadline {
                        DatePicker("Owed by", selection: $deadline, displayedComponents: .date)
                    }
                } header: {
                    Text("Deadline")
                } footer: {
                    // Spelled out because the two dates sitting next to each
                    // other is exactly where it gets confusing.
                    Text("When you plan to do it is not the same question as when it is owed.")
                }

                Section("Estimate") {
                    HStack {
                        TextField("30", text: $estimate)
                            .keyboardType(.numberPad)
                        Text("minutes").foregroundStyle(Color.dnMuted)
                    }
                }

                if !model.labelNames(for: task).isEmpty {
                    Section("Labels") {
                        BadgeFlow(spacing: 6) {
                            ForEach(model.labelNames(for: task), id: \.self) { name in
                                Badge(text: "@\(name)")
                            }
                        }
                    }
                }

                if model.rewardsEnabled {
                    Section {
                        TextField("An hour in the sun", text: $reward)
                    } header: {
                        Text("Reward")
                    } footer: {
                        Text("Finishing this files the reward in Rewards, to look back on.")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.dnBackground)
            .navigationTitle("Edit task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onClose)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(content.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .tint(Color.dnInk)
    }

    private func save() {
        let trimmed = content.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }

        let calendar = Calendar.current
        let chosenDay = Schedule.localDay(day)
        let due: Due?
        if !isScheduled {
            due = nil
        } else if hasTime {
            let parts = calendar.dateComponents([.hour, .minute], from: time)
            due = Schedule.at(day: chosenDay,
                              minutes: (parts.hour ?? 0) * 60 + (parts.minute ?? 0),
                              from: task.due)
        } else {
            due = Schedule.at(day: chosenDay, from: task.due)
        }

        let amount = Int(estimate.trimmingCharacters(in: .whitespaces))
        let trimmedReward = reward.trimmingCharacters(in: .whitespaces)

        model.update(task, .init(
            content: trimmed,
            description: notes,
            priority: priority,
            due: .some(due),
            deadline: .some(hasDeadline ? Deadline(date: Schedule.localDay(deadline)) : nil),
            duration: .some(amount.flatMap { $0 > 0 ? Duration(amount: $0) : nil }),
            // Empty is not nil: it means a reward was set and then cleared,
            // and the model keeps that distinction deliberately.
            reward: .some(trimmedReward.isEmpty ? (task.reward == nil ? nil : "") : trimmedReward)))
        onClose()
    }

    private static func date(from day: String?) -> Date? {
        guard let day else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = Calendar.current.timeZone
        return formatter.date(from: String(day.prefix(10)))
    }

    private static func time(atMinutes minutes: Int) -> Date {
        var parts = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        parts.hour = minutes / 60
        parts.minute = minutes % 60
        return Calendar.current.date(from: parts) ?? Date()
    }
}
