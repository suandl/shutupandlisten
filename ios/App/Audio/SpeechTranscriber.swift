// Speech-to-text: SFSpeechRecognizer fed from AudioPipeline's buffers, stitched
// into ONE seam-free growing string (spec §1).
//
// Prefers on-device recognition when available. SFSpeechRecognizer has a
// ~1-min duty-cycle limit, so the recognition task is rotated INTERNALLY — a
// detail no consumer sees. To keep the live transcript from dropping words
// across a rotation, we rotate a beat BEFORE the limit and replay a short tail
// of buffered mic audio into the replacement task; the replacement then
// re-transcribes that tail, and TranscriptStitcher (TurnEngine) de-dups the
// overlap. The live string is best-effort by design — the authoritative saved
// transcript is derived from the .m4a by TranscriptReconciler, not from here.
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
    /// A rolling tail of recent mic buffers, replayed into the replacement task
    /// so no audio is lost during the hop. Sized to ~1.5 s of buffers.
    private var tailBuffers: [AVAudioPCMBuffer] = []
    private let maxTailBuffers = 35 // ~1.5 s at 2048-frame / ~43 ms buffers

    override init() {
        recognizer = SFSpeechRecognizer(locale: Locale.current)
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        super.init()
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
        tailBuffers.removeAll()
        beginTask(replayTail: false)
    }

    func stop() {
        running = false
        rotateTimer?.invalidate()
        rotateTimer = nil
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        tailBuffers.removeAll()
    }

    /// Audio-thread entry point, wired to AudioPipeline.onBuffer.
    func append(_ buffer: AVAudioPCMBuffer) {
        request?.append(buffer)
        // Keep a rolling tail so a rotation can replay the last ~1.5 s.
        tailBuffers.append(buffer)
        if tailBuffers.count > maxTailBuffers {
            tailBuffers.removeFirst(tailBuffers.count - maxTailBuffers)
        }
    }

    // ── task lifecycle ──

    private func beginTask(replayTail: Bool) {
        guard running, let recognizer, recognizer.isAvailable else { return }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }

        // Seed the replacement task with the buffered tail so words spoken
        // during the hop are transcribed; the stitcher de-dups the overlap.
        if replayTail {
            for buffer in tailBuffers { req.append(buffer) }
        }

        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        self.stitcher.commit(text)
                    } else {
                        self.stitcher.setPartial(text)
                    }
                    self.onTranscriptUpdate?()
                }
                if error != nil || (result?.isFinal ?? false) {
                    // Task ended (final, duty-cycle death, or error). Commit
                    // whatever is in flight and start a fresh task, replaying the
                    // tail so the seam loses nothing.
                    self.request = nil
                    self.task = nil
                    if self.running { self.rotate(replayTail: true) }
                }
            }
        }

        // Proactive rotation: end this task a beat before the hard limit so the
        // hop is planned (with a replay tail) rather than a surprise death.
        rotateTimer?.invalidate()
        rotateTimer = Timer.scheduledTimer(withTimeInterval: rotateAfter, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.rotateProactively() }
        }
    }

    /// Timer-driven rotation: lock in the in-flight partial, then hop with a
    /// replayed tail. Ending the old request's audio makes it finalize; we don't
    /// wait for that final (its late commit de-dups harmlessly).
    private func rotateProactively() {
        guard running else { return }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        rotate(replayTail: true)
    }

    private func rotate(replayTail: Bool) {
        rotateTimer?.invalidate()
        rotateTimer = nil
        beginTask(replayTail: replayTail)
    }
}
