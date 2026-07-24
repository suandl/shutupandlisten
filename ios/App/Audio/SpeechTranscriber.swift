// Speech-to-text: SFSpeechRecognizer fed from AudioPipeline's buffers.
//
// Prefers on-device recognition when the locale supports it (the repo's
// "off-host" economics: no per-minute cloud STT cost, and dictation stays on
// the phone). Recognition tasks have a platform duty-cycle limit, so the task
// is restarted transparently on final results and errors; committed text
// accumulates across restarts.
//
// The session transcript is one growing string. Utterance boundaries (spec
// §4b: a turn is one utterance) are anchored by character offset at turn
// start, so the gate can always see the WHOLE utterance so far — never the
// fragment since the last evaluation.

import AVFoundation
import Foundation
import Speech

final class SpeechTranscriber: NSObject {
    /// Fired on the main queue whenever the transcript changes.
    var onTranscriptUpdate: (() -> Void)?

    private let recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var running = false

    /// Text finalized by completed recognition tasks.
    private(set) var committedText = ""
    /// The in-flight partial from the current task.
    private(set) var partialText = ""
    /// Character offset into `fullText` where the current utterance began.
    private var utteranceAnchor = 0

    override init() {
        recognizer = SFSpeechRecognizer(locale: Locale.current)
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        super.init()
    }

    var fullText: String {
        committedText.isEmpty ? partialText
            : (partialText.isEmpty ? committedText : committedText + " " + partialText)
    }

    /// The whole current utterance transcribed so far (spec §4b — rules 4/5 of
    /// the gate ask "how big is this thought?", so this is anchored at turn
    /// start, not at the last evaluation).
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
        committedText = ""
        partialText = ""
        utteranceAnchor = 0
        beginTask()
    }

    func stop() {
        running = false
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
    }

    /// Audio-thread entry point, wired to AudioPipeline.onBuffer.
    func append(_ buffer: AVAudioPCMBuffer) {
        request?.append(buffer)
    }

    // ── task lifecycle ──

    private func beginTask() {
        guard running, let recognizer, recognizer.isAvailable else { return }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        request = req

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal {
                        self.commit(text)
                    } else {
                        self.partialText = text
                        self.onTranscriptUpdate?()
                    }
                }
                if error != nil || (result?.isFinal ?? false) {
                    // Task ended (final result, duty-cycle limit, or error):
                    // roll the partial into committed text and start fresh.
                    if error != nil, !self.partialText.isEmpty {
                        self.commit(self.partialText)
                    }
                    self.request = nil
                    self.task = nil
                    if self.running { self.beginTask() }
                }
            }
        }
    }

    private func commit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty {
            committedText = committedText.isEmpty ? trimmed : committedText + " " + trimmed
        }
        partialText = ""
        onTranscriptUpdate?()
    }
}
