import Foundation

/// Where Light Week lives and how this app is known to it.
///
/// The client is built into the server rather than registered at runtime, which
/// is the only reason its consent screen can name "Light Week for iOS" and be
/// believed — anything registered through RFC 7591 names *itself*.
enum LightWeek {
    static let clientID = "com.lightweek.ios"
    static let urlScheme = "com.lightweek.app"

    /// RFC 8252's single-slash form. The server compares this byte for byte, so
    /// the more natural-looking `com.lightweek.app://oauth` is a different
    /// string and is refused.
    static let redirectURI = "com.lightweek.app:/oauth"

    /// Read the tasks, and write the odd change back. No `mcp:*`: scope, not
    /// audience, is what separates the two surfaces of this server, so asking
    /// for more than `/sync` needs would widen the grant for nothing.
    static let scope = "tasks:read tasks:write"

    private static let deployed = URL(string: "https://light-week.amanmehtos.workers.dev")!

    /// The server this build talks to.
    ///
    /// Overridable in a debug build only, and only from a launch argument, so
    /// the flow can be driven end to end against a server running on the
    /// machine — the deployed one cannot be, because signing in there means
    /// signing in as the owner. A release build has no such door: the origin is
    /// also the token's audience, and a redirectable origin would be a way to
    /// have the app ask a server of someone else's choosing for a grant.
    static let origin: URL = {
        #if DEBUG
        if let override = UserDefaults.standard.string(forKey: "LightWeekOrigin"),
           let url = URL(string: override), url.scheme != nil {
            return url
        }
        #endif
        return deployed
    }()
}
