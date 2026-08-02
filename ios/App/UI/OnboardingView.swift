// First launch: four pages that sell the promise, not the mechanics —
// (1) finish a thought, (2) the silence contract shown live by the
// self-running patience demo, (3) the on-device speech model, downloaded here
// with visible progress so the first session never stalls on it (plan R2.6),
// and (4) one honest sentence and the mic permission ask. No account page:
// sign-in happens contextually, the first time the listener's question
// actually needs the model.
//
// Page 3 is where the two histories meet: main's flow had no model step
// because SFSpeechRecognizer needed no asset, and the transcript-core rewrite
// added one because SpeechAnalyzer's locale model IS an AssetInventory
// download. It sits second-to-last so the flow still ENDS on the start
// button.

import AVFoundation
import SwiftUI

struct OnboardingView: View {
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @State private var page = 0
    @State private var requestingPermissions = false
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
            promise.tag(0)
            silenceContract.tag(1)
            dictationModel.tag(2)
            permissions.tag(3)
        }
        .tabViewStyle(.page)
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .background(Color(.systemBackground))
        .overlay(alignment: .topTrailing) {
            Button("Skip") { hasOnboarded = true }
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(20)
        }
    }

    // ── page 1: the promise ──

    private var promise: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "waveform")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("shutupandlisten")
                .font(.largeTitle.bold())
            Text("Finally, something that lets you finish a thought.")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(
                """
                Think out loud. It won't interrupt — no summaries, no \
                coaching, no taking over. When a thought has fully landed, \
                it asks one question about what you actually said.
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
                .font(.subheadline.weight(.medium))
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
    }

    // ── page 3: permissions ──

    private var permissions: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "mic")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
            Text("It needs to hear you")
                .font(.title2.bold())
            Text(
                """
                It uses the microphone to listen. Your words are written \
                down on this phone, always — the recording and the transcript \
                never leave it.
                """
            )
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)

            Button {
                requestPermissions()
            } label: {
                if requestingPermissions {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Allow and start")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(requestingPermissions)

            Button("Not now") {
                hasOnboarded = true
            }
            .font(.body.weight(.medium))
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
    }

    /// Ask for the mic, then get out of the way. A denial is not a dead end
    /// here — the session screen re-checks on the first mic tap.
    ///
    /// MIC ONLY. `SpeechAnalyzer`'s on-device recognition has no
    /// speech-authorization gate, so the legacy
    /// `SFSpeechRecognizer.requestAuthorization` path is gone — along with the
    /// `NSSpeechRecognitionUsageDescription` Info.plist key it required.
    /// Requesting it here without that key would terminate the app.
    private func requestPermissions() {
        requestingPermissions = true
        Task {
            _ = await AVAudioApplication.requestRecordPermission()
            requestingPermissions = false
            hasOnboarded = true
        }
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

    /// Best-effort: a failure here is never a dead end — `startSession`
    /// re-verifies the model at every session start and can fetch it then.
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
                .font(.subheadline.italic())
                .opacity(landed ? 1 : 0)
        }
        .padding(16)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .task { await run() }
    }

    private var statusText: String {
        if speaking { return "You're talking — it stays out of the way" }
        if landed { return "The idea landed — one question" }
        return "A pause — it waits"
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
