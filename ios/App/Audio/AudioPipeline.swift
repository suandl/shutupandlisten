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
    /// System events that take the mic out from under a running session. The
    /// pipeline only *reports* — the host decides whether to park, resume, or
    /// finalize, because that decision touches the turn machine and storage.
    enum Interruption {
        /// The system claimed the audio session (phone call, Siri, alarm).
        case began
        /// The interruption is over; `shouldResume` is the system's hint that
        /// taking the mic back immediately is appropriate.
        case ended(shouldResume: Bool)
        /// The active input route disappeared (`.oldDeviceUnavailable` —
        /// headphones unplugged, AirPods case shut). The session should fall
        /// back to the built-in mic, not die.
        case routeLost
        /// The media services daemon was reset: every audio object we hold is
        /// dead and the engine must be rebuilt from scratch.
        case mediaServicesReset
    }

    /// Called on the main queue with ms-since-session timestamps.
    var onSpeechStart: ((Double) -> Void)?
    var onSpeechEnd: ((Double) -> Void)?
    /// Raw buffers for the transcriber, delivered on the audio thread.
    var onBuffer: ((AVAudioPCMBuffer) -> Void)?
    /// Live input level in dBFS for the UI meter (main queue, throttled).
    var onLevel: ((Float) -> Void)?
    /// Interruption/route/reset events, delivered on the main queue while the
    /// pipeline is running. See `Interruption`.
    var onInterruption: ((Interruption) -> Void)?

    /// `var`, not `let`: a media-services reset invalidates the engine and the
    /// only correct recovery is a fresh instance (`resume(rebuild: true)`).
    private var engine = AVAudioEngine()
    private var running = false
    private var notificationObservers: [NSObjectProtocol] = []

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

    // ── optional recording sink (session audio → .m4a) ──
    // Written on the audio thread inside `process(_:)`; started/stopped on the
    // main thread — hence the lock. AVAudioFile transcodes to AAC on write
    // because it is opened with AAC settings and a `commonFormat:` processing
    // format matching the tap buffers (float32, deinterleaved).
    private let recordingLock = NSLock()
    private var recordingFile: AVAudioFile?

    private func nowMs() -> Double {
        (ProcessInfo.processInfo.systemUptime - clockOrigin) * 1000
    }

    func start(clockOrigin: TimeInterval) throws {
        guard !running else { return }
        self.clockOrigin = clockOrigin
        try activateSession()
        try startEngine()
        observeSessionNotifications()
        running = true
    }

    func stop() {
        guard running else { return }
        stopRecording() // safety net; the host normally stops recording first
        removeSessionNotificationObservers()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        inSpeech = false
        speechBufferRun = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // ── interruption handling ──

    /// Park the engine during a system interruption. The system has already
    /// silenced the session; we just pause the engine and clear per-utterance
    /// VAD state so a half-formed onset doesn't survive the gap. The tap and
    /// the recording file stay in place for `resume()`.
    func suspend() {
        guard running else { return }
        engine.pause()
        inSpeech = false
        speechBufferRun = 0
    }

    /// Take the mic back after `suspend()` or a route loss. The tap is always
    /// reinstalled against the *current* input format — after a route change
    /// (AirPods → built-in mic) the old format may be stale, and a mismatched
    /// tap is worse than a rebuilt one. Pass `rebuild: true` after a
    /// media-services reset, when the old engine instance is unusable.
    func resume(rebuild: Bool = false) throws {
        guard running else { return }
        if rebuild {
            engine = AVAudioEngine()
        } else {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        try activateSession()
        try startEngine()
        inSpeech = false
        speechBufferRun = 0
    }

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .spokenAudio,
            options: [.defaultToSpeaker, .allowBluetoothA2DP]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func startEngine() throws {
        let input = engine.inputNode
        // AEC so our own TTS never reads as thinker speech (barge-in stays honest).
        try? input.setVoiceProcessingEnabled(true)

        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.process(buffer)
        }

        engine.prepare()
        try engine.start()
    }

    /// Translate AVAudioSession notifications into `Interruption` values for
    /// the host. Observed only while running; delivered on the main queue to
    /// match the rest of the pipeline's callback contract.
    private func observeSessionNotifications() {
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        notificationObservers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }
            switch type {
            case .began:
                self?.onInterruption?(.began)
            case .ended:
                let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
                self?.onInterruption?(.ended(shouldResume: options.contains(.shouldResume)))
            @unknown default:
                break
            }
        })

        notificationObservers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: session, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                  reason == .oldDeviceUnavailable
            else { return }
            self?.onInterruption?(.routeLost)
        })

        notificationObservers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main
        ) { [weak self] _ in
            self?.onInterruption?(.mediaServicesReset)
        })
    }

    private func removeSessionNotificationObservers() {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        notificationObservers.removeAll()
    }

    // ── recording sink ──

    /// Start writing the tapped input to an AAC .m4a file at `url`. Call after
    /// `start()` so the input format is known. The session runs fine without a
    /// recording — callers may treat a throw as non-fatal.
    func startRecording(to url: URL) throws {
        let input = engine.inputNode.outputFormat(forBus: 0)
        // Mono by design (the voice-processed input node is mono); if the tap
        // ever carries a second channel we match it so the write guard in
        // `process(_:)` still passes. AAC caps out at stereo for our purposes.
        let channels = min(max(Int(input.channelCount), 1), 2)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: input.sampleRate,
            AVNumberOfChannelsKey: channels,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        // The processing format is pinned to the tap's PCM layout (float32,
        // deinterleaved, input sample rate); AVAudioFile encodes to AAC on
        // each write.
        let file = try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )
        recordingLock.lock()
        recordingFile = file
        recordingLock.unlock()
    }

    /// Close the recording file (AVAudioFile finalizes on release).
    func stopRecording() {
        recordingLock.lock()
        recordingFile = nil
        recordingLock.unlock()
    }

    // ── audio thread ──

    private func process(_ buffer: AVAudioPCMBuffer) {
        onBuffer?(buffer)

        // Recording sink: write the tap buffer straight through. Guarded by
        // the file's processing format — if the input layout ever differs
        // (e.g. a multichannel interface, or a mid-session route change that
        // moved us to a mic with another sample rate), we skip rather than
        // corrupt: the transcript keeps going even where the audio cannot.
        recordingLock.lock()
        if let file = recordingFile, file.processingFormat == buffer.format {
            try? file.write(from: buffer)
        }
        recordingLock.unlock()

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
