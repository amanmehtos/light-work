import SwiftUI
import DiurnalUI

/// The checkbox, at the front of a task.
///
/// Large on purpose. Finishing something is the most common act in this app,
/// and it is also how you put a task back — a completed task keeps its box,
/// filled, so tapping it again is the obvious way to reopen rather than
/// something to go looking for.
///
/// Built rather than borrowed: SwiftUI's `Toggle` is a switch on iOS, and
/// `.toggleStyle(.button)` is a tinted capsule. This is Diurnal's `.dn-check`,
/// which is a rounded square that fills with ink and shows a paper tick.
struct Checkbox: View {
    let isOn: Bool
    /// Named so the action reads right either way round.
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(isOn ? Color.dnInk : Color.dnRaised)
                .overlay {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .stroke(isOn ? Color.dnInk : Color.dnLineStrong, lineWidth: 1)
                }
                .overlay {
                    if isOn {
                        Image(systemName: "checkmark")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.dnBackground)
                    }
                }
                .frame(width: 28, height: 28)
        }
        // Plain, so the whole row does not light up when the box is tapped —
        // and so a box inside a list row stays its own target.
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityLabel(isOn ? "Reopen \(label)" : "Complete \(label)")
        .accessibilityAddTraits(isOn ? [.isSelected] : [])
    }
}
