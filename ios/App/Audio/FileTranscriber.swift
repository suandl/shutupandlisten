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
    /// caller keeps the (already-saved) live transcript in that case. Returns
    /// a non-nil, empty array when the file reads fine but no speech is detected.
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

        // Guards `resumed` (so the continuation can only fire once, even if the
        // completion handler races itself — not documented to be serial) and
        // `currentTask` (so `onCancel`, which can run on another thread, never
        // tears down the task mid-assignment).
        let lock = NSLock()
        var currentTask: SFSpeechRecognitionTask?

        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                var resumed = false
                func resumeOnce(_ value: [TranscriptSegment]?) {
                    lock.lock()
                    let shouldResume = !resumed
                    if shouldResume { resumed = true }
                    lock.unlock()
                    if shouldResume { continuation.resume(returning: value) }
                }

                let recognitionTask = recognizer.recognitionTask(with: request) { result, error in
                    if let error {
                        NSLog("FileTranscriber: recognition failed for \(url.lastPathComponent): \(error.localizedDescription)")
                        resumeOnce(nil)
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
                    resumeOnce(segments)
                }

                lock.lock(); currentTask = recognitionTask; lock.unlock()
                // Cancellation may have already landed before the task was stored.
                if Task.isCancelled { recognitionTask.cancel() }
            }
        } onCancel: {
            lock.lock(); let task = currentTask; lock.unlock()
            task?.cancel()
        }
    }
}
