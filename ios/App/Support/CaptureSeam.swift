// The one place the capture seams are switched on. Everything here is inert
// unless the app was launched with -uiTestCapture, so production behavior is
// untouched. Install order matters: seed auth + onboarding and register the
// network stub BEFORE any view renders or any request is made.

import ClaudeClient
import Foundation

enum CaptureSeam {
    /// Launch argument that arms the whole capture path.
    static let flag = CaptureFlags.capture
    /// The stub developer key used during capture. Routes the listener through
    /// `ClaudeClient` → api.anthropic.com, which `CaptureURLProtocol` intercepts.
    /// Resolved directly (not via the keychain) so an unsigned capture build —
    /// where the keychain write can silently fail — still reaches the stub.
    static let fakeAPIKey = "ci-capture-fake-key"
    /// Drives the REAL pipeline from the bundled fixture `.wav` (design: in-app
    /// audio injection) — the primary CI capture path. Requires `flag`.
    static let injectAudioFlag = CaptureFlags.injectAudio
    /// Optional fallback (design §reliability): paint the on-screen transcript
    /// and hint from the fixture instead of real audio, for when real
    /// transcription yields nothing (e.g. SFSpeech unavailable on the runner).
    static let seedTranscriptFlag = CaptureFlags.seedTranscript

    static var isActive: Bool { CaptureFlags.isActive(CommandLine.arguments) }
    /// True when launched to drive the pipeline from the fixture file (both
    /// `flag` and `injectAudioFlag` present).
    static var shouldInjectAudio: Bool { CaptureFlags.shouldInjectAudio(CommandLine.arguments) }
    static var shouldSeedTranscript: Bool { CaptureFlags.shouldSeedTranscript(CommandLine.arguments) }

    /// Arm the seams. Called first thing from ShutUpAndListenApp.init.
    static func installIfNeeded() {
        guard isActive else { return }
        // Skip onboarding so the session screen is visible immediately.
        UserDefaults.standard.set(true, forKey: "hasOnboarded")
        // Seed the fake key so a captured Settings screen shows a dev key
        // populated. The listener's actual auth bypass no longer depends on
        // this write (which can silently fail on an unsigned capture build):
        // SessionController.resolveService short-circuits to a fakeAPIKey
        // ClaudeClient under CaptureSeam.isActive, reaching CaptureURLProtocol.
        KeychainStore.apiKey = fakeAPIKey
        if let fixture = loadFixture() {
            CaptureURLProtocol.fixture = fixture
        }
        URLProtocol.registerClass(CaptureURLProtocol.self)
    }

    static func loadFixture() -> CaptureFixture? {
        guard let url = Bundle.main.url(forResource: "capture-fixture", withExtension: "json"),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return try? CaptureFixture.decode(from: data)
    }
}
