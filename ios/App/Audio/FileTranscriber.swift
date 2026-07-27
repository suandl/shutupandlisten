// The authoritative transcript pass (spec §1): re-transcribe the finished .m4a
// with SFSpeechURLRecognitionRequest. Unlike the live buffer stream, a file
// request has no ~1-min duty-cycle gaps and returns stable, timestamped
// segments — so it is the source of truth for what the thinker actually said.
// The mic .m4a is thinker-only (the engine's AEC removed our own TTS), so every
// segment is thinker audio; listener lines are re-inserted by the reconciler.
//
// The result feeds TranscriptReconciler (TurnEngine). Output timestamps are ms
// offsets into the recording, which shares the machine's clock origin — so
// tap-to-seek in SessionDetailView lands on the words.

import Foundation
import Speech
import TurnEngine

enum FileTranscriber {
    /// Transcribe the whole `.m4a` at `url` into timestamped segments. Returns
    /// nil when recognition is unavailable or the file cannot be read — the
    /// caller keeps the (already-saved) live transcript in that case.
    static func transcribe(url: URL) async -> [TranscriptSegment]? {
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current)
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
            recognizer.isAvailable
        else { return nil }

        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        return await withCheckedContinuation { continuation in
            var resumed = false
            recognizer.recognitionTask(with: request) { result, error in
                if let error {
                    if !resumed { resumed = true; continuation.resume(returning: nil) }
                    _ = error
                    return
                }
                guard let result, result.isFinal else { return }
                let segments = result.bestTranscription.segments.map { seg in
                    TranscriptSegment(
                        text: seg.substring,
                        startMs: Int((seg.timestamp * 1000).rounded()),
                        endMs: Int(((seg.timestamp + seg.duration) * 1000).rounded())
                    )
                }
                if !resumed { resumed = true; continuation.resume(returning: segments) }
            }
        }
    }
}
