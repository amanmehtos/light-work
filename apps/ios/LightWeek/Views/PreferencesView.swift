import SwiftUI
import DiurnalUI

/// Preferences — one switch, for now.
///
/// It is deliberately not a device setting: it governs whether a synced
/// project is part of the account, so a phone that had it off and a laptop
/// that had it on would disagree about what the account contains. It rides the
/// same oplog as everything else, which is why it is on this screen rather
/// than in Settings.app.
///
/// Off hides rather than deletes. A list of rewards you have earned is a
/// record of work already done; nothing else can recreate it, so a switch is
/// not allowed to throw it away.
struct PreferencesView: View {
    @ObservedObject var model: TaskListModel
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Rewards", isOn: Binding(
                        get: { model.rewardsEnabled },
                        set: { model.setRewardsEnabled($0) }))
                } footer: {
                    Text("""
                        Each task can name what finishing it earns. Completing the task files that \
                        reward in a Rewards project — a shelf of what the work bought you. Turning \
                        this off hides the field and the project; nothing already earned is \
                        deleted, and turning it back on brings the lot back.
                        """)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.dnBackground)
            .navigationTitle("Preferences")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
        .tint(Color.dnInk)
    }
}
