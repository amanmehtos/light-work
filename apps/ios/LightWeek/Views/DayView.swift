import SwiftUI
import DiurnalUI
import LightKit

/// The day, as hours you can drop a task into.
///
/// The twin of `apps/web/src/components/Day.tsx`, and the same arithmetic
/// underneath: `Schedule` is shared with it in spirit and tested against the
/// same cases. A task in the rail has a day but no time; one in the grid has
/// both, and dragging between the two is the whole feature.
///
/// The rail is above the hours rather than beside them, because a phone has no
/// width to give a second column — the web lays them side by side and collapses
/// to this at the same breakpoint.
struct DayView: View {
    @ObservedObject var model: TaskListModel
    @Binding var day: String
    let onOpen: (LightKit.Task) -> Void

    /// Points per hour. Taller than the web's 48, because a finger is wider
    /// than a pointer and a quarter hour still has to be a target.
    private static let hourHeight: CGFloat = 64
    private static var minuteHeight: CGFloat { hourHeight / 60 }

    /// Where the grid sits on screen, so a drop can be turned into a time.
    @State private var gridFrame: CGRect = .zero
    @State private var railFrame: CGRect = .zero
    /// The task in hand, and how far it has been moved.
    @State private var dragging: String?
    @State private var offset: CGSize = .zero
    @State private var now = Date()

    private let tick = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    var body: some View {
        let today = Schedule.localDay(Date())
        let split = model.day(day)

        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                rail(split.waiting)
                grid(split.timed, today: today)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .background(Color.dnBackground)
        .coordinateSpace(name: "day")
        .onReceive(tick) { now = $0 }
        .safeAreaInset(edge: .top) { header(today: today) }
    }

    // MARK: - Pieces

    private func header(today: String) -> some View {
        HStack(spacing: 12) {
            Button { day = Schedule.shift(day: day, by: -1) } label: {
                Image(systemName: "chevron.left")
            }
            .accessibilityLabel("Previous day")

            Text(longDay(day))
                .font(DiurnalType.body(.headline, weight: .semibold))
                .frame(maxWidth: .infinity)

            Button { day = Schedule.shift(day: day, by: 1) } label: {
                Image(systemName: "chevron.right")
            }
            .accessibilityLabel("Next day")

            if day != today {
                Button("Today") { day = today }
                    .font(DiurnalType.mono(.footnote))
            }
        }
        .foregroundStyle(Color.dnInk)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func rail(_ waiting: [LightKit.Task]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Waiting")
                .dnEyebrow()
                .foregroundStyle(Color.dnMuted)

            if waiting.isEmpty {
                Text("Nothing waiting. Drag a block here to unschedule it.")
                    .font(DiurnalType.body(.footnote))
                    .foregroundStyle(Color.dnMuted)
                    .padding(.vertical, 8)
            } else {
                ForEach(waiting) { task in
                    card(task) {
                        Text(task.content)
                            .font(DiurnalType.body(.subheadline))
                            .lineLimit(1)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.dnSurface, in: RoundedRectangle(cornerRadius: DiurnalTokens.radius))
        .overlay {
            RoundedRectangle(cornerRadius: DiurnalTokens.radius)
                .stroke(Color.dnLine, lineWidth: 1)
        }
        .background {
            GeometryReader { geometry in
                Color.clear.onAppear { railFrame = geometry.frame(in: .named("day")) }
                    .onChange(of: geometry.frame(in: .named("day"))) { railFrame = $1 }
            }
        }
    }

    private func grid(_ timed: [LightKit.Task], today: String) -> some View {
        HStack(alignment: .top, spacing: 0) {
            // Hour labels in their own column, so a block can never sit on one.
            VStack(spacing: 0) {
                ForEach(0..<24, id: \.self) { hour in
                    Text(Schedule.clock(hour * 60))
                        .font(DiurnalType.mono(.caption2))
                        .foregroundStyle(Color.dnMuted)
                        .frame(height: Self.hourHeight, alignment: .top)
                        // Lifted half a line, so the label reads as marking the
                        // line rather than sitting in the hour below it.
                        .offset(y: -5)
                }
            }
            .frame(width: 46, alignment: .trailing)
            .padding(.trailing, 8)

            ZStack(alignment: .topLeading) {
                ForEach(0..<24, id: \.self) { hour in
                    Rectangle()
                        .fill(Color.dnLine)
                        .frame(height: 1)
                        .offset(y: CGFloat(hour) * Self.hourHeight)
                }

                if day == today { nowLine }

                ForEach(timed) { task in block(task) }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .frame(height: Self.hourHeight * 24, alignment: .top)
            .background {
                GeometryReader { geometry in
                    Color.clear.onAppear { gridFrame = geometry.frame(in: .named("day")) }
                        .onChange(of: geometry.frame(in: .named("day"))) { gridFrame = $1 }
                }
            }
        }
        .padding(.top, 6)
    }

    /// Now. The one thing on this screen that moves by itself.
    private var nowLine: some View {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: now)
        let minutes = CGFloat((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
        return ZStack(alignment: .leading) {
            Rectangle().fill(Color.dnInk).frame(height: 2)
            Circle().fill(Color.dnInk).frame(width: 8, height: 8).offset(x: -4)
        }
        .offset(y: minutes * Self.minuteHeight)
        .accessibilityHidden(true)
    }

    private func block(_ task: LightKit.Task) -> some View {
        let start = Schedule.minutes(of: task.due) ?? 0
        let length = Schedule.blockMinutes(task.duration)
        let place = Schedule.layOut(model.day(day).timed) [task.id] ?? (column: 0, columns: 1)

        return GeometryReader { geometry in
            let width = geometry.size.width / CGFloat(place.columns)
            card(task) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(task.content)
                        .font(DiurnalType.body(.subheadline))
                        .lineLimit(1)
                    Text("\(Schedule.clock(start)) – \(Schedule.clock(start + length))")
                        .font(DiurnalType.mono(.caption2))
                        .foregroundStyle(Color.dnMuted)
                }
            }
            .frame(width: max(0, width - 2),
                   height: max(CGFloat(Schedule.snapMinutes) * Self.minuteHeight,
                               CGFloat(length) * Self.minuteHeight),
                   alignment: .topLeading)
            .offset(x: CGFloat(place.column) * width,
                    y: CGFloat(start) * Self.minuteHeight)
        }
    }

    /// A card, in the rail or in the grid: the same thing, dragged the same way.
    private func card<Content: View>(
        _ task: LightKit.Task, @ViewBuilder content: () -> Content
    ) -> some View {
        let inHand = dragging == task.id

        return HStack(alignment: .top, spacing: 10) {
            Checkbox(isOn: task.isCompleted, label: task.content) {
                model.complete(task)
            }
            content()
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(Color.dnRaised, in: RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall))
        .overlay {
            RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall)
                .stroke(inHand ? Color.dnInk : Color.dnLine, lineWidth: 1)
        }
        .shadow(color: .black.opacity(inHand ? 0.18 : 0), radius: inHand ? 12 : 0, y: inHand ? 6 : 0)
        .offset(inHand ? offset : .zero)
        .zIndex(inHand ? 5 : 0)
        .onTapGesture { onOpen(task) }
        .gesture(dragGesture(task))
    }

    /// Picking a block up.
    ///
    /// A long press first, so that dragging a task and scrolling the day are
    /// different gestures. On the web a short threshold is enough, because a
    /// pointer does not also have to scroll the page with the same finger.
    private func dragGesture(_ task: LightKit.Task) -> some Gesture {
        LongPressGesture(minimumDuration: 0.22)
            .sequenced(before: DragGesture(coordinateSpace: .named("day")))
            .onChanged { value in
                guard case .second(true, let drag?) = value else { return }
                dragging = task.id
                offset = drag.translation
            }
            .onEnded { value in
                defer {
                    dragging = nil
                    offset = .zero
                }
                guard case .second(true, let drag?) = value else { return }
                land(task, at: drag.location)
            }
    }

    /// What the finger was over when it was let go.
    private func land(_ task: LightKit.Task, at point: CGPoint) {
        let due: Due
        if railFrame.contains(point) {
            due = Schedule.at(day: day, from: task.due)
        } else if gridFrame.contains(point) {
            // Measured against the grid itself, so it stays right however far
            // the day has been scrolled.
            let minutes = Schedule.snap(Int((point.y - gridFrame.minY) / Self.minuteHeight))
            due = Schedule.at(day: day, minutes: minutes, from: task.due)
        } else {
            return
        }

        // Nothing to say if it came back to where it started.
        guard task.due?.date != due.date || task.due?.hasTime != due.hasTime else { return }
        model.update(task, .init(due: .some(due)))
    }

    private func longDay(_ day: String) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = Calendar.current.timeZone
        guard let date = formatter.date(from: String(day.prefix(10))) else { return day }
        return date.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }
}
