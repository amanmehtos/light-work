import SwiftUI
import DiurnalUI

/// What there is to see before the app has a grant.
///
/// It says what is about to be asked for, because the consent screen will name
/// the same two scopes and arriving at it cold is how a sign-in starts to feel
/// like something being taken rather than given.
struct SignInView: View {
    @ObservedObject var auth: LightWeekAuth

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Light Week").dnEyebrow()

            Text("Your week, and where the attention went")
                .font(DiurnalType.body(.title2))
                .foregroundStyle(Color.dnInk)

            Text("""
                Signing in opens Light Week in a browser sheet so the account \
                itself can say yes. This app is then granted permission to read \
                and change your tasks — nothing else, and you can withdraw it \
                from your account at any time.
                """)
                .font(DiurnalType.body(.callout))
                .foregroundStyle(Color.dnInk2)

            Button {
                _Concurrency.Task { await auth.signIn() }
            } label: {
                HStack {
                    Spacer()
                    if auth.state == .signingIn {
                        ProgressView().controlSize(.small).tint(Color.dnBackground)
                    } else {
                        Text("Sign in to Light Week").font(DiurnalType.body(.body, weight: .medium))
                    }
                    Spacer()
                }
                .padding(.vertical, 13)
                .foregroundStyle(Color.dnBackground)
                .background(Color.dnInk, in: RoundedRectangle(cornerRadius: DiurnalTokens.radius))
            }
            .buttonStyle(.plain)
            .disabled(auth.state == .signingIn)

            if let error = auth.lastError {
                Text(error)
                    .font(DiurnalType.body(.footnote))
                    .foregroundStyle(Color.dnDanger)
            }
        }
        .padding(26)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Color.dnBackground)
        .overlay(alignment: .top) {
            // The weather outside, before there is anything of yours to show.
            SkyHeader(height: .tall).allowsHitTesting(false)
        }
        .ignoresSafeArea(edges: .top)
    }
}
