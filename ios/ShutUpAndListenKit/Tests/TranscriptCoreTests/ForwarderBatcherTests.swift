// ForwarderBatcher contract tests (plan R4.3, Phase 5): finals accumulate and
// flush on a tick, volatile text never enters a batch, empty ticks emit
// nothing, batch indices stay monotonic, and session end flushes the tail.

import XCTest
@testable import TranscriptCore
import TurnEngine

final class ForwarderBatcherTests: XCTestCase {
    private func segment(
        text: String,
        state: TranscriptSegment.State = .final,
        index: Int = 0
    ) -> TranscriptSegment {
        TranscriptSegment(
            id: SegmentID(),
            speaker: .thinker,
            text: text,
            state: state,
            audioStart: 0.0,
            audioEnd: 1.0,
            turn: 1,
            index: index
        )
    }

    func testAccumulatedFinalsEmitOnTickInOrder() {
        var batcher = ForwarderBatcher(sessionID: UUID())
        let first = segment(text: "One.", index: 0)
        let second = segment(text: "Two.", index: 1)
        batcher.feed(.segmentFinalized(first))
        batcher.feed(.segmentFinalized(second))

        let batch = batcher.tick()
        XCTAssertEqual(batch?.segments, [first, second])
        XCTAssertNil(batcher.tick(), "a flush clears the pending set")
    }

    func testEmptyTickEmitsNoBatch() {
        var batcher = ForwarderBatcher(sessionID: UUID())
        XCTAssertNil(batcher.tick())
    }

    func testVolatileAndTurnEventsNeverAccumulate() {
        var batcher = ForwarderBatcher(sessionID: UUID())
        batcher.feed(.segmentAdded(segment(text: "in progress", state: .volatile)))
        batcher.feed(.segmentRevised(segment(text: "in progress still", state: .volatile)))
        batcher.feed(.turnStarted(turn: 2, atAudioTime: 3.5))
        XCTAssertNil(batcher.tick(), "only finalized text may reach a batch")
    }

    func testSnapshotReplayedFinalAccumulates() {
        // A late subscriber's snapshot delivers already-final segments as
        // synthetic .segmentAdded events — those ARE finalized text.
        var batcher = ForwarderBatcher(sessionID: UUID())
        let replayed = segment(text: "Earlier words.", state: .final)
        batcher.feed(.segmentAdded(replayed))
        XCTAssertEqual(batcher.tick()?.segments, [replayed])
    }

    func testBatchIndicesAreMonotonicAcrossTicks() {
        var batcher = ForwarderBatcher(sessionID: UUID())
        batcher.feed(.segmentFinalized(segment(text: "One.", index: 0)))
        XCTAssertEqual(batcher.tick()?.index, 0)
        XCTAssertNil(batcher.tick(), "an empty tick must not consume an index")
        batcher.feed(.segmentFinalized(segment(text: "Two.", index: 1)))
        XCTAssertEqual(batcher.tick()?.index, 1)
        batcher.feed(.segmentFinalized(segment(text: "Three.", index: 2)))
        XCTAssertEqual(batcher.flushRemaining()?.index, 2)
    }

    func testFlushRemainingEmitsPendingTailThenNothing() {
        var batcher = ForwarderBatcher(sessionID: UUID())
        let tail = segment(text: "Last words.", index: 5)
        batcher.feed(.segmentFinalized(tail))
        XCTAssertEqual(batcher.flushRemaining()?.segments, [tail])
        XCTAssertNil(batcher.flushRemaining())
    }

    func testBatchCarriesTheSessionID() {
        let sessionID = UUID()
        var batcher = ForwarderBatcher(sessionID: sessionID)
        batcher.feed(.segmentFinalized(segment(text: "Words.")))
        XCTAssertEqual(batcher.tick()?.sessionID, sessionID)
    }
}
