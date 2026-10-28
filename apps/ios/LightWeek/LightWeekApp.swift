import SwiftUI

@main
struct LightWeekApp: App {
    /// Owned here rather than by a view, so the grant read from the Keychain at
    /// launch is read once and the sign-in sheet is not torn down by a redraw.
    @StateObject private var auth = LightWeekAuth()

    var body: some Scene {
        WindowGroup {
            // Signing in is the whole of the gate: there is nothing useful to
            // show without a grant, and a task list that worked offline would
            // need the local replica this app does not have yet.
            // Switched on `state` rather than on `isSignedIn`, which is a
            // plain computed property: it would still be re-read on a redraw,
            // but only by the accident of the grant also republishing `state`.
            switch auth.state {
            case .signedIn:
                TaskListView(auth: auth)
            case .signedOut, .signingIn:
                SignInView(auth: auth)
            }
        }
    }
}
