import SwiftUI
import DiurnalUI
import LightKit

/// A place the phone can go.
///
/// These are the web sidebar's own entries, in the same order and under the same
/// names: Inbox, Today, Upcoming, Day, Done (the web calls it Completed), and a
/// project. Labels and Search are not here this phase; neither has a phone
/// screen yet.
enum Destination: Hashable {
    case inbox
    case today
    case upcoming
    case day
    case done
    case project(String)
}

/// The list of places, which is the root of the app's navigation.
///
/// It replaces the three-way picker (List / Day / Done) and the project filter
/// in the toolbar that stood in for it. A picker has room for three things and a
/// project tree has as many as the account has projects; a list is what makes
/// room for both, and it is where each place can say how many tasks are in it.
///
/// The counts are the web's sidebar counts for the same account — each is the
/// length of the rows its screen renders (see `TaskListModel.Counts`), not a
/// second pass over the tasks.
struct HomeView: View {
    @ObservedObject var model: TaskListModel
    let onPreferences: () -> Void
    let onSignOut: () -> Void
    let email: String?

    @State private var addingProject = false

    var body: some View {
        let counts = model.counts
        List {
            SwiftUI.Section {
                if model.inbox != nil {
                    place("Inbox", systemImage: "tray", count: counts.inbox, to: .inbox)
                }
                place("Today", systemImage: "sun.max", count: counts.today, to: .today)
                place("Upcoming", systemImage: "calendar", count: counts.upcoming, to: .upcoming)
                // Counts what Today does: it is the same tasks, laid out against
                // the hours they are meant to happen in.
                place("Day", systemImage: "clock", count: counts.today, to: .day)
                place("Done", systemImage: "checkmark.circle", count: counts.done, to: .done)
            }
            .listRowBackground(Color.clear)

            SwiftUI.Section {
                let tree = model.projectTree
                if tree.isEmpty {
                    Text("No projects yet.")
                        .font(DiurnalType.body(.footnote))
                        .foregroundStyle(Color.dnMuted)
                        .listRowBackground(Color.clear)
                }
                ForEach(tree) { entry in
                    place(entry.project.name, systemImage: nil, count: model.openCount(in: entry.project),
                          to: .project(entry.project.id), depth: entry.depth)
                }
            } header: {
                // The web's sidebar has the same eyebrow over the same tree,
                // and the same "+" beside it. A control on the heading of the
                // list it adds to, not a row of the list: the places above are
                // meant to stay the web's eight.
                HStack {
                    Text("Projects")
                        .font(DiurnalType.mono(.caption))
                        .foregroundStyle(Color.dnMuted)
                    Spacer(minLength: 0)
                    Button { addingProject = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.dnInk)
                            // A finger's width, not the glyph's.
                            .frame(width: 44, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Add project")
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await model.load() }
        .sheet(isPresented: $addingProject) {
            NewProjectView(model: model) { addingProject = false }
        }
        .navigationTitle("Light Week")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Preferences", action: onPreferences)
                    if let email {
                        SwiftUI.Section(email) { signOutButton }
                    } else {
                        signOutButton
                    }
                } label: {
                    Image(systemName: "person.crop.circle")
                        .foregroundStyle(Color.dnInk)
                }
            }
        }
    }

    private var signOutButton: some View {
        // No `.destructive` role: the system paints that red, and signing out
        // here only forgets the tokens — the grant itself is revoked from the
        // account, so there is nothing destructive to warn about either.
        Button("Sign out", action: onSignOut)
    }

    private func place(
        _ title: String, systemImage: String?, count: Int, to destination: Destination, depth: Int = 0
    ) -> some View {
        NavigationLink(value: destination) {
            HStack(spacing: 12) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .frame(width: 22)
                        .foregroundStyle(Color.dnInk2)
                }
                Text(title)
                    .font(DiurnalType.body())
                    .foregroundStyle(Color.dnInk)
                Spacer(minLength: 0)
                // Quiet at zero, as the web's nav is.
                if count > 0 { Badge(text: "\(count)") }
            }
            // A project's depth is how far in it is drawn, as on the web.
            .padding(.leading, CGFloat(depth) * 16)
        }
        .listRowSeparatorTint(Color.dnLine)
        .listRowBackground(Color.clear)
        .accessibilityLabel(count > 0 ? "\(title), \(count) tasks" : title)
    }
}
