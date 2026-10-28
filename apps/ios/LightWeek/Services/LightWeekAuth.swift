import Foundation
import UIKit
import AuthenticationServices
import CryptoKit
import LightKit

enum LightWeekAuthError: Error, LocalizedError {
    case cancelled
    /// The redirect came back with a `state` we did not send — either a stale
    /// session or someone else's authorization request landing here.
    case stateMismatch
    case issuerMismatch(String?)
    case denied(String)
    case notSignedIn
    /// The grant is gone — revoked from the account, or expired past refresh.
    /// Nothing the app can retry; it has to ask again.
    case grantLost

    var errorDescription: String? {
        switch self {
        case .cancelled:               return nil
        case .stateMismatch:           return "That sign-in did not match the one this app started."
        case .issuerMismatch(let iss): return "The sign-in came back from \(iss ?? "nowhere") instead of Light Week."
        case .denied(let reason):      return "Light Week declined: \(reason)"
        case .notSignedIn:             return "Not signed in to Light Week."
        case .grantLost:               return "Light Week no longer accepts this sign-in. Sign in again."
        }
    }
}

/// The OAuth grant this app holds on a Light Week account.
///
/// Ported from Light Minute's, which was driven against both the deployed
/// worker and the real request handler before this existed. The client id, the
/// scheme and the redirect differ; the flow does not, and deliberately so — two
/// implementations of one handshake is two sets of checks to get wrong.
///
/// A free Personal Team cannot enable App Groups, so this grant is this app's
/// alone: Light Minute signs in separately, and there is no shared Keychain
/// item to look for.
@MainActor
final class LightWeekAuth: ObservableObject {

    enum State: Equatable {
        case signedOut
        case signingIn
        /// The email is read from `/account/me` after the exchange and kept
        /// with the tokens, so a screen can say whose account this is without a
        /// round trip — including offline.
        case signedIn(email: String?)
    }

    @Published private(set) var state: State
    @Published private(set) var lastError: String?

    private let store = GrantStore()
    private var grant: Grant? { didSet { publish() } }

    /// Refreshes coalesce: two screens appearing at the same moment would
    /// otherwise each spend the single-use refresh token, and the loser would
    /// be holding one the server has already rotated away.
    private var refreshInFlight: _Concurrency.Task<Grant, Error>?

    /// `ASWebAuthenticationSession` has to outlive the call that starts it.
    private var webSession: ASWebAuthenticationSession?
    private let anchor = PresentationAnchor()

    init() {
        let stored = try? store.load()
        grant = stored
        state = stored.map { .signedIn(email: $0.email) } ?? .signedOut
    }

    var isSignedIn: Bool { grant != nil }

    // MARK: – Signing in

    func signIn() async {
        guard state != .signingIn else { return }
        state = .signingIn
        lastError = nil
        do {
            grant = try await authorize()
        } catch LightWeekAuthError.cancelled {
            // Backing out of the sheet is an answer, not a failure.
            publish()
        } catch {
            publish()
            lastError = error.localizedDescription
        }
    }

    func signOut() {
        // Only the user can revoke the grant itself — `POST /account/logout` is
        // closed to apps, and would revoke a session rather than this grant
        // anyway. Forgetting the tokens is the whole of what this app can do,
        // and the rest is done from the account that issued them.
        try? store.clear()
        refreshInFlight?.cancel()
        refreshInFlight = nil
        grant = nil
        lastError = nil
    }

    /// An access token good right now, refreshing first if the stored one is
    /// spent. Throws rather than prompting: a refresh happening behind a list
    /// that is reloading must never put a web sheet in front of someone.
    func accessToken() async throws -> String {
        guard let grant else { throw LightWeekAuthError.notSignedIn }
        // A minute of slack, so a token does not expire in flight.
        if grant.expiresAt.timeIntervalSinceNow > 60 { return grant.accessToken }
        return try await refresh(grant).accessToken
    }

    // MARK: – The authorization code flow

    private func authorize() async throws -> Grant {
        let verifier = Self.randomURLSafe(bytes: 32)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
        let state = Self.randomURLSafe(bytes: 16)

        var components = URLComponents(
            url: LightWeek.origin.appendingPathComponent("oauth/authorize"),
            resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: LightWeek.clientID),
            .init(name: "redirect_uri", value: LightWeek.redirectURI),
            .init(name: "scope", value: LightWeek.scope),
            .init(name: "state", value: state),
            .init(name: "code_challenge", value: challenge),
            // S256 only. OAuth 2.1 drops `plain`, and accepting it would let
            // anyone who saw the request replay it.
            .init(name: "code_challenge_method", value: "S256"),
            // RFC 8707. Binds the token to this server as its audience, so a
            // token minted here cannot be presented anywhere else.
            .init(name: "resource", value: LightWeek.origin.absoluteString),
        ]

        let callback = try await present(components.url!)
        let returned = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems ?? []
        func value(_ name: String) -> String? {
            returned.first { $0.name == name }?.value
        }

        if let error = value("error") {
            throw error == "access_denied"
                ? LightWeekAuthError.cancelled
                : LightWeekAuthError.denied(value("error_description") ?? error)
        }
        guard value("state") == state else { throw LightWeekAuthError.stateMismatch }
        // The server advertises `authorization_response_iss_parameter_supported`,
        // so a client that is told which issuer answered and does not check it
        // is failing a check it asked for.
        guard value("iss") == LightWeek.origin.absoluteString else {
            throw LightWeekAuthError.issuerMismatch(value("iss"))
        }
        guard let code = value("code") else { throw LightWeekAuthError.denied("no code") }

        var fresh = try await token([
            "grant_type": "authorization_code",
            "code": code,
            "client_id": LightWeek.clientID,
            // Sent again at the token endpoint, and again compared exactly.
            "redirect_uri": LightWeek.redirectURI,
            // No client secret: a public client has nowhere to keep one, and
            // PKCE is what binds the code to this request instead.
            "code_verifier": verifier,
        ])
        // Who this is, asked once. A failure here costs the name on screen and
        // nothing else, so it must not cost the grant.
        let client = LightWeekClient(baseURL: LightWeek.origin, token: fresh.accessToken)
        fresh.email = try? await client.accountEmail()
        try store.save(fresh)
        return fresh
    }

    private func present(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url, callbackURLScheme: LightWeek.urlScheme
            ) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError,
                          error.code == .canceledLogin {
                    continuation.resume(throwing: LightWeekAuthError.cancelled)
                } else {
                    continuation.resume(
                        throwing: error ?? LightWeekAuthError.denied("no callback"))
                }
            }
            session.presentationContextProvider = anchor
            // Not ephemeral: reusing the browser's own Google session is the
            // difference between one tap and typing a password on a phone.
            session.prefersEphemeralWebBrowserSession = false
            webSession = session
            session.start()
        }
    }

    // MARK: – Refresh

    private func refresh(_ expired: Grant) async throws -> Grant {
        if let refreshInFlight { return try await refreshInFlight.value }

        let task = _Concurrency.Task<Grant, Error> {
            var fresh = try await self.token([
                "grant_type": "refresh_token",
                "refresh_token": expired.refreshToken,
                "client_id": LightWeek.clientID,
            ])
            // Refresh tokens rotate. Keeping the old one would mean presenting
            // a token the server has already retired, so the new one has to be
            // stored even though nothing in this response looks like a change.
            if fresh.refreshToken.isEmpty { fresh.refreshToken = expired.refreshToken }
            fresh.email = expired.email
            try self.store.save(fresh)
            return fresh
        }
        refreshInFlight = task

        do {
            let fresh = try await task.value
            refreshInFlight = nil
            grant = fresh
            return fresh
        } catch {
            refreshInFlight = nil
            if let failure = error as? LightWeekClient.Failure,
               case .http(let status, _) = failure, status == 400 {
                // `invalid_grant`: revoked from the account, or sat unused past
                // the refresh token's life. Retrying cannot fix it.
                signOut()
                throw LightWeekAuthError.grantLost
            }
            throw error
        }
    }

    private func token(_ fields: [String: String]) async throws -> Grant {
        struct Response: Decodable {
            let access_token: String
            let refresh_token: String?
            let expires_in: Int?
            let scope: String?
        }

        var request = URLRequest(url: LightWeek.origin.appendingPathComponent("oauth/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(Self.formEncoded(fields).utf8)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw LightWeekClient.Failure.transport(error)
        }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            // Carried as LightKit's failure so `refresh` can read the status: a
            // `400` here is `invalid_grant` and means the grant is gone, which
            // is the one token error the app answers differently.
            throw LightWeekClient.Failure.http(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? "")
        }

        let decoded = try JSONDecoder().decode(Response.self, from: data)
        return Grant(
            accessToken: decoded.access_token,
            refreshToken: decoded.refresh_token ?? "",
            expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expires_in ?? 3600)),
            scope: decoded.scope ?? LightWeek.scope,
            email: nil)
    }

    private static func formEncoded(_ fields: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return fields
            .map { key, value in
                let encode = { (s: String) in
                    s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
                }
                return "\(encode(key))=\(encode(value))"
            }
            .joined(separator: "&")
    }

    private func publish() {
        state = grant.map { .signedIn(email: $0.email) } ?? .signedOut
    }

    private static func randomURLSafe(bytes count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        // The verifier and the state are both only as good as their randomness,
        // so they come from the system CSPRNG rather than `Int.random`.
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes).base64URLEncoded
    }
}

// MARK: – The stored grant

/// The tokens, as they sit in the Keychain.
struct Grant: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var scope: String
    var email: String?
}

/// One Keychain item holding the whole grant.
///
/// `UserDefaults` is a plist in the container, so a refresh token there is the
/// account in the clear to anything that can read the file — a backup included.
/// It is one item rather than three so the access token, its replacement and
/// their expiry can never be left written half-way.
private struct GrantStore {
    private let service = "com.lightweek.app.lightweek"
    private let account = "grant"

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func load() throws -> Grant? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return try JSONDecoder().decode(Grant.self, from: data)
    }

    func save(_ grant: Grant) throws {
        let data = try JSONEncoder().encode(grant)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item.merge(update) { _, new in new }
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else {
                throw NSError(domain: NSOSStatusErrorDomain, code: Int(added))
            }
            return
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}

// MARK: – Plumbing

/// Where the sign-in sheet is anchored. `ASWebAuthenticationSession` asks for a
/// window rather than a view controller, so there is nothing for SwiftUI to
/// hand it and the key window has to be found.
private final class PresentationAnchor: NSObject,
                                        ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

extension Data {
    /// Base64url without padding — what PKCE and `state` are specified in, and
    /// what survives a query string untouched.
    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
