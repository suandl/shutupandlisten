// The one place the capture seams are switched on. Everything here is inert
// unless the app was launched with -uiTestCapture, so production behavior is
// untouched. Install order matters: seed auth + onboarding and register the
// network stub BEFORE any view renders or any request is made.
//
// Compiled into DEBUG builds ONLY. The whole capture seam — this file,
// CaptureURLProtocol, and CaptureAudioInjector — is `#if DEBUG`-guarded AND
// excluded from the app target's Release build phase, so the network-
// interception URLProtocol and the auth bypass never ship in an App Store
// (Release) binary (su-uzy9.1, f4).
#if DEBUG

import ClaudeClient
import Foundation

enum CaptureSeam {
    /// Launch argument that arms the whole capture path.
    static let flag = CaptureFlags.capture
    /// The stub developer key used during capture. Routes the listener through
    /// `ClaudeClient` → api.anthropic.com, which `CaptureURLProtocol` intercepts.
    /// Resolved directly in-memory (never written to the keychain) so a capture
    /// run leaves the developer's real stored dev key untouched while still
    /// reaching the stub.
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
        // The listener's auth bypass is entirely in-memory and never touches
        // the keychain: SessionController.resolveService short-circuits to a
        // fakeAPIKey ClaudeClient under CaptureSeam.isActive, reaching
        // CaptureURLProtocol. Leaving the keychain alone means a developer's
        // real stored dev key survives a local capture run.
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

#endif
