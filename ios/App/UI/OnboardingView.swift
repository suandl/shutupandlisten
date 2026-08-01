// First launch: four pages — what it is, the silence contract (with a small
// self-running patience-bar demo), the on-device speech model (downloaded here
// with visible progress, so the first session never stalls on it — plan R2.6),
// and the optional account. Copy stays in the product's voice: quiet,
// specific, unhyped.

import AuthenticationServices
import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject private var accountStore: AccountStore
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @State private var page = 0
    @State private var signingIn = false
    @State private var signInError: String?
    @State private var assetPhase: AssetPhase = .checking

    private enum AssetPhase: Equatable {
        case checking
        case downloading(Double)
        case ready
        case unsupported
        case failed(String)
    }

    var body: some View {
        TabView(selection: $page) {
            whatItIs.tag(0)
            silenceContract.tag(1)
            dictationModel.tag(2)
            account.tag(3)
        }
        .tabViewStyle(.page)
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .background(Color(.systemBackground))
    }

    // ── page 1: what it is ──

    private var whatItIs: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "waveform")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("shutupandlisten")
                .font(.largeTitle.bold())
            Text("A voice recorder that actually listens.")
                .font(.title3.weight(.semibold))
            Text(
                """
                Think out loud. It thinks with you, not at you — no summaries, \
                no coaching, no taking over. When a thought has fully landed, \
                it pulls on one thread of what you actually said.
                """
            )
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
    }

    // ── page 2: the silence contract ──

    private var silenceContract: some View {
        VStack(spacing: 20) {
            Spacer()
            Text("The silence contract")
                .font(.title2.bold())
            PatienceDemo()
            Text(
                """
                A pause is not its cue. It waits until the idea lands — then \
                asks one question about what you actually said.
                """
            )
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            Text("Most pauses never become questions.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
    }

    // ── page 3: the on-device speech model ──

    private var dictationModel: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "waveform.badge.mic")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
            Text("Dictation stays on your phone")
                .font(.title2.bold())
            Text(
                """
                Your words are transcribed entirely on this device — nothing \
                you say leaves it. The speech model for your language \
                downloads once, then works offline.
                """
            )
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)

            assetStatus

            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
        .task { await ensureAssets() }
    }

    @ViewBuilder
    private var assetStatus: some View {
        switch assetPhase {
        case .checking:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Checking for the model…")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        case .downloading(let fraction):
            VStack(spacing: 8) {
                ProgressView(value: fraction)
                    .frame(maxWidth: 220)
                Text("Downloading the speech model…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        case .ready:
            Label("Ready — transcription works offline.", systemImage: "checkmark.circle.fill")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.green)
        case .unsupported:
            Text(
                "On-device transcription isn't available for your language "
                    + "yet, so sessions can't be transcribed on this device."
            )
            .font(.footnote)
            .foregroundStyle(.red)
            .multilineTextAlignment(.center)
        case .failed(let message):
            VStack(spacing: 8) {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                Button("Try again") {
                    Task { await ensureAssets() }
                }
                .font(.footnote.weight(.medium))
            }
        }
    }

    private func ensureAssets() async {
        let locale = Locale.current
        switch await AssetEnsure.status(for: locale) {
        case .installed:
            assetPhase = .ready
        case .unsupported:
            assetPhase = .unsupported
            return
        case .needsDownload:
            assetPhase = .downloading(0)
            do {
                try await AssetEnsure.ensure(for: locale) { fraction in
                    Task { @MainActor in assetPhase = .downloading(fraction) }
                }
                assetPhase = .ready
            } catch {
                assetPhase = .failed(
                    "The download didn't finish — check your connection. "
                        + "You can also retry from the first session."
                )
                return
            }
        }
        await AssetEnsure.releaseStaleReservations(keeping: locale)
    }

    // ── page 4: account ──

    private var account: some View {
        VStack(spacing: 20) {
            Spacer()
            Text("One quiet connection")
                .font(.title2.bold())
            Text(
                """
                Sign in and the listener's rare question reaches the model \
                through our server — no API key to manage.
                """
            )
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)

            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = []
            } onCompletion: { result in
                handleSignIn(result)
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 50)
            .disabled(signingIn)

            if signingIn {
                ProgressView()
            }
            if let signInError {
                Text(signInError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }

            Button("Set up later") {
                hasOnboarded = true
            }
            .font(.body.weight(.medium))

            Text(
                """
                Dictation is transcribed on-device, always. Only the rare \
                question round-trips.
                """
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
    }

    private func handleSignIn(_ result: Result<ASAuthorization, Error>) {
        switch AppleSignIn.outcome(of: result) {
        case .cancelled:
            return
        case .failed(let message):
            signInError = message
        case .token(let identityToken):
            signingIn = true
            signInError = nil
            Task {
                do {
                    try await accountStore.completeSignIn(identityToken: identityToken)
                    hasOnboarded = true
                } catch {
                    signInError = error.localizedDescription
                }
                signingIn = false
            }
        }
    }
}

// ── the self-running patience-bar demo ──
//
// Pure SwiftUI, no audio: "speech" and "silence" alternate on a script. The
// first pause fills the bar partway, then speech resumes and the bar resets —
// the pause was never its cue. The second pause runs the window out, and only
// then does one question appear.

private struct PatienceDemo: View {
    @State private var fill: Double = 0
    @State private var speaking = true
    @State private var landed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Circle()
                    .fill(speaking ? Color.blue : (landed ? Color.purple : Color.orange))
                    .frame(width: 10, height: 10)
                Text(statusText)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule()
                        .fill(Color.orange)
                        .frame(width: max(0, geo.size.width * fill))
                }
            }
            .frame(height: 6)
            Text("“What makes someone open the app again tomorrow?”")
                .font(.footnote.italic())
                .foregroundStyle(.secondary)
                .opacity(landed ? 1 : 0)
        }
        .padding(16)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .task { await run() }
    }

    private var statusText: String {
        if speaking { return "You're talking — staying out of the way" }
        if landed { return "Thought landed — one thread-pull" }
        return "Pause — waiting it out"
    }

    private func run() async {
        while !Task.isCancelled {
            // Speaking.
            withAnimation(.easeOut(duration: 0.25)) {
                speaking = true
                landed = false
                fill = 0
            }
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard !Task.isCancelled else { return }

            // A thinking-pause: the window starts filling…
            withAnimation(.easeOut(duration: 0.2)) { speaking = false }
            withAnimation(.linear(duration: 1.4)) { fill = 0.6 }
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            guard !Task.isCancelled else { return }

            // …speech resumes: the window resets. No interruption.
            withAnimation(.easeOut(duration: 0.25)) {
                speaking = true
                fill = 0
            }
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard !Task.isCancelled else { return }

            // The idea lands: the window runs all the way out.
            withAnimation(.easeOut(duration: 0.2)) { speaking = false }
            withAnimation(.linear(duration: 2.2)) { fill = 1 }
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            guard !Task.isCancelled else { return }

            withAnimation(.easeOut(duration: 0.3)) { landed = true }
            try? await Task.sleep(nanoseconds: 2_400_000_000)
        }
    }
}
