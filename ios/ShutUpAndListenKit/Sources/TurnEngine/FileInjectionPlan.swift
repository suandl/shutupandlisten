// The pure half of the CI audio-file injector (design: in-app audio injection).
// Given a file's frame count and sample rate, decide how to slice it into
// fixed-size chunks and at what real-time cadence to emit them. No AVFoundation
// here — the App layer (CaptureAudioInjector) copies actual PCM per these
// boundaries — so this arithmetic gets real `swift test` coverage on Linux.
//
// PURE — same inputs → same output.

import Foundation

public struct FileInjectionPlan: Equatable, Sendable {
    /// One paced emission: a half-open frame range [frameOffset, frameOffset+frameLength)
    /// plus its position/length in ms (ms are for logging/assertions; the App
    /// layer copies by frame).
    public struct Chunk: Equatable, Sendable {
        public let frameOffset: Int
        public let frameLength: Int
        public let startMs: Double
        public let durationMs: Double
    }

    public let chunks: [Chunk]
    /// Seconds-to-ms cadence between ticks — paced on `chunkFrames` so playback
    /// is real time regardless of the (shorter) tail chunk's length.
    public let tickIntervalMs: Double
    /// Whole-file duration in ms.
    public let totalDurationMs: Double

    public init(frameCount: Int, sampleRate: Double, chunkFrames: Int) {
        guard frameCount > 0, sampleRate > 0, chunkFrames > 0 else {
            self.chunks = []
            self.tickIntervalMs = 0
            self.totalDurationMs = 0
            return
        }

        let msPerFrame = 1000.0 / sampleRate
        var built: [Chunk] = []
        var offset = 0
        while offset < frameCount {
            let length = min(chunkFrames, frameCount - offset)
            built.append(Chunk(
                frameOffset: offset,
                frameLength: length,
                startMs: Double(offset) * msPerFrame,
                durationMs: Double(length) * msPerFrame
            ))
            offset += chunkFrames
        }

        self.chunks = built
        self.tickIntervalMs = Double(chunkFrames) * msPerFrame
        self.totalDurationMs = Double(frameCount) * msPerFrame
    }
}
