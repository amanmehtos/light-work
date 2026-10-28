import SwiftUI
import DiurnalUI

/// A small piece of metadata on a task row.
///
/// Diurnal is monochrome — ink, paper and greys, nothing else — so a badge
/// carries its emphasis in weight rather than in hue: solid reads loudest,
/// then outlined, then plain. The web row's priority badges work exactly this
/// way, and an earlier version of that file used red, amber and blue, which is
/// precisely what the library exists not to do.
struct Badge: View {
    enum Weight {
        case solid
        case outline
        case plain
    }

    let text: String
    var weight: Weight = .plain

    var body: some View {
        Text(text)
            .font(DiurnalType.mono(.caption))
            .monospacedDigit()
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(foreground)
            .background(background)
            .overlay(border)
            .clipShape(Capsule())
    }

    private var foreground: some ShapeStyle {
        switch weight {
        // Paper on ink: the one inversion in the system, and what makes an
        // urgent task the loudest thing in a grey list.
        case .solid: return AnyShapeStyle(Color.dnBackground)
        case .outline: return AnyShapeStyle(Color.dnInk)
        case .plain: return AnyShapeStyle(Color.dnMuted)
        }
    }

    private var background: some View {
        Capsule().fill(
            weight == .solid
                ? AnyShapeStyle(Color.dnInk)
                : AnyShapeStyle(Color.dnSunken.opacity(weight == .outline ? 0 : 1)))
    }

    @ViewBuilder
    private var border: some View {
        if weight == .outline {
            Capsule().strokeBorder(Color.dnLineStrong, lineWidth: 1)
        }
    }
}

/// Badges laid out left to right, wrapping onto a new line when they run out
/// of width.
///
/// A single scrolling line was simpler and wrong: the focus badge is last, so
/// it was the one that fell off the edge — and it is the only badge on the row
/// that this app exists to show. SwiftUI has no flow layout of its own, and the
/// `Layout` protocol is the smaller price.
struct BadgeFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, within: proposal.width ?? .infinity).size
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) {
        for (subview, offset) in zip(subviews, arrange(subviews, within: bounds.width).offsets) {
            subview.place(
                at: CGPoint(x: bounds.minX + offset.x, y: bounds.minY + offset.y),
                proposal: .unspecified)
        }
    }

    private func arrange(
        _ subviews: Subviews, within width: CGFloat
    ) -> (size: CGSize, offsets: [CGPoint]) {
        var offsets: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            // `x > 0` so a badge wider than the row still gets a line of its
            // own rather than being wrapped onto an empty one it also overflows.
            if x > 0 && x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            offsets.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            widest = max(widest, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return (CGSize(width: widest, height: y + lineHeight), offsets)
    }
}
