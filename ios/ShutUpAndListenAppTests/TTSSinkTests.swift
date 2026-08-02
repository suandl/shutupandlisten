// `SpeechOutput`'s completion contract — the reasoning behind a deliberate
// NON-merge in the transcript-core port (§1c), carried forward as a test
// rather than as code.
//
// The rewrite branch added `speechSynthesizer(_:didCancel:)` → `onFinished()`,
// so a cut clip would still close the host's floor bookkeeping. Main holds the
// opposite policy: completion is derived from the player node's buffer
// callbacks plus the zero-length end marker, and `stop()` deliberately
// SUPPRESSES completion for a cut clip — because the host's barge-in and
// interruption paths already close the floor themselves
// (`lastFloorReleaseMs` + `closeOpenListener`). Taking the rewrite's addition
// would have fed a spurious `.tick` after every barge-in.
//
// Both halves matter, so both are asserted: exactly once per clip, and never
// after `stop()`.
//
// NOTE: this target is not yet wired into the Xcode project — see README.md.

import AVFoundation
import XCTest
@testable import ShutUpAndListen

/// A stand-in for `CaptureController`'s player node: renders nothing, reports
/// every scheduled buffer as finished immediately, and counts what it saw.
@MainActor
private final class FakeSink: TTSPlaybackSink {
    var ttsFormat: AVAudioFormat?
    private(set) var scheduled = 0
    private(set) var stopped = 0
    /// When false, `playTTS` swallows the completion — standing in for a clip
    /// that is cut before its buffers ever render.
    var completesImmediately = true

    init(format: AVAudioFormat? = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)) {
        ttsFormat = format
    }

    nonisolated func playTTS(
        _ buffer: AVAudioPCMBuffer, onComplete: @escaping @Sendable () -> Void
    ) {
        MainActor.assumeIsolated {
            scheduled += 1
            guard completesImmediately else { return }
            DispatchQueue.main.async(execute: onComplete)
        }
    }

    nonisolated func stopTTS() {
        MainActor.assumeIsolated { stopped += 1 }
    }
}

@MainActor
final class TTSSinkTests: XCTestCase {
    func testOnFinishedFiresOncePerClipAndNeverAfterStop() async throws {
        let speech = SpeechOutput()
        var finishedCount = 0
        speech.onFinished = { finishedCount += 1 }

        // ── 1. No sink: the documented degenerate case. There is no engine to
        // render into, so the clip is reported finished immediately rather than
        // leaving the caller's response window open forever — and exactly once.
        speech.sink = nil
        speech.speak("no engine is running")
        XCTAssertEqual(finishedCount, 1, "a clip with nowhere to render reports finished once")

        // ── 2. A real clip through a sink: still exactly one report, however
        // many buffers the synthesizer produced.
        let sink = FakeSink()
        speech.sink = sink
        finishedCount = 0

        let finished = expectation(description: "clip finished")
        speech.onFinished = {
            finishedCount += 1
            if finishedCount == 1 { finished.fulfill() }
        }
        speech.speak("One short line.")
        await fulfillment(of: [finished], timeout: 20)

        // Let any further buffer callbacks land before counting.
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(finishedCount, 1,
                       "onFinished fires ONCE per clip, not once per rendered buffer")
        XCTAssertGreaterThan(sink.scheduled, 0, "fixture check: buffers really were scheduled")

        // ── 3. The half that matters for barge-in: a clip cut by `stop()` must
        // NOT report finished. The host has already closed the floor itself, so
        // a completion here would feed a spurious `.tick` after every barge-in.
        // This is exactly what the rewrite's `didCancel` bridge would have done.
        let cutSink = FakeSink()
        cutSink.completesImmediately = false // the cut clip's buffers never render
        speech.sink = cutSink
        finishedCount = 0

        speech.speak("A longer line that will be interrupted part of the way through.")
        speech.stop()
        XCTAssertEqual(cutSink.stopped, 1, "stop() flushes the sink")

        // Synthesis outlives a barge-in: buffers for the stopped clip keep
        // arriving for a while. None of them may report completion.
        try await Task.sleep(nanoseconds: 1_500_000_000)
        XCTAssertEqual(finishedCount, 0,
                       "a clip cut by stop() must never report finished")
    }
}
