// The one place the capture seams are switched on. Everything here is inert
// unless the app was launched with -uiTestCapture, so production behavior is
// untouched. Install order matters: seed auth + onboarding and register the
// network stub BEFORE any view renders or any request is made.

import ClaudeClient
import Foundation

enum CaptureSeam {
    /// Launch argument that arms the whole capture path.
    static let flag = "-uiTestCapture"
    /// Optional fallback (design §reliability): drive the on-screen transcript
    /// and hint from the fixture instead of real audio, for when host mic
    /// injection is unavailable (e.g. the GitHub runner).
    static let seedTranscriptFlag = "-captureSeedTranscript"

    static var isActive: Bool { CommandLine.arguments.contains(flag) }
    static var shouldSeedTranscript: Bool { CommandLine.arguments.contains(seedTranscriptFlag) }

    /// Arm the seams. Called first thing from ShutUpAndListenApp.init.
    static func installIfNeeded() {
        guard isActive else { return }
        // Skip onboarding so the session screen is visible immediately.
        UserDefaults.standard.set(true, forKey: "hasOnboarded")
        // Auth bypass: a fake developer key routes the listener through
        // ClaudeClient → api.anthropic.com, which CaptureURLProtocol intercepts.
        KeychainStore.apiKey = "ci-capture-fake-key"
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
