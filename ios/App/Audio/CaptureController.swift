// The audio front end: one AVAudioEngine, one canonical stream, one clock —
// the CaptureController of the transcript-core rewrite (docs/plans/
// 2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, "CaptureController"
// section + R1). Replaces AudioPipeline.
//
// Three jobs, all in service of premise 1 — "the app listens reliably":
//
// CANONICAL STREAM. The mic tap's format is whatever the hardware and route
// give us; ONE persistent AVAudioConverter turns it into the session's
// canonical PCM format — which IS the analyzer's
// `SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])`,
// queried once by the engine layer and handed to `start()`, fixed for the
// whole session. The converted stream fans out to three consumers with no
// second resampler: (a) an AsyncStream of buffers for the transcription
// engine, (b) the CAF recording sink, (c) the RMS VAD. A route/configuration
// change rebuilds the converter and tap only; the downstream formats never
// change mid-session.
//
// FED-SAMPLES CLOCK. The canonical timeline is recorded-audio position:
// cumulative canonical samples delivered downstream ÷ sample rate. `audioNow`
// exposes it; `audioTime(atWallMs:)` maps the detector's wall clock into it
// via an anchor updated every time samples flow. During an interruption no
// samples flow, so audio time pauses with the file — replay stays in sync
// across gaps by construction (plan Key Decisions). VAD events carry BOTH
// wall-clock ms (the detector's clock, unchanged) and canonical audio seconds
// (how the host stamps turn boundaries for the store).
//
// RELIABILITY. The observer set from the plan: session interruption (pause;
// `.ended` + `.shouldResume` → attempt resume), route change (rebuild
// converter + tap), `AVAudioEngineConfigurationChange` (the event that
// actually stops the engine: remove tap, re-query formats, rebuild, restart),
// media-services reset (full session + engine + voice-processing rebuild),
// and `didBecomeActive` + a short-backoff retry timer (`.shouldResume` is not
// reliably delivered while backgrounded). Paused is the truthful default:
// after a resume attempt the state stays `.resuming` until samples actually
// flow again — resume is proven, not assumed (R1.2).
//
// The VAD is the old pipeline's adaptive-RMS detector, verbatim, now running
// on canonical buffers. Voice processing (AEC) is enabled BEFORE
// `engine.start()` with the failure surfaced, not `try?`-swallowed — barge-in
// honesty outranks the recognition-quality cost (R1.3), and it is re-applied
// after a media-services reset.
//
// Recording is AAC-in-CAF during the session because MPEG-4 finalizes its
// `moov` atom on close — a crash mid-session leaves an unplayable .m4a, while
// CAF is append-safe and readable after abrupt termination. Graceful stop
// remuxes CAF → .m4a via `remux(caf:to:)` (an offline AVAudioFile read/write
// loop, safe with no session active).

import AVFoundation
import Foundation
import UIKit

final class CaptureController {
    /// Truthful capture state for the UI (R1.2). `resuming` means a resume was
    /// attempted but samples have not flowed yet; only flowing audio proves
    /// `running`.
    enum State: String, Equatable {
        case idle, running, paused, resuming
    }

    enum CaptureError: LocalizedError {
        case converterUnavailable
        case notStarted
        case unsupportedCanonicalFormat

        var errorDescription: String? {
            switch self {
            case .converterUnavailable:
                return "The microphone's audio format could not be converted for transcription."
            case .notStarted:
                return "The capture session is not running."
            case .unsupportedCanonicalFormat:
                return "The transcription engine requested an audio format this device cannot analyze for speech."
            }
        }
    }

    // ── callbacks (all delivered on the main queue) ──

    /// VAD events with both clocks: wall ms (the detector's timeline, same
    /// shape as before) and canonical audio seconds (the store's timeline).
    var onSpeechStart: ((_ wallMs: Double, _ audioTime: TimeInterval) -> Void)?
    var onSpeechEnd: ((_ wallMs: Double, _ audioTime: TimeInterval) -> Void)?
    /// Live input level in dBFS for the UI meter.
    var onLevel: ((Float) -> Void)?
    /// Capture state transitions (running / paused / resuming) for truthful UI.
    var onState: ((State) -> Void)?
    /// Non-fatal reliability failures worth telling the user about.
    var onError: ((String) -> Void)?

    private(set) var state: State = .idle // main-thread only

    private var engine = AVAudioEngine()
    private var canonicalFormat: AVAudioFormat?
    private var clockOrigin: TimeInterval = 0
    private var running = false

    /// The analyzer's buffer stream (fan-out consumer (a)). Read on the audio
    /// thread, finished/nilled on the main thread (`finishBuffers`/`stop`) —
    /// hence the lock, same discipline as converter/recordingFile.
    private let bufferLock = NSLock()
    private var bufferContinuation: AsyncStream<AVAudioPCMBuffer>.Continuation?

    /// The one persistent converter: tap format → canonical format. Rebuilt on
    /// route/configuration change (on the main queue) while the audio thread
    /// reads it — hence the lock.
    private let converterLock = NSLock()
    private var converter: AVAudioConverter?

    // ── fed-samples clock (written on the audio thread, read anywhere) ──
    private let clockLock = NSLock()
    private var fedSamples: Int64 = 0
    /// audioNow at the last buffer, and the wall ms it landed — the stored
    /// wall ↔ audio mapping.
    private var anchorAudio: TimeInterval = 0
    private var anchorWallMs: Double = 0
    /// Set by a resume attempt; the next buffer that flows clears it and
    /// promotes the state to `.running` — proof, not assumption.
    private var proveResumeOnNextBuffer = false

    // ── VAD tuning + state (audio thread only; ported verbatim from AudioPipeline) ──
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

    // ── recording sink (canonical stream → AAC-in-CAF) ──
    private let recordingLock = NSLock()
    private var recordingFile: AVAudioFile?
    /// Buffers skipped by the write guard below (canonical layout ≠ file's
    /// processing format — should be impossible, the format is fixed at
    /// start). Counted so the failure surfaces ONCE via onError instead of
    /// per-buffer spam or a silently shorter file. Guarded by recordingLock.
    private var recordingFormatMismatches = 0

    // ── observers + resume retry ──
    private var observers: [NSObjectProtocol] = []
    private var resumeRetryTimer: Timer?
    private var resumeBackoff: TimeInterval = 1

    private func nowMs() -> Double {
        (ProcessInfo.processInfo.systemUptime - clockOrigin) * 1000
    }

    // ── lifecycle ──

    /// Start capture. `canonicalFormat` is the analyzer's best available
    /// format, queried by the engine layer at session start and fixed for the
    /// session; this controller owns the converter into it. When
    /// `recordingURL` is set, the CAF recording file is opened BEFORE the tap
    /// installs, so the first counted/fed buffer is also the first written one
    /// — stored timings and the file agree from sample zero. The recording is
    /// best-effort (`isRecording` tells the host whether it opened); capture
    /// itself failing throws. Returns the canonical buffer stream for the
    /// transcription engine (single consumer).
    func start(
        canonicalFormat: AVAudioFormat,
        clockOrigin: TimeInterval,
        recordingTo recordingURL: URL? = nil
    ) throws -> AsyncStream<AVAudioPCMBuffer> {
        precondition(!running, "capture already running")
        // The VAD reads float32 or int16 samples; anything else would run the
        // session DEAF (no speech events, ever) — refuse up front instead.
        guard canonicalFormat.commonFormat == .pcmFormatFloat32
            || canonicalFormat.commonFormat == .pcmFormatInt16
        else {
            throw CaptureError.unsupportedCanonicalFormat
        }
        self.canonicalFormat = canonicalFormat
        self.clockOrigin = clockOrigin

        clockLock.lock()
        fedSamples = 0
        anchorAudio = 0
        anchorWallMs = 0
        proveResumeOnNextBuffer = false
        clockLock.unlock()
        // VAD state resets live HERE (not in stop): this runs before the tap
        // exists, so no audio-thread write can race them.
        inSpeech = false
        speechBufferRun = 0
        noiseFloorDb = -50
        lastVoiceMs = 0
        resumeBackoff = 1
        recordingLock.lock()
        recordingFormatMismatches = 0
        recordingLock.unlock()

        // Recording first (best-effort — the session runs without one), then
        // the tap: the analyzer stream, the clock, and the file all start from
        // the same first buffer.
        if let recordingURL {
            do {
                try openRecordingFile(at: recordingURL)
            } catch {
                onError?("The session audio could not be recorded: \(error.localizedDescription)")
            }
        }

        let (stream, continuation) = AsyncStream.makeStream(of: AVAudioPCMBuffer.self)
        bufferLock.lock()
        bufferContinuation = continuation
        bufferLock.unlock()

        do {
            try configureSession()
            // AEC before engine.start(), failure SURFACED (R1.3): our own TTS
            // must never read as thinker speech, or barge-in detection lies.
            try engine.inputNode.setVoiceProcessingEnabled(true)
            try installConverterAndTap()
            engine.prepare()
            try engine.start()
        } catch {
            finishBuffers()
            stopRecording()
            engine.inputNode.removeTap(onBus: 0)
            throw error
        }
        installObservers()
        running = true
        setState(.running)
        return stream
    }

    /// End the analyzer's buffer stream WITHOUT stopping capture. The stop
    /// path calls this before `engine.stopAndFinalize()` so the engine's feed
    /// task drains every queued buffer and finishes naturally — no cancelled
    /// mid-stream buffers (the tail of the session) dropped on the floor.
    /// Idempotent; `stop()` calls it as a safety net.
    func finishBuffers() {
        bufferLock.lock()
        bufferContinuation?.finish()
        bufferContinuation = nil
        bufferLock.unlock()
    }

    func stop() {
        guard running else { return }
        running = false
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        resumeRetryTimer?.invalidate()
        resumeRetryTimer = nil
        stopRecording() // safety net; the host normally stops recording first
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        finishBuffers()
        converterLock.lock()
        converter = nil
        converterLock.unlock()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        setState(.idle)
    }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        // Built-in mic, A2DP output only (plan Key Decisions: the AirPods mic
        // would force HFP's narrow-band input and visibly cost transcription).
        try session.setCategory(
            .playAndRecord,
            mode: .spokenAudio,
            options: [.defaultToSpeaker, .allowBluetoothA2DP]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    /// (Re)build the persistent converter for the CURRENT tap format and
    /// (re)install the tap. The canonical side never changes mid-session.
    private func installConverterAndTap() throws {
        guard let canonicalFormat else { throw CaptureError.notStarted }
        let input = engine.inputNode
        let tapFormat = input.outputFormat(forBus: 0)
        guard let newConverter = AVAudioConverter(from: tapFormat, to: canonicalFormat) else {
            throw CaptureError.converterUnavailable
        }
        converterLock.lock()
        converter = newConverter
        converterLock.unlock()
        input.installTap(onBus: 0, bufferSize: 2048, format: tapFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }
    }

    // ── the fed-samples clock ──

    /// Seconds of canonical audio actually delivered downstream — the
    /// canonical timeline's "now". Pauses during interruptions (no samples
    /// flow), which is exactly what keeps segment times file-relative.
    var audioNow: TimeInterval {
        clockLock.lock()
        defer { clockLock.unlock() }
        return anchorAudio
    }

    /// Map a wall-clock timestamp (detector ms) onto the canonical timeline
    /// using the stored anchor. Clamped to [0, audioNow]: a wall time that
    /// falls in a gap (no samples flowing) maps to the position where the
    /// file stopped growing.
    func audioTime(atWallMs wallMs: Double) -> TimeInterval {
        clockLock.lock()
        defer { clockLock.unlock() }
        let mapped = anchorAudio + (wallMs - anchorWallMs) / 1000
        return min(max(0, mapped), anchorAudio)
    }

    // ── recording sink ──

    /// Whether the recording sink is writing (the CAF opened at `start`).
    var isRecording: Bool {
        recordingLock.lock()
        defer { recordingLock.unlock() }
        return recordingFile != nil
    }

    /// Open the AAC-in-CAF recording sink at `url`. Called by `start()` BEFORE
    /// the tap installs (the first fed buffer must be the first written one);
    /// the session runs fine without a recording — `start` treats a throw as
    /// non-fatal.
    private func openRecordingFile(at url: URL) throws {
        guard let canonicalFormat else { throw CaptureError.notStarted }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: canonicalFormat.sampleRate,
            AVNumberOfChannelsKey: Int(canonicalFormat.channelCount),
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        // The container comes from the .caf extension; the processing format
        // is pinned to the canonical stream so the write guard below holds.
        let file = try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: canonicalFormat.commonFormat,
            interleaved: canonicalFormat.isInterleaved
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

    /// Offline CAF → .m4a remux (decode + AAC re-encode via an AVAudioFile
    /// read/write loop — no AVAudioSession needed, so it is safe after the
    /// capture session has been torn down, and during launch recovery in
    /// Phase 4). Used at graceful stop; the CAF stays the crash-safe original
    /// until this succeeds.
    static func remux(caf source: URL, to destination: URL) throws {
        let input = try AVAudioFile(forReading: source)
        let format = input.processingFormat
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: Int(format.channelCount),
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        let output = try AVAudioFile(
            forWriting: destination,
            settings: settings,
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved
        )
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 32768) else {
            throw CaptureError.converterUnavailable
        }
        while input.framePosition < input.length {
            try input.read(into: buffer)
            guard buffer.frameLength > 0 else { break }
            try output.write(from: buffer)
        }
    }

    // ── audio thread ──

    private func process(_ tapBuffer: AVAudioPCMBuffer) {
        guard let canonical = convert(tapBuffer), canonical.frameLength > 0 else { return }
        let wallMs = nowMs()

        // Advance the fed-samples clock and refresh the wall anchor: this
        // buffer IS about to be fed everywhere, so it is fed audio.
        clockLock.lock()
        fedSamples += Int64(canonical.frameLength)
        anchorAudio = Double(fedSamples) / canonical.format.sampleRate
        anchorWallMs = wallMs
        let audioTime = anchorAudio
        let prove = proveResumeOnNextBuffer
        proveResumeOnNextBuffer = false
        clockLock.unlock()
        if prove {
            // Samples are flowing again — NOW the resume is proven (R1.2).
            DispatchQueue.main.async { [weak self] in self?.setState(.running) }
        }

        // (a) the analyzer's stream (continuation read under the lock — the
        // main thread finishes/nils it in finishBuffers/stop).
        bufferLock.lock()
        let continuation = bufferContinuation
        bufferLock.unlock()
        continuation?.yield(canonical)

        // (b) the recording sink, format-guarded: if the canonical layout ever
        // differs from the file's processing format, skip rather than corrupt —
        // but COUNT the skip and tell the user once (a silently shorter
        // recording is a lie about what was captured).
        recordingLock.lock()
        var reportMismatch = false
        if let file = recordingFile {
            if file.processingFormat == canonical.format {
                try? file.write(from: canonical)
            } else {
                recordingFormatMismatches += 1
                reportMismatch = recordingFormatMismatches == 1
            }
        }
        recordingLock.unlock()
        if reportMismatch {
            DispatchQueue.main.async { [weak self] in
                self?.onError?(
                    "The session audio recording is incomplete: the microphone "
                        + "stream stopped matching the recording file's format."
                )
            }
        }

        // (c) the VAD.
        runVAD(on: canonical, wallMs: wallMs, audioTime: audioTime)
    }

    /// One buffer through the persistent converter. `.noDataNow` after the
    /// single input keeps the converter's internal resampler state across
    /// calls — that is what makes it ONE stateful converter, not per-buffer
    /// conversions.
    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        converterLock.lock()
        let converter = self.converter
        converterLock.unlock()
        guard let converter, let canonicalFormat else { return nil }

        let ratio = canonicalFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: canonicalFormat, frameCapacity: capacity) else {
            return nil
        }
        var fed = false
        var conversionError: NSError?
        let status = converter.convert(to: out, error: &conversionError) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error else { return nil }
        return out
    }

    /// The adaptive-RMS VAD, verbatim from the old pipeline, now on canonical
    /// buffers. Events are stamped with both clocks (see header). Reads
    /// float32 or int16 samples — the two layouts `start()` admits; the
    /// canonical format is the analyzer's choice, not ours, and a VAD that
    /// only spoke float32 would go silently deaf on an int16 session.
    private func runVAD(on buffer: AVAudioPCMBuffer, wallMs: Double, audioTime: TimeInterval) {
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }

        var sum: Float = 0
        if let channel = buffer.floatChannelData?[0] {
            for i in 0..<n { sum += channel[i] * channel[i] }
        } else if let channel = buffer.int16ChannelData?[0] {
            let scale = 1 / Float(Int16.max)
            for i in 0..<n {
                let sample = Float(channel[i]) * scale
                sum += sample * sample
            }
        } else {
            return // unreachable: start() refused any other common format
        }
        let rms = (sum / Float(n)).squareRoot()
        let db = 20 * log10(max(rms, 1e-9))

        let threshold = max(noiseFloorDb + onsetMarginDb, absoluteFloorDb)
        let voiced = db > threshold

        if voiced {
            lastVoiceMs = wallMs
            speechBufferRun += 1
            if !inSpeech && speechBufferRun >= minSpeechBuffers {
                inSpeech = true
                DispatchQueue.main.async { [weak self] in
                    self?.onSpeechStart?(wallMs, audioTime)
                }
            }
        } else {
            speechBufferRun = 0
            // Adapt the noise floor only from non-speech audio, slowly.
            noiseFloorDb = 0.95 * noiseFloorDb + 0.05 * max(db, -70)
            if inSpeech && (wallMs - lastVoiceMs) >= hangoverMs {
                inSpeech = false
                DispatchQueue.main.async { [weak self] in
                    self?.onSpeechEnd?(wallMs, audioTime)
                }
            }
        }

        DispatchQueue.main.async { [weak self] in self?.onLevel?(db) }
    }

    // ── reliability observers (all delivered on the main queue) ──

    private func installObservers() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            self?.handleInterruption(note)
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.handleRouteChange()
        })
        observers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main
        ) { [weak self] note in
            self?.handleConfigurationChange(note)
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.handleMediaServicesReset()
        })
        // `.shouldResume` is not reliably delivered while backgrounded —
        // foregrounding is the other resume trigger (plan observer set).
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self, self.running, self.state == .paused else { return }
            self.attemptResume()
        })
    }

    private func handleInterruption(_ note: Notification) {
        guard running else { return }
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        switch type {
        case .began:
            pause()
        case .ended:
            let rawOptions = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            if AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume) {
                attemptResume()
            } else {
                scheduleResumeRetry()
            }
        @unknown default:
            break
        }
    }

    /// A phone call, Siri, an alarm: the system stopped our audio. Paused is
    /// the truthful default until samples flow again; while no samples flow
    /// the fed-samples clock (and the recording) pause with us.
    private func pause() {
        guard state == .running || state == .resuming else { return }
        engine.pause()
        setState(.paused)
        scheduleResumeRetry()
    }

    private func attemptResume() {
        guard running, state == .paused || state == .resuming else { return }
        setState(.resuming)
        do {
            try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
            if !engine.isRunning {
                engine.prepare()
                try engine.start()
            }
            // Not `.running` yet: the next flowing buffer proves it.
            clockLock.lock()
            proveResumeOnNextBuffer = true
            clockLock.unlock()
            resumeBackoff = 1
            resumeRetryTimer?.invalidate()
            resumeRetryTimer = nil
        } catch {
            setState(.paused)
            scheduleResumeRetry()
        }
    }

    /// Short-backoff retries while paused (1 s doubling to 8 s): attempts
    /// during a still-held interruption fail harmlessly and the first attempt
    /// after it lifts succeeds — cheaper and more robust than trusting the
    /// `.ended` notification alone.
    private func scheduleResumeRetry() {
        guard running else { return }
        resumeRetryTimer?.invalidate()
        resumeRetryTimer = Timer.scheduledTimer(
            withTimeInterval: resumeBackoff, repeats: false
        ) { [weak self] _ in
            guard let self, self.running, self.state == .paused else { return }
            self.attemptResume()
        }
        resumeBackoff = min(resumeBackoff * 2, 8)
    }

    /// AirPods connect/disconnect, speaker ↔ receiver: the input format may
    /// have changed under the tap. Rebuild the converter + tap; the canonical
    /// side (and everything downstream) is untouched.
    private func handleRouteChange() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        do {
            try installConverterAndTap()
        } catch {
            onError?("The microphone route changed and could not be rebuilt: \(error.localizedDescription)")
            setState(.paused)
            scheduleResumeRetry()
        }
    }

    /// The event that actually stops the engine on a configuration change:
    /// remove the tap, re-query formats, rebuild the converter, reinstall,
    /// restart.
    private func handleConfigurationChange(_ note: Notification) {
        guard running, (note.object as? AVAudioEngine) === engine else { return }
        guard state != .paused else { return } // the interruption path owns resume
        engine.inputNode.removeTap(onBus: 0)
        do {
            try installConverterAndTap()
            if !engine.isRunning {
                engine.prepare()
                try engine.start()
            }
            clockLock.lock()
            proveResumeOnNextBuffer = true
            clockLock.unlock()
            if state == .running { setState(.resuming) }
        } catch {
            setState(.paused)
            scheduleResumeRetry()
        }
    }

    /// The audio daemon died: everything we held is invalid. Full rebuild —
    /// session, engine, voice processing (AEC must be re-applied, R1.3),
    /// converter, tap.
    private func handleMediaServicesReset() {
        guard running else { return }
        setState(.resuming)
        engine = AVAudioEngine()
        do {
            try configureSession()
            try engine.inputNode.setVoiceProcessingEnabled(true)
            try installConverterAndTap()
            engine.prepare()
            try engine.start()
            clockLock.lock()
            proveResumeOnNextBuffer = true
            clockLock.unlock()
        } catch {
            onError?("The audio system reset and could not be rebuilt: \(error.localizedDescription)")
            setState(.paused)
            scheduleResumeRetry()
        }
    }

    // main-thread only
    private func setState(_ newState: State) {
        guard state != newState else { return }
        state = newState
        onState?(newState)
    }
}
