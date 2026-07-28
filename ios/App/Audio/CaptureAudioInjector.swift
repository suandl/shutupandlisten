// The CI-only file-drive loop (design: in-app audio injection). Reads the
// bundled fixture .wav, slices it into fixed-size float32 buffers per the pure
// FileInjectionPlan (TurnEngine), and paces them — in real time — into a sink
// wired to AudioPipeline.injectForCapture. That drives the WHOLE downstream
// chain (VAD → turn-end → gate → analyst) from real speech, with no mic and no
// virtual audio device. Compiled in but inert unless SessionController starts it
// under -captureInjectAudio.

import AVFoundation
import Foundation
import TurnEngine

final class CaptureAudioInjector {
    /// Frames per emitted chunk — matches the mic tap's 2048 bufferSize so
    /// SFSpeech/VAD see the same granularity they do live.
    private let chunkFrames = 2048

    /// Called on the injector's serial queue with each paced buffer.
    private let onChunk: (AVAudioPCMBuffer) -> Void
    /// Fired on the main queue when the fixture reaches EOF (session stays live).
    var onFinished: (() -> Void)?

    private let queue = DispatchQueue(label: "sh.shutupandlisten.capture.injector")
    private var timer: DispatchSourceTimer?
    private var buffers: [AVAudioPCMBuffer] = []
    private var index = 0

    init(onChunk: @escaping (AVAudioPCMBuffer) -> Void) {
        self.onChunk = onChunk
    }

    /// Load + slice the fixture and begin pacing. No-op (calls `onFinished`) if
    /// the file is missing or unreadable — the seed-paint watchdog is the net.
    func start() {
        // Reset per-run state so a reused instance replays from the top.
        index = 0
        buffers = []

        guard let url = Bundle.main.url(forResource: "demo-conversation", withExtension: "wav"),
              let file = try? AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        else {
            DispatchQueue.main.async { self.onFinished?() }
            return
        }

        let format = file.processingFormat // float32, deinterleaved, file's sample rate
        let frameCount = AVAudioFrameCount(file.length)
        guard frameCount > 0,
              let full = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
              (try? file.read(into: full)) != nil,
              full.floatChannelData != nil
        else {
            DispatchQueue.main.async { self.onFinished?() }
            return
        }

        let plan = FileInjectionPlan(
            frameCount: Int(full.frameLength),
            sampleRate: format.sampleRate,
            chunkFrames: chunkFrames
        )
        buffers = plan.chunks.compactMap { slice(full, offset: $0.frameOffset, length: $0.frameLength) }
        guard !buffers.isEmpty else {
            DispatchQueue.main.async { self.onFinished?() }
            return
        }

        // Arm the timer ON `queue` so the `timer` property is only ever touched
        // there — `stop()` (called from the main actor AND from `tick()` on EOF)
        // mutates it on the same queue, so the two can't race. `buffers`/`index`
        // are written above before this async block, so the serial queue orders
        // those writes before any tick. Cancelling any prior timer here keeps a
        // reused instance safe.
        let interval = plan.tickIntervalMs / 1000.0
        queue.async { [weak self] in
            guard let self else { return }
            self.timer?.cancel()
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now() + interval, repeating: interval)
            t.setEventHandler { [weak self] in self?.tick() }
            self.timer = t
            t.resume()
        }
    }

    /// Stop pacing (idempotent). Timer mutation is confined to `queue`, so this
    /// is safe to call from the main actor (stopSession) while `tick()` may be
    /// firing on `queue`. Called by SessionController.stopSession and on EOF.
    func stop() {
        queue.async { [weak self] in
            self?.timer?.cancel()
            self?.timer = nil
        }
    }

    private func tick() {
        guard index < buffers.count else {
            stop()
            DispatchQueue.main.async { self.onFinished?() }
            return
        }
        let buffer = buffers[index]
        index += 1
        onChunk(buffer)
    }

    /// Copy `length` frames from `source[offset...]` into a fresh mono float32
    /// buffer so each chunk owns its storage (the source buffer outlives the run
    /// but slices are handed off across the timer queue).
    private func slice(_ source: AVAudioPCMBuffer, offset: Int, length: Int) -> AVAudioPCMBuffer? {
        guard length > 0,
              let out = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: AVAudioFrameCount(length)),
              let src = source.floatChannelData?[0],
              let dst = out.floatChannelData?[0]
        else { return nil }
        dst.update(from: src + offset, count: length)
        out.frameLength = AVAudioFrameCount(length)
        return out
    }
}
