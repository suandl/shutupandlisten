// Unit tests for the TranscriptStore actor — the revision, turn-tagging, and
// listener-segment behaviours the rewrite plan's Phase 1 pins
// (docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md).
//
// The store is pure Swift, so these run headlessly on macOS/Linux alongside
// the TurnEngine golden vectors. Multicast behaviour has its own file
// (TranscriptMulticastTests); mapping helpers too (StoredEntryTests).

import XCTest
@testable import TranscriptCore
import TurnEngine

final class TranscriptStoreTests: XCTestCase {
    // ── volatile replace-in-place ──

    func testVolatileReviseShrinksInPlace() async {
        let store = TranscriptStore()
        let id = SegmentID()
        await store.append(id: id, text: "hello world and some noise", range: 0.0...2.0)
        await store.revise(id: id, text: "hello world", range: 0.0...1.4)

        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 1, "revision replaces in place, never appends")
        XCTAssertEqual(segments[0].id, id)
        XCTAssertEqual(segments[0].text, "hello world")
        XCTAssertEqual(segments[0].state, .volatile)
        XCTAssertEqual(segments[0].audioEnd, 1.4)
    }

    func testVolatileRestructureThenFinalizeKeepsIDAndIndex() async {
        let store = TranscriptStore()
        let id = SegmentID()
        await store.append(id: id, text: "i think the", range: 0.0...1.0)
        await store.revise(id: id, text: "I think the core idea", range: 0.0...2.0)
        await store.revise(id: id, text: "I think the core idea is simple.", range: 0.0...3.0)
        await store.finalize(id: id, into: [
            FinalizedText(id: id, text: "I think the core idea is simple.", range: 0.0...3.0),
        ])

        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].id, id, "identity is stable volatile → final")
        XCTAssertEqual(segments[0].index, 0, "the closing final inherits the volatile's order")
        XCTAssertEqual(segments[0].state, .final)
        XCTAssertEqual(segments[0].text, "I think the core idea is simple.")
    }

    func testFinalizeSplitsIntoMultipleFinals() async {
        let store = TranscriptStore()
        let id = SegmentID()
        let second = SegmentID()
        await store.append(id: id, text: "first sentence. second sentence.", range: 0.0...4.0)
        await store.finalize(id: id, into: [
            FinalizedText(id: id, text: "First sentence.", range: 0.0...1.8),
            FinalizedText(id: second, text: "Second sentence.", range: 1.8...4.0),
        ])

        let segments = await store.snapshot()
        XCTAssertEqual(segments.map(\.id), [id, second])
        XCTAssertEqual(segments.map(\.text), ["First sentence.", "Second sentence."])
        XCTAssertEqual(segments.map(\.state), [.final, .final])
        XCTAssertEqual(segments[0].index, 0)
        XCTAssertGreaterThan(segments[1].index, segments[0].index, "index stays monotonic")
    }

    func testIDStabilityAcrossRevisions() async {
        let store = TranscriptStore()
        let stream = await store.updates(replayingSnapshot: false)
        let id = SegmentID()
        // Consume live (one pull per write) so each revision is observed
        // individually rather than coalesced.
        await store.append(id: id, text: "a", range: 0.0...0.5)
        var events = await collect(1, from: stream)
        await store.revise(id: id, text: "a b", range: 0.0...1.0)
        events += await collect(1, from: stream)
        await store.revise(id: id, text: "a b c", range: 0.0...1.5)
        events += await collect(1, from: stream)

        XCTAssertEqual(events.count, 3)
        for event in events {
            switch event {
            case .segmentAdded(let s), .segmentRevised(let s):
                XCTAssertEqual(s.id, id)
            default:
                XCTFail("unexpected event \(event)")
            }
        }
    }

    func testNewVolatileAfterFinalizationGetsFreshID() async {
        let store = TranscriptStore()
        let first = SegmentID()
        await store.append(id: first, text: "done thought.", range: 0.0...2.0)
        await store.finalize(id: first, into: [
            FinalizedText(id: first, text: "Done thought.", range: 0.0...2.0),
        ])
        let next = SegmentID() // the engine mints a fresh ID for the next audio
        await store.append(id: next, text: "new words", range: 2.5...3.0)

        let segments = await store.snapshot()
        XCTAssertNotEqual(next, first)
        XCTAssertEqual(segments.map(\.id), [first, next])
        XCTAssertEqual(segments.map(\.state), [.final, .volatile])
        XCTAssertEqual(segments.map(\.index), [0, 1])
    }

    func testFinalizeToNothingDropsTheVolatile() async {
        let store = TranscriptStore()
        let id = SegmentID()
        await store.append(id: id, text: "uh", range: 0.0...0.3)
        await store.finalize(id: id, into: [])
        let segments = await store.snapshot()
        XCTAssertTrue(segments.isEmpty)
    }

    // ── turn tagging ──

    func testSegmentFullyInsideTurnIsTaggedWithIt() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        await store.startTurn(2, atAudioTime: 5.0)
        let id = SegmentID()
        await store.append(id: id, text: "inside turn one", range: 1.0...3.0)

        let segments = await store.snapshot()
        XCTAssertEqual(segments[0].turn, 1)
        let text = await store.utteranceText(turn: 1)
        XCTAssertEqual(text, "inside turn one")
    }

    func testSegmentBeforeAnyTurnIsTaggedZero() async {
        let store = TranscriptStore()
        let id = SegmentID()
        await store.append(id: id, text: "pre-turn audio", range: 0.0...1.0)
        let segments = await store.snapshot()
        XCTAssertEqual(segments[0].turn, 0)
    }

    func testVolatileStraddlingBoundaryKeepsStartTurn_UtteranceCarvesByRuns() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let id = SegmentID()
        await store.append(id: id, text: "first thought", range: 0.5...1.5)
        await store.startTurn(2, atAudioTime: 2.0)
        // The volatile grows across the boundary; the engine supplies runs.
        // "first thought and the second" — "and the second" starts at UTF-16
        // offset 14, audio 2.1 (inside turn 2).
        await store.revise(
            id: id,
            text: "first thought and the second",
            range: 0.5...3.0,
            runs: [
                TimedRun(charOffset: 0, charLength: 13, audioStart: 0.5, audioEnd: 1.5),
                TimedRun(charOffset: 14, charLength: 14, audioStart: 2.1, audioEnd: 3.0),
            ]
        )

        let segments = await store.snapshot()
        XCTAssertEqual(segments[0].turn, 1, "tag stays start-derived until finalization")
        let text = await store.utteranceText(turn: 2)
        XCTAssertEqual(text, "and the second", "current turn sees only the post-boundary portion")
        let previous = await store.utteranceText(turn: 1)
        XCTAssertEqual(previous, "first thought and the second",
                       "the straddler still counts whole toward its start-derived turn")
    }

    func testVolatileStraddlingBoundaryWithoutRunsFallsBackToWholeText() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let id = SegmentID()
        await store.append(id: id, text: "first thought", range: 0.5...1.5)
        await store.startTurn(2, atAudioTime: 2.0)
        await store.revise(id: id, text: "first thought and the second", range: 0.5...3.0)

        let text = await store.utteranceText(turn: 2)
        XCTAssertEqual(text, "first thought and the second",
                       "no runs — the whole volatile is the safe over-approximation")
    }

    func testFinalizedStraddlerIsSplitAtTheBoundary() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let id = SegmentID()
        await store.append(id: id, text: "spans the boundary", range: 0.5...1.0)
        await store.startTurn(2, atAudioTime: 2.0)
        // "before words after words" — "after words" at UTF-16 offset 13, audio 2.2.
        await store.finalize(id: id, into: [
            FinalizedText(
                id: id,
                text: "before words after words",
                range: 0.5...3.5,
                runs: [
                    TimedRun(charOffset: 0, charLength: 6, audioStart: 0.5, audioEnd: 1.0),
                    TimedRun(charOffset: 7, charLength: 5, audioStart: 1.0, audioEnd: 1.5),
                    TimedRun(charOffset: 13, charLength: 5, audioStart: 2.2, audioEnd: 2.8),
                    TimedRun(charOffset: 19, charLength: 5, audioStart: 2.8, audioEnd: 3.5),
                ]
            ),
        ])

        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 2, "one straddling final becomes two, one per turn")
        XCTAssertEqual(segments[0].text, "before words")
        XCTAssertEqual(segments[0].turn, 1)
        XCTAssertEqual(segments[0].audioStart, 0.5)
        XCTAssertEqual(segments[0].audioEnd, 2.0, "pre piece ends at the boundary")
        XCTAssertEqual(segments[0].id, id, "the first piece keeps the engine's ID")
        XCTAssertEqual(segments[1].text, "after words")
        XCTAssertEqual(segments[1].turn, 2)
        XCTAssertEqual(segments[1].audioStart, 2.0, "post piece starts at the boundary")
        XCTAssertEqual(segments[1].audioEnd, 3.5)
        XCTAssertNotEqual(segments[1].id, id, "the split piece is a new segment")
        XCTAssertEqual(segments.map(\.state), [.final, .final])

        let text = await store.utteranceText(turn: 2)
        XCTAssertEqual(text, "after words")
    }

    func testFinalizedStraddlerWithoutRunsStaysWholeInStartTurn() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let id = SegmentID()
        await store.append(id: id, text: "spans the boundary", range: 0.5...1.0)
        await store.startTurn(2, atAudioTime: 2.0)
        await store.finalize(id: id, into: [
            FinalizedText(id: id, text: "spans the boundary", range: 0.5...3.0),
        ])

        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 1, "no runs — cannot split, best-effort keeps it whole")
        XCTAssertEqual(segments[0].turn, 1, "tag stays start-derived")
    }

    func testRevisionRederivesTurnFromNewStart() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        await store.startTurn(2, atAudioTime: 2.0)
        let id = SegmentID()
        await store.append(id: id, text: "hm", range: 1.5...1.8)
        var segments = await store.snapshot()
        XCTAssertEqual(segments[0].turn, 1)

        // The engine's better estimate moves the segment past the boundary.
        await store.revise(id: id, text: "hm okay", range: 2.2...2.6)
        segments = await store.snapshot()
        XCTAssertEqual(segments[0].turn, 2, "a revision re-derives the tag from audioStart")
    }

    // ── listener segments ──

    func testListenerAppendEstimateThenCloseWithActualEnd() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let stream = await store.updates(replayingSnapshot: false)

        let id = await store.appendListener(
            text: "mm", tier: .acknowledge, estimatedRange: 10.0...11.5
        )
        await store.closeListener(id: id, actualEnd: 11.2)

        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].id, id)
        XCTAssertEqual(segments[0].speaker, .listener)
        XCTAssertEqual(segments[0].tier, .acknowledge)
        XCTAssertEqual(segments[0].audioStart, 10.0)
        XCTAssertEqual(segments[0].audioEnd, 11.2, "close revises the estimate to the actual end")
        XCTAssertEqual(segments[0].state, .final)
        XCTAssertFalse(segments[0].bargedIn)
        XCTAssertEqual(segments[0].turn, 1)

        let events = await collect(2, from: stream)
        guard case .segmentAdded(let added) = events[0],
              case .segmentFinalized(let closed) = events[1]
        else { return XCTFail("expected added then finalized, got \(events)") }
        XCTAssertEqual(added.state, .volatile, "a speaking reply is open until closed")
        XCTAssertEqual(closed.id, added.id)
    }

    func testListenerBargeInCloseSetsFlagAndCutPoint() async {
        let store = TranscriptStore()
        let id = await store.appendListener(
            text: "one brief question about the ranking?",
            tier: .question,
            estimatedRange: 20.0...24.0
        )
        await store.closeListener(id: id, actualEnd: 21.3, bargedIn: true)

        let segments = await store.snapshot()
        XCTAssertTrue(segments[0].bargedIn)
        XCTAssertEqual(segments[0].audioEnd, 21.3, "cut at the barge-in point, not the estimate")
        XCTAssertEqual(segments[0].state, .final)
    }

    func testFullTextIsThinkerOnly() async {
        let store = TranscriptStore()
        let a = SegmentID()
        await store.append(id: a, text: "First thought.", range: 0.0...1.0)
        await store.finalize(id: a, into: [FinalizedText(id: a, text: "First thought.", range: 0.0...1.0)])
        await store.appendListener(text: "mm", tier: .acknowledge, estimatedRange: 1.2...1.5)
        let b = SegmentID()
        await store.append(id: b, text: "second still going", range: 2.0...3.0)

        let text = await store.fullText
        XCTAssertEqual(text, "First thought. second still going",
                       "coverage input: everything the thinker said, volatile included, listener excluded")
    }
}
