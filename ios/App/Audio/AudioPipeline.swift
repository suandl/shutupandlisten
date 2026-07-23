// The microphone adapter: one AVAudioEngine feeding two consumers —
// an energy-based VAD (speech-start/speech-end events for the TurnDetector)
// and the SFSpeechRecognizer transcriber (raw buffers).
//
// This is the iOS analog of web/src/vad.ts: it translates audio into the
// InputEvent stream the pure state machine consumes, and is deliberately the
// ONLY place that touches the microphone. The VAD here is an adaptive RMS
// energy detector rather than a Silero port — a v1 substitution, noted, whose
// hangover mirrors the web VAD's redemption-frames default (~380 ms). Because
// the state machine's patience floor sits on top (seconds), sub-100ms VAD
// jitter does not move product behaviour.
//
// Echo: voice processing (AEC) is enabled on the input node so the companion's
// own TTS is cancelled from the mic path — which is what makes barge-in
// detection during a response trustworthy.

import AVFoundation
import Foundation

final class AudioPipeline {
    /// Called on the main queue with ms-since-session timestamps.
    var onSpeechStart: ((Double) -> Void)?
    var onSpeechEnd: ((Double) -> Void)?
    /// Raw buffers for the transcriber, delivered on the audio thread.
    var onBuffer: ((AVAudioPCMBuffer) -> Void)?
    /// Live input level in dBFS for the UI meter (main queue, throttled).
    var onLevel: ((Float) -> Void)?

    private let engine = AVAudioEngine()
    private var running = false

    // ── VAD tuning (see header note) ──
    /// Speech must exceed the noise floor by this margin to count as onset.
    private let onsetMarginDb: Float = 10
    /// Absolute floor below which nothing counts as speech, however quiet the room.
    private let absoluteFloorDb: Float = -52
    /// Consecutive speech buffers required before onset fires (~3 × 43 ms).
    private let minSpeechBuffers = 3
    /// Silence tolerated before speech-end — the web VAD's redemption window.
    private let hangoverMs: Double = 380

    private var noiseFloorDb: Float = -50
    private var speechBufferRun = 0
    private var inSpeech = false
    private var lastVoiceMs: Double = 0
    private var clockOrigin: TimeInterval = 0

    private func nowMs() -> Double {
        (ProcessInfo.processInfo.systemUptime - clockOrigin) * 1000
    }

    func start(clockOrigin: TimeInterval) throws {
        guard !running else { return }
        self.clockOrigin = clockOrigin

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .spokenAudio,
            options: [.defaultToSpeaker, .allowBluetoothA2DP]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let input = engine.inputNode
        // AEC so our own TTS never reads as thinker speech (barge-in stays honest).
        try? input.setVoiceProcessingEnabled(true)

        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.process(buffer)
        }

        engine.prepare()
        try engine.start()
        running = true
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        inSpeech = false
        speechBufferRun = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // ── audio thread ──

    private func process(_ buffer: AVAudioPCMBuffer) {
        onBuffer?(buffer)

        guard let channel = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }

        var sum: Float = 0
        for i in 0..<n { sum += channel[i] * channel[i] }
        let rms = (sum / Float(n)).squareRoot()
        let db = 20 * log10(max(rms, 1e-9))

        let t = nowMs()
        let threshold = max(noiseFloorDb + onsetMarginDb, absoluteFloorDb)
        let voiced = db > threshold

        if voiced {
            lastVoiceMs = t
            speechBufferRun += 1
            if !inSpeech && speechBufferRun >= minSpeechBuffers {
                inSpeech = true
                DispatchQueue.main.async { self.onSpeechStart?(t) }
            }
        } else {
            speechBufferRun = 0
            // Adapt the noise floor only from non-speech audio, slowly.
            noiseFloorDb = 0.95 * noiseFloorDb + 0.05 * max(db, -70)
            if inSpeech && (t - lastVoiceMs) >= hangoverMs {
                inSpeech = false
                DispatchQueue.main.async { self.onSpeechEnd?(t) }
            }
        }

        let level = db
        DispatchQueue.main.async { self.onLevel?(level) }
    }
}
