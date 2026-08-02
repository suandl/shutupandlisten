// The injector's file-drive loop is impure (AVFoundation), but the arithmetic
// that decides chunk boundaries, per-chunk timestamps, and the real-time tick
// interval is pure — and tested here without a Mac. Mirrors AnalystCadence's
// "pure reducer, real coverage on Linux" pattern.

import XCTest
@testable import TurnEngine

final class FileInjectionPlanTests: XCTestCase {
    func testEvenlyDivisibleFileProducesFullChunks() {
        // 8192 frames / 2048 = exactly 4 chunks at 16 kHz.
        let plan = FileInjectionPlan(frameCount: 8192, sampleRate: 16_000, chunkFrames: 2048)
        XCTAssertEqual(plan.chunks.count, 4)
        XCTAssertEqual(plan.chunks.map(\.frameOffset), [0, 2048, 4096, 6144])
        XCTAssertTrue(plan.chunks.allSatisfy { $0.frameLength == 2048 })
    }

    func testTailChunkCarriesTheRemainder() {
        // 5000 frames / 2048 = 2 full chunks + a 904-frame tail.
        let plan = FileInjectionPlan(frameCount: 5000, sampleRate: 16_000, chunkFrames: 2048)
        XCTAssertEqual(plan.chunks.count, 3)
        XCTAssertEqual(plan.chunks.map(\.frameLength), [2048, 2048, 904])
        XCTAssertEqual(plan.chunks.last?.frameOffset, 4096)
    }

    func testPerChunkStartAndDurationInMilliseconds() {
        let plan = FileInjectionPlan(frameCount: 5000, sampleRate: 16_000, chunkFrames: 2048)
        // 2048 frames @ 16 kHz = 128 ms; chunk 1 starts at 128 ms.
        XCTAssertEqual(plan.chunks[0].startMs, 0, accuracy: 1e-6)
        XCTAssertEqual(plan.chunks[1].startMs, 128, accuracy: 1e-6)
        XCTAssertEqual(plan.chunks[0].durationMs, 128, accuracy: 1e-6)
        // Tail: 904 frames @ 16 kHz = 56.5 ms.
        XCTAssertEqual(plan.chunks[2].durationMs, 56.5, accuracy: 1e-6)
    }

    func testTickIntervalAndTotalDuration() {
        let plan = FileInjectionPlan(frameCount: 5000, sampleRate: 16_000, chunkFrames: 2048)
        // Tick paces on chunkFrames (not the tail length): 2048 / 16 kHz = 128 ms.
        XCTAssertEqual(plan.tickIntervalMs, 128, accuracy: 1e-6)
        // 5000 frames @ 16 kHz = 312.5 ms.
        XCTAssertEqual(plan.totalDurationMs, 312.5, accuracy: 1e-6)
    }

    func testEmptyFileProducesNoChunks() {
        let plan = FileInjectionPlan(frameCount: 0, sampleRate: 16_000, chunkFrames: 2048)
        XCTAssertTrue(plan.chunks.isEmpty)
        XCTAssertEqual(plan.totalDurationMs, 0, accuracy: 1e-6)
    }

    func testInvalidInputsProduceNoChunks() {
        // Non-positive chunkFrames or sampleRate can't produce a valid plan.
        XCTAssertTrue(FileInjectionPlan(frameCount: 5000, sampleRate: 16_000, chunkFrames: 0).chunks.isEmpty)
        XCTAssertTrue(FileInjectionPlan(frameCount: 5000, sampleRate: 0, chunkFrames: 2048).chunks.isEmpty)
    }
}
