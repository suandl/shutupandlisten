// Text-to-speech: the listener's voice.
//
// The state machine models a response as holding the floor for
// `responseDurationMs`; the host estimates that duration from the reply text
// just before answering `speak`, so the machine's response window tracks the
// real clip closely. Barge-in (`speech-start` while `responding`) stops the
// synthesizer instantly — the yield must be instant (usefulness bar B2).

import AVFoundation
import Foundation

final class SpeechOutput: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    var onFinished: (() -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Rough duration estimate (ms) for the state machine's response window.
    static func estimateDurationMs(for text: String) -> Double {
        min(20_000, max(900, Double(text.count) * 60))
    }

    func speak(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        utterance.prefersAssistiveTechnologySettings = false
        if let voice = Self.preferredVoice() {
            utterance.voice = voice
        }
        synthesizer.speak(utterance)
    }

    /// Instant yield — used on barge-in.
    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    var isSpeaking: Bool { synthesizer.isSpeaking }

    private static func preferredVoice() -> AVSpeechSynthesisVoice? {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let candidates = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == language }
        // Prefer the highest-quality installed voice for the current language.
        return candidates.first { $0.quality == .premium }
            ?? candidates.first { $0.quality == .enhanced }
            ?? AVSpeechSynthesisVoice(language: language)
    }

    // MARK: AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onFinished?() }
    }

    /// `stop()` ends the clip via cancellation, not completion — the
    /// synthesizer reports that as `didCancel`, never `didFinish`. Treat it
    /// as finished all the same, so the host's floor bookkeeping (listener
    /// segment close, response-window tick) can never be skipped by a cut
    /// clip. The host's close path is idempotent, so the barge-in handler
    /// having already closed the segment is fine.
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onFinished?() }
    }
}
