import SwiftUI

/// What there is to see before the app has a grant.
///
/// It says what is about to be asked for, because the consent screen will name
/// the same two scopes and arriving at it cold is how a sign-in starts to feel
/// like something being taken rather than given.
struct SignInView: View {
    @ObservedObject var auth: LightWeekAuth

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("LIGHT WEEK")
                .font(.caption.weight(.semibold))
                .tracking(1.6)
                .foregroundStyle(.secondary)

            Text("Your week, and where the attention went")
                .font(.title2.weight(.semibold))

            Text("""
                Signing in opens Light Week in a browser sheet so the account \
                itself can say yes. This app is then granted permission to read \
                and change your tasks — nothing else, and you can withdraw it \
                from your account at any time.
                """)
                .font(.callout)
                .foregroundStyle(.secondary)

            Button {
                _Concurrency.Task { await auth.signIn() }
            } label: {
                HStack {
                    Spacer()
                    if auth.state == .signingIn {
                        ProgressView().controlSize(.small).tint(Color(uiColor: .systemBackground))
                    } else {
                        Text("Sign in to Light Week").font(.body.weight(.medium))
                    }
                    Spacer()
                }
                .padding(.vertical, 13)
                .foregroundStyle(Color(uiColor: .systemBackground))
                .background(Color.primary, in: RoundedRectangle(cornerRadius: 11))
            }
            .buttonStyle(.plain)
            .disabled(auth.state == .signingIn)

            if let error = auth.lastError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(26)
        .frame(maxHeight: .infinity, alignment: .center)
    }
}
