import SwiftUI
import DiurnalUI
import LightKit

/// Making a project, from the plus beside "Projects" on the home list.
///
/// A name and a place to file it. The place is a picker over the same tree the
/// home list draws — `Navigation.parentChoices`, the twin of the web's
/// `parentChoices` — indented by depth, with "Top level" first, so a project
/// three levels down is as easy to file under as one at the root. It starts at
/// the top level: filing under whichever project was last looked at would nest
/// things by accident.
///
/// A form with one Add rather than a live edit, like the task editor: Cancel
/// has to mean something, and a project made on every keystroke would be a
/// project per letter. It closes on Add; the new project is in the list behind
/// it, and a failed write is the alert the rest of the app already raises.
struct NewProjectView: View {
    @ObservedObject var model: TaskListModel
    let onClose: () -> Void

    @State private var name = ""
    /// nil is the top level.
    @State private var parentId: String?
    @FocusState private var focused: Bool

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section {
                    TextField("Project name", text: $name)
                        .font(DiurnalType.body())
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(add)
                }

                SwiftUI.Section {
                    Picker("Inside", selection: $parentId) {
                        Text("Top level").tag(String?.none)
                        ForEach(model.parentChoices) { entry in
                            // Indented with figure spaces, which a picker row
                            // keeps where it would collapse ordinary ones.
                            Text(String(repeating: "\u{2007}\u{2007}", count: entry.depth) + entry.project.name)
                                .tag(Optional(entry.project.id))
                        }
                    }
                } footer: {
                    Text("Projects can go inside projects, as deep as you like.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.dnBackground)
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onClose)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", action: add).disabled(trimmed.isEmpty)
                }
            }
            .onAppear { focused = true }
        }
        .tint(Color.dnInk)
    }

    private func add() {
        guard !trimmed.isEmpty else { return }
        model.createProject(name: trimmed, parentId: parentId)
        onClose()
    }
}
