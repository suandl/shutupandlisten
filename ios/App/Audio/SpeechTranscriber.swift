// Speech-to-text: SFSpeechRecognizer fed from AudioPipeline's buffers, stitched
// into ONE seam-free growing string (spec §1).
//
// Prefers on-device recognition when available. SFSpeechRecognizer has a
// ~1-min duty-cycle limit, so the recognition task is rotated INTERNALLY — a
// detail no consumer sees. To keep the live transcript from dropping words
// across a rotation, we rotate a beat BEFORE the limit, commit the outgoing
// task's in-flight partial so nothing it heard depends on it saying goodbye,
// and replay a short tail of buffered mic audio into the replacement task; the
// replacement then re-transcribes that tail, and TranscriptStitcher
// (TurnEngine) de-dups the overlap. The live string is best-effort by design —
// the authoritative saved transcript is derived from the .m4a by
// TranscriptReconciler, not from here.
//
// Utterance boundaries (the gate reads the WHOLE utterance so far) are anchored
// by character offset at turn start, exactly as before.

import AVFoundation
import Foundation
import Speech
import TurnEngine

final class SpeechTranscriber: NSObject {
    /// Fired on the main queue whenever the transcript changes.
    var onTranscriptUpdate: (() -> Void)?

    private let recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var running = false

    /// The seam-free transcript across task rotations (TurnEngine).
    private var stitcher = TranscriptStitcher()
    /// Character offset into `fullText` where the current utterance began.
    private var utteranceAnchor = 0

    /// Rotate this long after a task starts — a beat before the duty-cycle limit.
    private let rotateAfter: TimeInterval = 50
    private var rotateTimer: Timer?
    /// Set when a task could not start because the recognizer was momentarily
    /// unavailable; fires a short retry so recognition self-heals instead of
    /// dying silently for the rest of the session.
    private var retryTimer: Timer?
    /// A rolling tail of recent mic buffers, replayed into the replacement task
    /// so no audio is lost during the hop. Sized to ~1.5 s of buffers.
    ///
    /// `append(_:)` runs on the audio render thread while `tailBuffers` and
    /// `request` are otherwise only touched on main (start/stop/beginTask/
    /// rotate*/the recognition callback). `lock` guards both so the audio
    /// thread never observes a torn array or a use-after-free request.
    private var tailBuffers: [AVAudioPCMBuffer] = []
    private let maxTailBuffers = 35 // ~1.5 s at 2048-frame / ~43 ms buffers
    private let lock = NSLock()

    /// Bumped each time a new recognition task is started. A recognition
    /// task's completion closure captures the generation it was created with;
    /// if a proactive rotation has since moved `generation` forward, that
    /// task's late callback is stale and is ignored entirely — the rotation
    /// already committed everything that task had heard, so there is nothing
    /// left to salvage from it. Touched only on main — no lock needed.
    private var generation = 0

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    override init() {
        recognizer = SFSpeechRecognizer(locale: Locale.current)
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        super.init()
        // Recover automatically the moment the recognizer flips back to
        // available. It can drop out transiently (system busy, on-device model
        // reloading); without this, a rotation that lands in an unavailable
        // window would leave recognition dead for the rest of the session —
        // the transcript freezes while the UI still says "listening".
        recognizer?.delegate = self
    }

    var fullText: String { stitcher.text }

    /// The whole current utterance transcribed so far — anchored at turn start.
    var currentUtteranceText: String {
        let text = fullText
        guard utteranceAnchor < text.count else { return "" }
        return String(text.dropFirst(utteranceAnchor)).trimmingCharacters(in: .whitespaces)
    }

    /// Called by the host on `turn-start`: the next words belong to a new thought.
    func markUtteranceStart() {
        utteranceAnchor = fullText.count
    }

    static func requestAuthorization() async -> Bool {
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
    }

    func start() {
        guard !running else { return }
        running = true
        stitcher.reset()
        utteranceAnchor = 0
        locked { tailBuffers.removeAll() }
        beginTask(replayTail: false)
    }

    func stop() {
        running = false
        rotateTimer?.invalidate()
        rotateTimer = nil
        retryTimer?.invalidate()
        retryTimer = nil
        task?.cancel()
        task = nil
        let oldRequest = locked { () -> SFSpeechAudioBufferRecognitionRequest? in
            let current = request
            request = nil
            return current
        }
        oldRequest?.endAudio()
        locked { tailBuffers.removeAll() }
    }

    /// Audio-thread entry point, wired to AudioPipeline.onBuffer.
    func append(_ buffer: AVAudioPCMBuffer) {
        // Keep a rolling tail so a rotation can replay the last ~1.5 s, and
        // grab the current request — all under the lock, since both are
        // written from main. The Speech API call itself happens OUTSIDE the
        // lock so we never hold it across an unbounded call.
        let localRequest = locked { () -> SFSpeechAudioBufferRecognitionRequest? in
            tailBuffers.append(buffer)
            if tailBuffers.count > maxTailBuffers {
                tailBuffers.removeFirst(tailBuffers.count - maxTailBuffers)
            }
            return request
        }
        localRequest?.append(buffer)
    }

    // ── task lifecycle ──

    private func beginTask(replayTail: Bool) {
        guard running, let recognizer else { return }
        guard recognizer.isAvailable else {
            // Momentarily unavailable — do NOT die. Retry shortly; the delegate
            // callback will also kick us the instant availability returns. This
            // is the fix for the frozen-transcript-but-still-"listening" stall.
            scheduleRetry()
            return
        }
        // We're starting a task — cancel any pending recovery retry.
        retryTimer?.invalidate()
        retryTimer = nil

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }

        // Seed the replacement task with the buffered tail so words spoken
        // during the hop are transcribed; the stitcher de-dups the overlap.
        if replayTail {
            let tail = locked { tailBuffers }
            for buffer in tail { req.append(buffer) }
        }

        locked { request = req }

        // Each task gets a generation stamp. A superseded task's forced-final
        // callback (see rotateProactively) arrives AFTER `generation` has
        // already moved on, so the guard below turns it into a no-op instead
        // of letting it nil out the replacement task's state.
        generation += 1
        let myGeneration = generation

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            DispatchQueue.main.async {
                let isCurrent = (myGeneration == self.generation)

                if let result, isCurrent {
                    // Only the CURRENT task speaks for the transcript. A
                    // superseded task's late result — partial OR final — is
                    // dropped: rotateProactively() already committed everything
                    // that task had heard, and its final would arrive as the
                    // task's WHOLE ~50 s transcript, which merge() cannot align
                    // against a committed tail that is that same transcript's
                    // end. One revised opening word (the final adds punctuation
                    // and casing) breaks the overlap and the minute lands twice.
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        // The live task ended on its own terms: its final
                        // supersedes its own partial, and merge() strips the
                        // overlap its replayed tail re-transcribed.
                        self.stitcher.commit(text)
                    } else {
                        self.stitcher.setPartial(text)
                    }
                    self.onTranscriptUpdate?()
                }

                if isCurrent, error != nil || (result?.isFinal ?? false) {
                    // Only the CURRENT task tears down + rotates. A superseded
                    // task's late terminal callback must NOT nil the fresh
                    // request/task or trigger another rotation (that was the
                    // orphaned-task cascade).
                    //
                    // A task that died with an error left no final to fold in,
                    // so lock in what it had reached — the same move
                    // rotateProactively() makes, for the same reason. After a
                    // final, commit() already emptied the partial and this is a
                    // no-op; either way `fullText` is unchanged, so no update
                    // needs firing.
                    self.stitcher.commitPartial()
                    self.locked { self.request = nil }
                    self.task = nil
                    if self.running { self.rotate(replayTail: true) }
                }
            }
        }

        // Proactive rotation: end this task a beat before the hard limit so the
        // hop is planned (with a replay tail) rather than a surprise death.
        // Scheduled in .common run-loop modes so UI tracking (e.g. scrolling)
        // can't delay it past the duty-cycle limit.
        rotateTimer?.invalidate()
        let timer = Timer(timeInterval: rotateAfter, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.rotateProactively() }
        }
        RunLoop.main.add(timer, forMode: .common)
        rotateTimer = timer
    }

    /// Timer-driven rotation: lock in the in-flight partial, then hop with a
    /// replayed tail.
    ///
    /// The lock-in is the load-bearing step. This used to lean on `endAudio()`
    /// forcing the outgoing task to deliver a final that the callback folded
    /// in — but `cancel()` on the very next line races that final and normally
    /// wins: cancelling ends a task with an error and no further results, and
    /// only `finish()` promises the pending final. Lose that race and up to
    /// ~50 s of speech, alive only as the stitcher's partial, is wiped the
    /// instant the replacement reports its first partial — which re-covers just
    /// the ~1.5 s replay tail. Committing here means the hop never bets on a
    /// race: every task's words reach the committed transcript exactly once,
    /// via its own final while it is current, or via this commit when we rotate
    /// away from it.
    ///
    /// `endAudio()` and `cancel()` still tear the old task down promptly — one
    /// releases the request, the other stops the work — and whatever it says on
    /// the way out is ignored as stale (see `generation`).
    private func rotateProactively() {
        guard running else { return }
        stitcher.commitPartial()
        let oldRequest = locked { request }
        oldRequest?.endAudio()
        task?.cancel()
        locked { request = nil }
        task = nil
        rotate(replayTail: true)
    }

    private func rotate(replayTail: Bool) {
        rotateTimer?.invalidate()
        rotateTimer = nil
        beginTask(replayTail: replayTail)
    }

    /// Schedule a short retry after a task failed to start (recognizer
    /// unavailable). Idempotent — only one retry is ever pending.
    private func scheduleRetry() {
        guard running, retryTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.retryBeginTask() }
        }
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
    }

    private func retryBeginTask() {
        retryTimer = nil
        guard running, task == nil else { return }
        beginTask(replayTail: true)
    }
}

extension SpeechTranscriber: SFSpeechRecognizerDelegate {
    /// The recognizer became available (or unavailable) again. When it comes
    /// back and we're running with no live task, restart immediately with the
    /// replayed tail so recognition resumes without waiting on the retry timer.
    func speechRecognizer(_ recognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.running, available, self.task == nil else { return }
            self.retryTimer?.invalidate()
            self.retryTimer = nil
            self.beginTask(replayTail: true)
        }
    }
}
