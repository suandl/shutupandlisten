// The saved transcript is derived from the .m4a, not the lossy live stream
// (spec §1). The file gives timestamped thinker segments (AEC removed our own
// TTS, so the mic file is thinker-only); the machine already recorded turn
// windows (for grouping + tap-to-seek) and we synthesized the listener lines.
// reconcile() folds them into one authoritative, time-ordered entry list.

import XCTest
@testable import TurnEngine

final class TranscriptReconcilerTests: XCTestCase {
    func testSegmentsInOneTurnJoinIntoOneThinkerEntry() {
        let entries = TranscriptReconciler.reconcile(
            segments: [
                TranscriptSegment(text: "I have", startMs: 100, endMs: 900),
                TranscriptSegment(text: "an idea", startMs: 1000, endMs: 1800),
            ],
            turns: [TurnWindow(turn: 1, startMs: 0, endMs: 2000)],
            listenerLines: []
        )
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].speaker, .thinker)
        XCTAssertEqual(entries[0].text, "I have an idea")
        XCTAssertEqual(entries[0].turn, 1)
        XCTAssertEqual(entries[0].startMs, 100, "startMs is the first segment — seek lands on the words")
        XCTAssertEqual(entries[0].endMs, 1800)
        XCTAssertNil(entries[0].tier)
    }

    func testSegmentsAttributedToTheTurnActiveWhenTheyBegan() {
        let entries = TranscriptReconciler.reconcile(
            segments: [
                TranscriptSegment(text: "first thought", startMs: 100, endMs: 900),
                TranscriptSegment(text: "second thought", startMs: 5100, endMs: 5900),
            ],
            turns: [
                TurnWindow(turn: 1, startMs: 0, endMs: 1000),
                TurnWindow(turn: 2, startMs: 5000, endMs: 6000),
            ],
            listenerLines: []
        )
        XCTAssertEqual(entries.map(\.turn), [1, 2])
        XCTAssertEqual(entries.map(\.text), ["first thought", "second thought"])
    }

    func testListenerLineInsertedInTimeOrder() {
        let entries = TranscriptReconciler.reconcile(
            segments: [
                TranscriptSegment(text: "the idea", startMs: 100, endMs: 900),
                TranscriptSegment(text: "and more", startMs: 4000, endMs: 4800),
            ],
            turns: [
                TurnWindow(turn: 1, startMs: 0, endMs: 1000),
                TurnWindow(turn: 2, startMs: 3900, endMs: 5000),
            ],
            listenerLines: [
                ListenerLine(text: "what decides the order?", tier: .question, turn: 1, startMs: 1500),
            ]
        )
        XCTAssertEqual(entries.map(\.speaker), [.thinker, .listener, .thinker])
        XCTAssertEqual(entries[1].text, "what decides the order?")
        XCTAssertEqual(entries[1].tier, .question)
        XCTAssertEqual(entries[1].startMs, 1500)
    }

    func testThinkerBeforeListenerOnTimestampTie() {
        // A listener line stamped exactly at a turn start sorts AFTER the turn.
        let entries = TranscriptReconciler.reconcile(
            segments: [TranscriptSegment(text: "point", startMs: 2000, endMs: 2500)],
            turns: [TurnWindow(turn: 1, startMs: 2000, endMs: 3000)],
            listenerLines: [ListenerLine(text: "why?", tier: .question, turn: 1, startMs: 2000)]
        )
        XCTAssertEqual(entries.map(\.speaker), [.thinker, .listener])
    }

    func testTurnWithNoSegmentsIsDropped() {
        // A thinker turn the file transcribed as silence produces no empty entry.
        let entries = TranscriptReconciler.reconcile(
            segments: [TranscriptSegment(text: "only this", startMs: 100, endMs: 500)],
            turns: [
                TurnWindow(turn: 1, startMs: 0, endMs: 1000),
                TurnWindow(turn: 2, startMs: 2000, endMs: 3000),
            ],
            listenerLines: []
        )
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].turn, 1)
    }

    func testNoSegmentsReturnsListenerLinesOnly() {
        // File transcription found nothing (or was skipped): still place the
        // listener lines we synthesized, in order.
        let entries = TranscriptReconciler.reconcile(
            segments: [],
            turns: [TurnWindow(turn: 1, startMs: 0, endMs: 1000)],
            listenerLines: [ListenerLine(text: "hm?", tier: .question, turn: 1, startMs: 500)]
        )
        XCTAssertEqual(entries.map(\.speaker), [.listener])
        XCTAssertEqual(entries[0].text, "hm?")
    }

    func testSegmentBeforeAnyTurnStartAttachesToFirstTurn() {
        let entries = TranscriptReconciler.reconcile(
            segments: [TranscriptSegment(text: "early", startMs: 50, endMs: 200)],
            turns: [TurnWindow(turn: 1, startMs: 100, endMs: 1000)],
            listenerLines: []
        )
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].turn, 1)
    }
}
