import SwiftUI
import DiurnalUI
import LightKit

/// Light Week: the week, as hours you can drop a task into.
///
/// The twin of `apps/web/src/components/Week.tsx`, and the same arithmetic
/// underneath (`Schedule.bucket`, `preview`, `layOut(spans:)`, held to the
/// web's cases by `WeekTests`). Each day has its all-day strip — "Waiting",
/// what is on the day at no particular time — above its hours. A task with no
/// date is not on this screen at all.
///
/// **Three days at a time, not seven.** Seven columns on a 400pt phone are
/// 50pt each, which is a sliver no title fits in and no finger can aim a
/// quarter hour at. Three are about 110pt: a title reads, and two overlapping
/// blocks side by side are still each a target. It is also what Todoist's own
/// iPhone app shows for its week in portrait. The whole week is still on
/// screen as a strip of seven days under the title — tap one, or swipe the
/// hours, to move the window along it — so the week stays the unit while the
/// grid stays legible.
///
/// All seven columns exist all the time; the window is an offset over them,
/// not a choice of which to draw. That matters for dragging: a block carried
/// to the edge pages the window along, and if its own day were taken out of
/// the hierarchy as it scrolled away, SwiftUI would cancel the gesture that
/// is carrying it.
struct WeekView: View {
    @ObservedObject var model: TaskListModel
    /// The week's first day, `YYYY-MM-DD`.
    @Binding var start: String
    let onOpen: (LightKit.Task) -> Void

    /// Points per hour. Taller than the web's 48, because a finger is wider
    /// than a pointer and a quarter hour still has to be a target.
    private static let hourHeight: CGFloat = 64
    private static var minuteHeight: CGFloat { hourHeight / 60 }
    private static let gutter: CGFloat = 40
    private static let visible = 3
    /// How near the side a carried block has to be held to page the window.
    private static let edge: CGFloat = 28

    /// The first day of the window, as an index into the week.
    @State private var first = 0
    @State private var held: Held?
    @State private var finger: CGPoint = .zero
    @State private var landing: Schedule.Landing?
    @State private var paging: DispatchWorkItem?
    @State private var columnFrames: [String: CGRect] = [:]
    @State private var stripFrames: [String: CGRect] = [:]
    @State private var hoursFrame: CGRect = .zero
    @State private var now = Date()

    private let tick = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    /// The card in hand.
    private struct Held: Equatable {
        let task: LightKit.Task
        let length: Int
        let fromStrip: Bool
        /// Where in the card the finger took hold, so the card stays under it.
        let grab: CGSize
        let size: CGSize

        static func == (a: Held, b: Held) -> Bool { a.task.id == b.task.id }
    }

    var body: some View {
        let days = Schedule.week(from: start)
        let today = Schedule.localDay(Date())
        let byDay = model.week(days)

        GeometryReader { geometry in
            let column = max(60, (geometry.size.width - Self.gutter) / CGFloat(Self.visible))

            VStack(spacing: 0) {
                header(days: days, today: today)
                dayPicker(days: days, today: today)
                strips(days: days, byDay: byDay, column: column)
                Rectangle().fill(Color.dnLineStrong).frame(height: 1)
                hours(days: days, today: today, byDay: byDay, column: column)
            }
            .coordinateSpace(name: "week")
            .overlay(alignment: .topLeading) { lifted }
        }
        .background(Color.dnBackground)
        .onReceive(tick) { now = $0 }
        .onAppear { first = window(around: today, in: days) }
        .onChange(of: start) { _, _ in first = window(around: today, in: Schedule.week(from: start)) }
        // A tick on pick-up, and one each time the landing moves to another
        // quarter hour or day: the finger covers what it is moving, so the
        // hand is told instead.
        .sensoryFeedback(.impact(weight: .medium), trigger: held?.task.id) { _, new in new != nil }
        .sensoryFeedback(.selection, trigger: landing)
    }

    // MARK: - Pieces

    private func header(days: [String], today: String) -> some View {
        HStack(spacing: 12) {
            Button { start = Schedule.shift(day: start, by: -7) } label: {
                Image(systemName: "chevron.left")
            }
            .accessibilityLabel("Previous week")

            Text(weekTitle(days))
                .font(DiurnalType.body(.headline, weight: .semibold))
                .frame(maxWidth: .infinity)

            Button { start = Schedule.shift(day: start, by: 7) } label: {
                Image(systemName: "chevron.right")
            }
            .accessibilityLabel("Next week")

            if !days.contains(today) {
                Button("This week") { start = Schedule.weekStart(of: today) }
                    .font(DiurnalType.mono(.footnote))
            }
        }
        .foregroundStyle(Color.dnInk)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    /// The whole week, always: which three days the grid is showing, and the
    /// way to any other.
    private func dayPicker(days: [String], today: String) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(days.enumerated()), id: \.element) { index, day in
                let shown = (first..<first + Self.visible).contains(index)
                Button {
                    withAnimation(.snappy) { first = clampWindow(index - 1) }
                } label: {
                    VStack(spacing: 3) {
                        Text(weekday(day, style: .narrow))
                            .font(DiurnalType.mono(.caption2))
                            .foregroundStyle(Color.dnMuted)
                        Text(dayNumber(day))
                            .font(DiurnalType.body(.subheadline, weight: day == today ? .semibold : .regular))
                            .foregroundStyle(day == today ? Color.dnBackground : Color.dnInk)
                            .frame(width: 28, height: 28)
                            // Today, by contrast alone: ink on paper turned round.
                            .background(Circle().fill(day == today ? Color.dnInk : Color.clear))
                        Rectangle()
                            .fill(shown ? Color.dnInk : Color.clear)
                            .frame(height: 2)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(longDay(day))
                .accessibilityAddTraits(shown ? .isSelected : [])
            }
        }
        .padding(.horizontal, 8)
    }

    /// Each day's Waiting, above its hours, like a calendar's all-day row.
    private func strips(days: [String], byDay: [String: Schedule.DayTasks], column: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Text("Waiting")
                .font(DiurnalType.mono(.caption2))
                .foregroundStyle(Color.dnMuted)
                // One line, smaller if it has to be: the gutter is the width
                // of "23:00", and a label broken in two reads as two words.
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(width: Self.gutter - 4, alignment: .center)
                .frame(width: Self.gutter)
                .padding(.top, 10)

            window(column: column) {
                ForEach(days, id: \.self) { day in
                    let target = landing == .strip(day: day)
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(byDay[day]?.waiting ?? []) { task in
                            chip(task, column: column)
                        }
                        if target, held != nil {
                            ghost(text: "All day").frame(height: 30)
                        }
                    }
                    .padding(4)
                    .frame(width: column, alignment: .topLeading)
                    .frame(minHeight: 40, alignment: .topLeading)
                    .background(target ? Color.dnSunken : Color.clear)
                    .overlay(alignment: .trailing) { Rectangle().fill(Color.dnLine).frame(width: 1) }
                    .measure { stripFrames[day] = $0 }
                }
            }
        }
        // Over the hours while a strip card is carried down into them.
        .zIndex(held?.fromStrip == true ? 2 : 0)
    }

    private func hours(
        days: [String], today: String, byDay: [String: Schedule.DayTasks], column: CGFloat
    ) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                HStack(alignment: .top, spacing: 0) {
                    // Hour labels in their own column, so a block can never sit on one.
                    VStack(spacing: 0) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(hour == 0 ? "" : Schedule.clock(hour * 60))
                                .font(DiurnalType.mono(.caption2))
                                .foregroundStyle(Color.dnMuted)
                                .frame(width: Self.gutter - 6, height: Self.hourHeight, alignment: .topTrailing)
                                // Lifted half a line, so the label reads as marking
                                // the line rather than sitting in the hour below it.
                                .offset(y: -6)
                                .id(hour)
                        }
                    }
                    .frame(width: Self.gutter, alignment: .leading)

                    window(column: column) {
                        ForEach(days, id: \.self) { day in
                            dayColumn(day, today: today, timed: byDay[day]?.timed ?? [], column: column)
                        }
                    }
                }
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollDisabled(held != nil)
            .measure { hoursFrame = $0 }
            .onAppear { proxy.scrollTo(7, anchor: .top) }
            // A swipe across the hours moves the window a day at a time.
            // Alongside the scroll rather than instead of it, and ignored while
            // a block is in hand, whose own drag is the only thing that counts.
            .simultaneousGesture(
                DragGesture(minimumDistance: 24).onEnded { value in
                    guard held == nil,
                          abs(value.translation.width) > 60,
                          abs(value.translation.width) > abs(value.translation.height) * 2
                    else { return }
                    withAnimation(.snappy) {
                        first = clampWindow(first + (value.translation.width < 0 ? 1 : -1))
                    }
                }
            )
        }
    }

    /// The three visible days of a row of seven: all of them laid out, slid
    /// along by the window, and clipped to it.
    private func window<Content: View>(column: CGFloat, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 0) { content() }
            .offset(x: -CGFloat(first) * column)
            .frame(width: column * CGFloat(Self.visible), alignment: .leading)
            .clipped()
    }

    private func dayColumn(_ day: String, today: String, timed: [LightKit.Task], column: CGFloat) -> some View {
        let spans = timed.map { Schedule.span(of: $0) }
        let moving = held.map { (id: $0.task.id, length: $0.length) }
        let live = Schedule.layOut(spans: Schedule.preview(spans, day: day, moving: moving, landing: landing))
        let resting = Schedule.layOut(spans: spans)

        return ZStack(alignment: .topLeading) {
            ForEach(0..<24, id: \.self) { hour in
                Rectangle()
                    .fill(Color.dnLine)
                    .frame(height: 1)
                    .offset(y: CGFloat(hour) * Self.hourHeight)
            }

            if day == today { nowLine }

            if case .slot(day, let minutes) = landing, let held, let place = live[held.task.id] {
                let width = column / CGFloat(place.columns)
                ghost(text: "\(Schedule.clock(minutes)) – \(Schedule.clock(minutes + held.length))")
                    .frame(width: max(0, width - 2), height: blockHeight(held.length))
                    .offset(x: CGFloat(place.column) * width, y: CGFloat(minutes) * Self.minuteHeight)
            }

            ForEach(timed) { task in
                let inHand = held?.task.id == task.id
                let place = (inHand ? resting : live)[task.id] ?? (column: 0, columns: 1)
                block(task, place: place, column: column)
            }
        }
        .frame(width: column, height: Self.hourHeight * 24, alignment: .topLeading)
        .background(day == today ? Color.dnSunken.opacity(0.6) : Color.clear)
        .overlay(alignment: .trailing) { Rectangle().fill(Color.dnLine).frame(width: 1) }
        .measure { columnFrames[day] = $0 }
        // The blocks make room for the landing as it moves, rather than
        // jumping, so the eye can follow where each one went.
        .animation(.snappy(duration: 0.18), value: landing)
    }

    /// Now. The one thing on this screen that moves by itself.
    private var nowLine: some View {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: now)
        let minutes = CGFloat((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
        return ZStack(alignment: .leading) {
            Rectangle().fill(Color.dnInk).frame(height: 2)
            Circle().fill(Color.dnInk).frame(width: 8, height: 8).offset(x: -4)
        }
        .offset(y: minutes * Self.minuteHeight - 1)
        .accessibilityHidden(true)
    }

    private func block(
        _ task: LightKit.Task, place: (column: Int, columns: Int), column: CGFloat
    ) -> some View {
        let start = Schedule.minutes(of: task.due) ?? 0
        let length = Schedule.blockMinutes(task.duration)
        let width = column / CGFloat(place.columns)
        let size = CGSize(width: max(0, width - 2), height: blockHeight(length))
        let origin = CGPoint(x: CGFloat(place.column) * width, y: CGFloat(start) * Self.minuteHeight)

        return card(task, time: "\(Schedule.clock(start)) – \(Schedule.clock(start + length))",
                    compact: size.width < 60)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .modifier(Carried(isHeld: held?.task.id == task.id, isPlaced: landing != nil))
            .offset(x: origin.x, y: origin.y)
            .onTapGesture { onOpen(task) }
            .gesture(carry(task, length: length, size: size, fromStrip: false) { location in
                // Where in the block the finger is, from the column it sits in.
                let frame = columnFrames[Schedule.day(of: task.due) ?? ""] ?? .zero
                return CGSize(width: location.x - frame.minX - origin.x,
                              height: location.y - frame.minY - origin.y)
            })
    }

    private func chip(_ task: LightKit.Task, column: CGFloat) -> some View {
        let size = CGSize(width: column - 8, height: 30)
        return card(task, time: nil)
            .frame(width: size.width, height: size.height, alignment: .leading)
            .modifier(Carried(isHeld: held?.task.id == task.id, isPlaced: landing != nil))
            .onTapGesture { onOpen(task) }
            .gesture(carry(task, length: Schedule.blockMinutes(task.duration), size: size, fromStrip: true) { _ in
                // A chip has no time to keep hold of; it is carried by its middle.
                CGSize(width: size.width / 2, height: size.height / 2)
            })
    }

    /// A card, in a strip or in the hours.
    ///
    /// No checkbox, unlike the lists: a third of a phone has room for a
    /// 28pt box or for a title, and the title is what says which task it is.
    /// A tap opens the task, and it is completed from there.
    ///
    /// `compact` is a block sharing its day three ways: about 35pt, where a
    /// word in the usual size does not fit and would break between letters.
    private func card(_ task: LightKit.Task, time: String?, compact: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(task.content)
                .font(DiurnalType.body(compact ? .caption2 : .caption, weight: .medium))
                .foregroundStyle(Color.dnInk)
                .lineLimit(time == nil ? 1 : 3)
            if let time, !compact {
                Text(time)
                    .font(DiurnalType.mono(.caption2))
                    .foregroundStyle(Color.dnMuted)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, compact ? 3 : 6)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.dnRaised, in: RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall))
        .overlay {
            RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall)
                .stroke(Color.dnLine, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall))
        .contentShape(RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall))
        .accessibilityElement(children: .combine)
        .accessibilityHint("Double-tap to open. Touch and hold to move.")
    }

    /// The landing: where the card in hand goes if it is let go now. Flat and
    /// outlined in ink — a place, not a second task.
    private func ghost(text: String) -> some View {
        Text(text)
            .font(DiurnalType.mono(.caption2, weight: .medium))
            .foregroundStyle(Color.dnInk)
            .lineLimit(2)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.dnRaised.opacity(0.7), in: RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall))
            .overlay {
                RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall)
                    .strokeBorder(Color.dnInk, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// The card in hand, drawn over everything at the finger.
    ///
    /// A copy, in an overlay on the whole screen, rather than the card itself
    /// moved: the card lives inside the scrolling hours or the strip row, both
    /// of which clip, and a block carried up to a strip would vanish at the
    /// edge of the one it came from.
    @ViewBuilder
    private var lifted: some View {
        if let held {
            card(held.task, time: held.fromStrip ? nil : liftedTime(held))
                .frame(width: held.size.width, height: held.size.height, alignment: .topLeading)
                .overlay {
                    RoundedRectangle(cornerRadius: DiurnalTokens.radiusSmall)
                        .stroke(Color.dnInk, lineWidth: 1)
                }
                .shadow(color: .black.opacity(0.22), radius: 14, y: 8)
                .scaleEffect(1.03)
                .offset(x: finger.x - held.grab.width, y: finger.y - held.grab.height)
                .allowsHitTesting(false)
        }
    }

    private func liftedTime(_ held: Held) -> String {
        if case .slot(_, let minutes) = landing {
            return "\(Schedule.clock(minutes)) – \(Schedule.clock(minutes + held.length))"
        }
        return landing == nil ? "" : "All day"
    }

    // MARK: - Carrying

    /// Picking a card up, carrying it, and putting it down.
    ///
    /// A long press first, so that moving a task and scrolling the hours are
    /// different gestures. On the web a short threshold is enough, because a
    /// pointer does not also have to scroll the page with the same finger.
    private func carry(
        _ task: LightKit.Task, length: Int, size: CGSize, fromStrip: Bool,
        grab: @escaping (CGPoint) -> CGSize
    ) -> some Gesture {
        LongPressGesture(minimumDuration: 0.3)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("week")))
            .onChanged { value in
                guard case .second(true, let drag?) = value else { return }
                if held == nil {
                    held = Held(task: task, length: length, fromStrip: fromStrip,
                                grab: grab(drag.startLocation), size: size)
                }
                finger = drag.location
                landing = landing(at: drag.location)
                pageIfAtEdge(drag.location)
            }
            .onEnded { value in
                defer { letGo() }
                guard case .second(true, _?) = value, let landing else { return }
                land(task, at: landing)
            }
    }

    /// What the finger is over: a day's strip, a time on a day, or nowhere.
    private func landing(at point: CGPoint) -> Schedule.Landing? {
        guard let held else { return nil }
        let visible = Schedule.week(from: start).dropFirst(first).prefix(Self.visible)
        for day in visible where stripFrames[day]?.contains(point) == true {
            return .strip(day: day)
        }
        // Only where the hours are on screen: a column runs the whole day,
        // most of it scrolled out of sight behind the header.
        guard hoursFrame.contains(point) else { return nil }
        for day in visible {
            guard let frame = columnFrames[day], frame.minX <= point.x, point.x < frame.maxX else { continue }
            // Measured against the column itself, so it stays right however
            // far the hours have been scrolled.
            let pointer = Double((point.y - frame.minY) / Self.minuteHeight)
            let grab = held.fromStrip ? 0 : Double(held.grab.height / Self.minuteHeight)
            return .slot(day: day, minutes: Schedule.slot(at: pointer, grab: grab, length: held.length))
        }
        return nil
    }

    /// Held at a side of the hours, the window moves a day that way, and
    /// keeps moving while the finger stays there.
    private func pageIfAtEdge(_ point: CGPoint) {
        let left = point.x < hoursFrame.minX + Self.gutter + Self.edge && first > 0
        let right = point.x > hoursFrame.maxX - Self.edge && first < 7 - Self.visible
        guard left || right else {
            paging?.cancel()
            paging = nil
            return
        }
        guard paging == nil else { return }
        let work = DispatchWorkItem {
            paging = nil
            withAnimation(.snappy) { first = clampWindow(first + (right ? 1 : -1)) }
            // The day under a finger that has not moved is a different day now.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                if held != nil {
                    landing = landing(at: finger)
                    pageIfAtEdge(finger)
                }
            }
        }
        paging = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    private func letGo() {
        paging?.cancel()
        paging = nil
        held = nil
        landing = nil
    }

    private func land(_ task: LightKit.Task, at landing: Schedule.Landing) {
        // A date and no time in a strip; a date and a time in the hours.
        let due: Due
        switch landing {
        case .strip(let day): due = Schedule.at(day: day, from: task.due)
        case .slot(let day, let minutes): due = Schedule.at(day: day, minutes: minutes, from: task.due)
        }
        // Nothing to say if it came back to where it started.
        guard task.due?.date != due.date || task.due?.hasTime != due.hasTime else { return }
        model.update(task, .init(due: .some(due)))
    }

    // MARK: - Helpers

    private func blockHeight(_ length: Int) -> CGFloat {
        max(CGFloat(Schedule.snapMinutes), CGFloat(length)) * Self.minuteHeight
    }

    private func clampWindow(_ index: Int) -> Int { min(max(index, 0), 7 - Self.visible) }

    /// The window that has today in its middle, or the start of the week.
    private func window(around today: String, in days: [String]) -> Int {
        guard let index = days.firstIndex(of: today) else { return 0 }
        return clampWindow(index - 1)
    }

    private func date(_ day: String) -> Date? {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = Calendar.current.timeZone
        return formatter.date(from: String(day.prefix(10)))
    }

    private func weekday(_ day: String, style: Date.FormatStyle.Symbol.Weekday) -> String {
        date(day)?.formatted(.dateTime.weekday(style)) ?? ""
    }

    private func dayNumber(_ day: String) -> String {
        date(day)?.formatted(.dateTime.day()) ?? ""
    }

    private func longDay(_ day: String) -> String {
        date(day)?.formatted(.dateTime.weekday(.wide).day().month(.wide)) ?? day
    }

    private func weekTitle(_ days: [String]) -> String {
        guard let from = days.first.flatMap(date), let to = days.last.flatMap(date) else { return "" }
        return (from..<to).formatted(.interval.day().month(.abbreviated).year())
    }
}

/// How a card looks while it is the one in hand: a faint outline where it was
/// picked up from until it has somewhere else to go, then nothing — the copy
/// at the finger and the landing say the rest.
private struct Carried: ViewModifier {
    let isHeld: Bool
    let isPlaced: Bool

    func body(content: Content) -> some View {
        content.opacity(isHeld ? (isPlaced ? 0 : 0.35) : 1)
    }
}

private extension View {
    /// Reports this view's frame in the week's coordinate space, now and
    /// whenever it moves (which, in the hours, is every scroll).
    func measure(_ report: @escaping (CGRect) -> Void) -> some View {
        background {
            GeometryReader { geometry in
                Color.clear
                    .onAppear { report(geometry.frame(in: .named("week"))) }
                    .onChange(of: geometry.frame(in: .named("week"))) { _, frame in report(frame) }
            }
        }
    }
}
