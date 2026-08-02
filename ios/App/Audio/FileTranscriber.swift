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
    /// Thread-safe holder for the in-flight recognition task and the resume-once
    /// flag. The `withCheckedContinuation` body and the `onCancel` handler run in
    /// separate concurrency domains but must share this state; a `let` reference
    /// to this class (rather than captured `var`s) is what keeps that capture
    /// legal under Swift 6. Manually synchronized with `lock`, hence
    /// `@unchecked Sendable`.
    private final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var task: SFSpeechRecognitionTask?
        private var resumed = false

        func setTask(_ task: SFSpeechRecognitionTask) {
            lock.lock(); self.task = task; lock.unlock()
        }

        func cancel() {
            lock.lock(); let task = self.task; lock.unlock()
            task?.cancel()
        }

        /// Returns true for exactly one caller — the first to win the right to
        /// resume the continuation. All later calls get false and must not resume
        /// (a `CheckedContinuation` fatal-crashes if resumed more than once).
        func claimResume() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if resumed { return false }
            resumed = true
            return true
        }
    }

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

        let state = State()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                func resumeOnce(_ value: [TranscriptSegment]?) {
                    if state.claimResume() { continuation.resume(returning: value) }
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

                state.setTask(recognitionTask)
                // Cancellation may have already landed before the task was stored.
                if Task.isCancelled { recognitionTask.cancel() }
            }
        } onCancel: {
            state.cancel()
        }
    }
}
