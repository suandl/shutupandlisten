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
// the captured buffer escape — so those Sendable warnings are noise here. It
// also covers the one buffer we hand from `write`'s callback to the main queue:
// the synthesizer gives it up when the callback returns and only the main queue
// touches it afterwards, so it is never shared, only moved (see `speak`).
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
    /// Bumped on every `speak`/`stop`; stale buffers and completion callbacks
    /// (from a clip that was barged-in or superseded) compare against it and
    /// drop out.
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

        // Nothing to say: `write` would carry no audio, so no buffer completion
        // could ever close the clip. Close it here instead of waiting.
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            onFinished?()
            return
        }

        // Abandon whatever was still being synthesized. The epoch bump already
        // invalidates the previous clip, but synthesis runs on the synthesizer's
        // own queue and this utterance would otherwise be rendered behind it —
        // a reply that arrives late is a yield that wasn't instant (bar B2).
        _ = synthesizer.stopSpeaking(at: .immediate)

        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        utterance.prefersAssistiveTechnologySettings = false
        if let voice = Self.preferredVoice() {
            utterance.voice = voice
        }

        // `write` is ASYNCHRONOUS: it returns before synthesis has produced
        // anything, then delivers PCM buffers on the synthesizer's own queue as
        // they are rendered, ending with a zero-length marker buffer. A clip can
        // therefore only be assembled from inside this callback — collecting
        // into an array and reading it on the next line finds it empty, and the
        // listener never speaks. The zero-length marker exists precisely because
        // the stream is open-ended: it is the only in-band "synthesis is over".
        let clip = SpeechClip(epoch: myEpoch, format: outFormat)
        synthesizer.write(utterance) { [weak self] buffer in
            // Hop to the main queue — where every other pipeline callback lands
            // — rather than into an unstructured Task: buffers must reach the
            // player node in synthesis order or the speech comes out scrambled,
            // and the main queue preserves that order where `Task` does not.
            // The hop also puts the converter and the clip's counters on a
            // single thread, so there is no state shared with the synthesizer.
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.schedule(buffer, for: clip)
                }
            }
        }
    }

    /// Render one buffer of the in-flight clip, on the main actor.
    private func schedule(_ buffer: AVAudioBuffer, for clip: SpeechClip) {
        // Synthesis outlives a barge-in: buffers for a stopped or superseded
        // clip keep arriving for a while, and speaking them would talk over the
        // thinker we just yielded to.
        guard clip.epoch == epoch, !clip.reported else { return }
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }

        // The zero-length marker closes the buffer set — only now is "the last
        // buffer of this clip" a knowable thing.
        guard pcm.frameLength > 0 else {
            clip.sawEndMarker = true
            reportFinishedIfDone(clip)
            return
        }

        guard let sink,
              let converted = Self.convert(pcm, to: clip.format, converter: &clip.converter)
        else { return }

        clip.scheduled += 1
        sink.playTTS(converted) { [weak self] in
            MainActor.assumeIsolated {
                clip.completed += 1
                self?.reportFinishedIfDone(clip)
            }
        }
    }

    /// A clip is over when synthesis has stopped (marker seen) *and* every
    /// buffer we scheduled has finished rendering. The host closes the machine's
    /// response window on this, so it has to mean "the room is quiet again", not
    /// "we ran out of buffers to hand over". Firing on the marker alone would
    /// end the response while the tail is still audible.
    ///
    /// The degenerate clip — marker only, or nothing convertible — satisfies
    /// this immediately (0 completed of 0 scheduled), so callers never hang on
    /// an utterance that produced no audio.
    private func reportFinishedIfDone(_ clip: SpeechClip) {
        guard clip.epoch == epoch, !clip.reported else { return }
        guard clip.sawEndMarker, clip.completed >= clip.scheduled else { return }
        clip.reported = true
        onFinished?()
    }

    /// Instant yield — used on barge-in. Invalidates the in-flight clip so its
    /// still-arriving buffers are dropped and its tail never reports "finished",
    /// and halts synthesis so we stop rendering audio nobody will hear.
    func stop() {
        epoch &+= 1
        _ = synthesizer.stopSpeaking(at: .immediate)
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

/// One utterance's in-flight state. `write` hands buffers over one at a time
/// with no count up front (see `speak`), so the end of a clip is *derived*: the
/// zero-length marker closes the set, and the clip is done once every buffer
/// scheduled before it has finished rendering.
///
/// Main-actor isolated — which is also what makes it `Sendable`, so the
/// synthesizer's callback can carry it across to the main queue.
@MainActor
private final class SpeechClip {
    /// The `SpeechOutput.epoch` this clip was born under. A mismatch means it
    /// was barged-in or superseded, and everything still arriving for it is stale.
    let epoch: Int
    /// The player-node format, captured when the clip started so a mid-clip
    /// engine rebuild can't retarget buffers already in flight.
    let format: AVAudioFormat
    /// Built on the first real buffer and reused for the rest — all buffers from
    /// one `write` share a format. Main-actor only, like the counters.
    var converter: AVAudioConverter?
    /// Buffers handed to the sink, and buffers the sink has finished rendering.
    var scheduled = 0
    var completed = 0
    /// Seen the zero-length buffer that terminates `write`'s stream.
    var sawEndMarker = false
    /// `onFinished` already fired — a clip reports its end exactly once.
    var reported = false

    init(epoch: Int, format: AVAudioFormat) {
        self.epoch = epoch
        self.format = format
    }
}
