import SwiftUI
import DiurnalUI

/// A line to add a task from, pinned above the list.
///
/// Plain on purpose. The web's add-task line reads dates and shorthand out of
/// what you type; this does not, because the rules for reading a date are one
/// implementation in TypeScript and a second one here would be a second place
/// for them to drift. What it offers instead is the thing that makes capture
/// cheap — a field that is already there — and the editor, one tap on the new
/// row, for everything else.
///
/// It says where the task will go, because "the inbox" is not a thing you can
/// assume on a phone that has never been asked.
struct ComposeBar: View {
    /// Where a new task lands, or nil when there is nowhere to put one yet.
    let destination: String?
    let onAdd: (String) -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canAdd: Bool { destination != nil && !trimmed.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                TextField(destination == nil ? "No project to add to yet" : "Add a task", text: $text)
                    .font(DiurnalType.body())
                    .foregroundStyle(Color.dnInk)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(add)
                    .disabled(destination == nil)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color.dnSunken, in: RoundedRectangle(cornerRadius: DiurnalTokens.radius))
                    .overlay {
                        RoundedRectangle(cornerRadius: DiurnalTokens.radius)
                            .stroke(focused ? Color.dnInk : Color.dnLine, lineWidth: 1)
                    }

                Button(action: add) {
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 40, height: 40)
                        .foregroundStyle(canAdd ? Color.dnBackground : Color.dnMuted)
                        .background(canAdd ? Color.dnInk : Color.dnSunken, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canAdd)
                .accessibilityLabel("Add task")
            }

            // The one place this bar can say why it is idle.
            if destination == nil {
                Text("Open Light Week on the web once to set up your inbox.")
                    .font(DiurnalType.body(.footnote))
                    .foregroundStyle(Color.dnMuted)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func add() {
        guard canAdd else { return }
        onAdd(trimmed)
        text = ""
        // Kept: adding several in a row is the common case, and dismissing the
        // keyboard after each one would make capture slower, not faster.
        focused = true
    }
}
