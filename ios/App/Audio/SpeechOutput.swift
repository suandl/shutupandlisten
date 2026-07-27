// Text-to-speech: the listener's voice.
//
// The state machine models a response as holding the floor for
// `responseDurationMs`; the host estimates that duration from the reply text
// just before answering `speak`, so the machine's response window tracks the
// real clip closely. Barge-in (`speech-start` while `responding`) stops the
// synthesizer instantly — the yield must be instant (usefulness bar B2).
//
// Crucially, the audio is NOT played through AVSpeechSynthesizer's own output.
// It is synthesized to PCM buffers (`write`) and rendered through the mic's
// voice-processing engine (`TTSPlaybackSink`), so the AEC unit that captures
// the mic also renders our speech and can cancel it from the input — which is
// what makes barge-in during a response trustworthy. Playing TTS on a separate
// path would leave the echo canceller with no reference for it.

// @preconcurrency: AVFAudio marks some closure types (e.g. the AVAudioConverter
// input block) @Sendable, but we use them synchronously — convert() never lets
// the captured buffer escape — so those Sendable warnings are noise here.
@preconcurrency import AVFoundation
import Foundation

/// The engine our synthesized speech is rendered through — the same
/// voice-processing graph that captures the mic (`AudioPipeline`). Class-bound
/// so `SpeechOutput` can hold it weakly.
protocol TTSPlaybackSink: AnyObject {
    /// The format buffers must be in to schedule. `nil` until the engine runs.
    var ttsFormat: AVAudioFormat? { get }
    /// Schedule one buffer; `onComplete` fires on the main queue when it ends.
    func playTTS(_ buffer: AVAudioPCMBuffer, onComplete: @escaping @Sendable () -> Void)
    /// Instant stop + flush (barge-in).
    func stopTTS()
}

@MainActor
final class SpeechOutput {
    /// Where synthesized speech is rendered — set by the owner to the mic
    /// engine so the AEC cancels our own TTS. Weak: the owner holds both.
    weak var sink: TTSPlaybackSink?

    /// Fired on the main actor when a clip finishes rendering naturally (the
    /// host closes the machine's response window on it).
    var onFinished: (() -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    /// Bumped on every `speak`/`stop`; stale completion callbacks (from a clip
    /// that was barged-in or superseded) compare against it and drop out.
    private var epoch = 0

    /// Rough duration estimate (ms) for the state machine's response window —
    /// sized before synthesis, so it stays an estimate.
    static func estimateDurationMs(for text: String) -> Double {
        min(20_000, max(900, Double(text.count) * 60))
    }

    func speak(_ text: String) {
        guard let sink, let outFormat = sink.ttsFormat else {
            // The engine isn't running (no session) — nothing to render into.
            // Treat as an immediately-finished clip so callers don't hang.
            onFinished?()
            return
        }
        epoch &+= 1
        let myEpoch = epoch

        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        utterance.prefersAssistiveTechnologySettings = false
        if let voice = Self.preferredVoice() {
            utterance.voice = voice
        }

        // `write` delivers PCM buffers synchronously, ending with a zero-length
        // marker we skip. Collect them, then convert to the engine format and
        // schedule; the last buffer's completion is the end of the clip.
        var raw: [AVAudioPCMBuffer] = []
        synthesizer.write(utterance) { buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else { return }
            raw.append(pcm)
        }
        guard !raw.isEmpty else {
            onFinished?()
            return
        }

        var converter: AVAudioConverter?
        let lastIndex = raw.count - 1
        for (index, buffer) in raw.enumerated() {
            guard let converted = Self.convert(buffer, to: outFormat, converter: &converter) else { continue }
            let isLast = index == lastIndex
            sink.playTTS(converted) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, myEpoch == self.epoch else { return }
                    if isLast { self.onFinished?() }
                }
            }
        }
    }

    /// Instant yield — used on barge-in. Invalidates pending completions so a
    /// flushed clip's tail never reports "finished".
    func stop() {
        epoch &+= 1
        sink?.stopTTS()
    }

    private static func preferredVoice() -> AVSpeechSynthesisVoice? {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let candidates = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == language }
        // Prefer the highest-quality installed voice for the current language.
        return candidates.first { $0.quality == .premium }
            ?? candidates.first { $0.quality == .enhanced }
            ?? AVSpeechSynthesisVoice(language: language)
    }

    /// Convert a synthesized buffer into the player-node format (sample rate +
    /// layout may differ from `write`'s output). Returns the input untouched
    /// when the formats already match.
    private static func convert(
        _ input: AVAudioPCMBuffer,
        to format: AVAudioFormat,
        converter: inout AVAudioConverter?
    ) -> AVAudioPCMBuffer? {
        if input.format == format { return input }
        // All buffers from one `write` share a format, so build the converter
        // once and reuse it across the utterance's buffers.
        if converter == nil {
            converter = AVAudioConverter(from: input.format, to: format)
        }
        guard let converter else { return nil }

        let ratio = format.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }

        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return input
        }
        return error == nil ? output : nil
    }
}
