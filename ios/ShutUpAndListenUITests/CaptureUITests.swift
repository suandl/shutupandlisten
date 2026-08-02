// Drives one realistic capture pass: launch into the session screen, tap Start
// (a real tap, for realism), and snapshot the checkpoints the reviewer wants to
// see. Deliberately tolerant — transcription of injected audio is nondeterministic,
// so we capture whatever the real screen shows and never assert on words. The
// script sets light/dark appearance around each run and collects screenshots
// from the result bundle with xcparse.

import XCTest

final class CaptureUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    func testCaptureSession() {
        let app = XCUIApplication()
        // Primary path: drive the real pipeline from the bundled fixture .wav
        // (design: in-app audio injection). Real transcription/VAD/turn/gate,
        // stubbed Claude replies. No BlackHole, no host audio.
        app.launchArguments = ["-uiTestCapture", "-captureInjectAudio"]
        // Last-resort display-only paint, opt-in via env (kept for a runner where
        // even injected SFSpeech is unavailable).
        if ProcessInfo.processInfo.environment["CAPTURE_SEED_TRANSCRIPT"] == "1" {
            app.launchArguments.append("-captureSeedTranscript")
        }
        app.launch()

        // 01 — idle / ready.
        snapshot(app, "01-idle")

        // Tap Start (fail only if the control is genuinely absent).
        let start = app.buttons["session.startButton"]
        XCTAssertTrue(start.waitForExistence(timeout: 20), "Start control never appeared")
        start.tap()

        // 02 — live transcript building. Give audio time to feed in.
        _ = app.otherElements["session.transcript"].waitForExistence(timeout: 10)
        sleep(6)
        snapshot(app, "02-live-transcript")

        // Deterministic nudge (design §reliability): the natural gate escalation
        // over the fixture is nondeterministic, so explicitly pull a thread —
        // askNow() requests a question the stub answers, landing a REAL listener
        // line built on the REAL transcript. Optional; tapped only if present.
        let askNow = app.buttons["session.askNowButton"]
        if askNow.waitForExistence(timeout: 10), askNow.isEnabled {
            askNow.tap()
        }

        // 03 — a listener reply landed inline (never asserted; capture regardless).
        _ = app.staticTexts["session.listenerReply"].firstMatch.waitForExistence(timeout: 30)
        snapshot(app, "03-listener-reply")

        // 04 — the SUGGESTED hint line.
        _ = app.otherElements["session.hint"].waitForExistence(timeout: 5)
        snapshot(app, "04-hint-line")

        // Let the session (and video) dwell a little longer, then end cleanly.
        sleep(4)
        if app.buttons["session.startButton"].exists {
            app.buttons["session.startButton"].tap()
        }
        snapshot(app, "05-ended")
    }

    /// Attach a full-screen screenshot kept in the result bundle for xcparse.
    private func snapshot(_ app: XCUIApplication, _ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
