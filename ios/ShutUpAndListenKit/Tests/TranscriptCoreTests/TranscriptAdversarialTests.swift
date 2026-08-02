// Adversarial tests for the TranscriptStore actor — the abuse the polite
// suites never attempt: unknown and duplicate IDs, double finalization,
// non-monotonic turn stamps, malformed run timings, listener misuse, and
// concurrent hammering of the multicast registry.
//
// Every assertion here is pinned to the documented contract (the rewrite
// plan's TranscriptStore section and the doc comments in
// Sources/TranscriptCore) — where the docs leave behavior open, these tests
// assert only the invariants that must hold regardless: no crash, no
// corrupted log (unique IDs, unique monotonic indexes), no lost or
// re-ordered finals, and the gate never fed stale evidence.

import XCTest
@testable import TranscriptCore
import TurnEngine

/// Consume events until `done` says so (or `timeout` passes), returning
/// everything seen. For tests where the target count is only known via the
/// events themselves (hammering, sentinel-terminated collections).
func collectUntil(
    from stream: AsyncStream<TranscriptEvent>,
    timeout: TimeInterval = 10,
    done: @escaping @Sendable ([TranscriptEvent]) -> Bool
) async -> [TranscriptEvent] {
    await withTaskGroup(of: [TranscriptEvent]?.self) { group in
        group.addTask {
            var out: [TranscriptEvent] = []
            for await event in stream {
                out.append(event)
                if done(out) { break }
            }
            return out
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            return nil
        }
        let winner = await group.next()! ?? []
        group.cancelAll()
        return winner
    }
}

private func finalizedIDs(_ events: [TranscriptEvent]) -> [SegmentID] {
    events.compactMap { if case .segmentFinalized(let s) = $0 { return s.id } else { return nil } }
}

private func addedIDs(_ events: [TranscriptEvent]) -> [SegmentID] {
    events.compactMap { if case .segmentAdded(let s) = $0 { return s.id } else { return nil } }
}

final class TranscriptAdversarialTests: XCTestCase {
    // ── unknown / duplicate IDs, double writes ──

    func testReviseAndFinalizeUnknownIDsAreSilentNoOps() async {
        let store = TranscriptStore()
        let stream = await store.updates(replayingSnapshot: false)
        let ghost = SegmentID()
        await store.revise(id: ghost, text: "phantom", range: 0.0...1.0)
        await store.finalize(id: ghost, into: [
            FinalizedText(id: ghost, text: "Phantom.", range: 0.0...1.0),
        ])

        let segments = await store.snapshot()
        XCTAssertTrue(segments.isEmpty, "unknown IDs must not create segments")
        // Nothing may have been published either: the first event a live
        // subscriber sees must be the sentinel append below.
        let sentinel = SegmentID()
        await store.append(id: sentinel, text: "real", range: 0.0...0.5)
        let events = await collect(1, from: stream)
        guard case .segmentAdded(let s) = events.first else {
            return XCTFail("expected only the sentinel add, got \(events)")
        }
        XCTAssertEqual(s.id, sentinel, "no-op writes must publish nothing")
    }

    func testFinalizeCalledTwiceIsANoOpTheSecondTime() async {
        let store = TranscriptStore()
        let stream = await store.updates(replayingSnapshot: false)
        let id = SegmentID()
        await store.append(id: id, text: "once", range: 0.0...1.0)
        await store.finalize(id: id, into: [
            FinalizedText(id: id, text: "Once.", range: 0.0...1.0),
        ])
        // Finalization is one-way (TranscriptSegment.State doc): a second
        // finalize for the same ID — whatever it carries — must change nothing.
        await store.finalize(id: id, into: [
            FinalizedText(id: id, text: "TWICE — must not land.", range: 0.0...9.0),
        ])

        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].text, "Once.")
        XCTAssertEqual(segments[0].state, .final)

        // Event log: add + finalized, then nothing until the sentinel.
        let sentinel = SegmentID()
        await store.append(id: sentinel, text: "next", range: 2.0...2.5)
        let events = await collect(3, from: stream)
        XCTAssertEqual(events.count, 3)
        guard case .segmentAdded(let last) = events[2] else {
            return XCTFail("double finalize published an extra event: \(events)")
        }
        XCTAssertEqual(last.id, sentinel)
    }

    func testFinalizeToEmptyThenFreshVolatileContinuesCleanly() async {
        let store = TranscriptStore()
        let dropped = SegmentID()
        await store.append(id: dropped, text: "uh", range: 0.0...0.3)
        await store.finalize(id: dropped, into: []) // engine finalized to nothing
        // A fresh volatile after the drop must open normally…
        let next = SegmentID()
        await store.append(id: next, text: "real words", range: 0.5...1.0)
        // …and re-finalizing the dropped ID must stay a no-op.
        await store.finalize(id: dropped, into: [
            FinalizedText(id: dropped, text: "resurrected?", range: 0.0...0.3),
        ])

        let segments = await store.snapshot()
        XCTAssertEqual(segments.map(\.id), [next])
        XCTAssertEqual(segments[0].state, .volatile)
        XCTAssertGreaterThan(segments[0].index, 0,
                             "indexes stay monotonic; a dropped volatile's slot is not reused")
        await store.revise(id: next, text: "real words grow", range: 0.5...1.5)
        let revised = await store.snapshot()
        XCTAssertEqual(revised[0].text, "real words grow")
    }

    func testDuplicateAppendIsDroppedAndOriginalStaysWritable() async {
        let store = TranscriptStore()
        let id = SegmentID()
        await store.append(id: id, text: "original", range: 0.0...1.0)
        await store.append(id: id, text: "imposter", range: 5.0...6.0) // engine bug — drop

        var segments = await store.snapshot()
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].text, "original")
        await store.revise(id: id, text: "original grew", range: 0.0...1.5)
        segments = await store.snapshot()
        XCTAssertEqual(segments[0].text, "original grew", "the original keeps its identity")
    }

    func testFinalizeWithColludingIDsNeverDuplicatesIdentity() async {
        // Engine bug: a finalized result carrying the ID of a DIFFERENT live
        // segment (or the same ID twice in one finals list). SegmentID is
        // "stable identity" (TranscriptSegment doc) — the log must never hold
        // two segments with one identity, or every later lookup for the live
        // one resolves to the wrong segment.
        let store = TranscriptStore()
        let a = SegmentID()
        let b = SegmentID()
        await store.append(id: a, text: "first", range: 0.0...1.0)
        await store.append(id: b, text: "second", range: 1.5...2.0)
        await store.finalize(id: a, into: [
            FinalizedText(id: b, text: "First.", range: 0.0...1.0), // collides with live b
        ])

        var segments = await store.snapshot()
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(Set(segments.map(\.id)).count, segments.count,
                       "duplicate IDs corrupt the log — every segment keeps a unique identity")
        // The LIVE b must still be revisable and finalizable by its ID.
        await store.revise(id: b, text: "second grew", range: 1.5...2.5)
        segments = await store.snapshot()
        XCTAssertEqual(segments.first(where: { $0.state == .volatile })?.text, "second grew",
                       "the live volatile must not be shadowed by the imposter final")

        // Same ID twice within one finals list must not collide either.
        let c = SegmentID()
        await store.append(id: c, text: "third fourth", range: 3.0...4.0)
        await store.finalize(id: c, into: [
            FinalizedText(id: c, text: "Third.", range: 3.0...3.5),
            FinalizedText(id: c, text: "Fourth.", range: 3.5...4.0),
        ])
        segments = await store.snapshot()
        XCTAssertEqual(Set(segments.map(\.id)).count, segments.count,
                       "a repeated ID inside one finals list must not duplicate identity")
    }

    // ── turn stamps: non-monotonic numbers, out-of-order times, retro stamps ──

    func testNonMonotonicTurnNumbersTagByBoundaryTime() async {
        // The contract is time-based ("the turn whose boundary interval
        // contains audioStart"), not number-based — a host stamping weird turn
        // numbers still gets time-consistent tags.
        let store = TranscriptStore()
        await store.startTurn(5, atAudioTime: 1.0)
        await store.startTurn(3, atAudioTime: 2.0)
        let x = SegmentID(), y = SegmentID(), z = SegmentID()
        await store.append(id: x, text: "before all", range: 0.2...0.4)
        await store.append(id: y, text: "in five", range: 1.2...1.5)
        await store.append(id: z, text: "in three", range: 2.5...3.0)

        let segments = await store.snapshot()
        XCTAssertEqual(segments.map(\.turn), [0, 5, 3])
        let five = await store.utteranceText(turn: 5)
        XCTAssertEqual(five, "in five")
    }

    func testOutOfOrderBoundaryTimesAreSortedForTagging() async {
        let store = TranscriptStore()
        await store.startTurn(2, atAudioTime: 5.0)
        await store.startTurn(1, atAudioTime: 0.0) // stamped late, earlier in time
        let a = SegmentID(), b = SegmentID()
        await store.append(id: a, text: "early", range: 0.5...1.0)
        await store.append(id: b, text: "late", range: 6.0...6.5)

        let segments = await store.snapshot()
        XCTAssertEqual(segments.map(\.turn), [1, 2],
                       "boundaries sort by time; tags follow the timeline, not stamp order")
    }

    func testRetroactiveBoundaryDoesNotRetagFinalsButVolatileRederivesOnRevise() async {
        // startTurn's doc: existing tags are NOT retro-revised; open volatiles
        // re-derive on their next revision.
        let store = TranscriptStore()
        let done = SegmentID()
        await store.append(id: done, text: "finished early", range: 1.0...1.5)
        await store.finalize(id: done, into: [
            FinalizedText(id: done, text: "Finished early.", range: 1.0...1.5),
        ])
        let open = SegmentID()
        await store.append(id: open, text: "still going", range: 2.0...2.5)
        await store.startTurn(1, atAudioTime: 0.5) // retro-stamped before both starts

        var segments = await store.snapshot()
        XCTAssertEqual(segments.map(\.turn), [0, 0], "no retro-revision on startTurn")

        await store.revise(id: open, text: "still going on", range: 2.0...3.0)
        segments = await store.snapshot()
        XCTAssertEqual(segments[0].turn, 0, "the final keeps its stale tag by design")
        XCTAssertEqual(segments[1].turn, 1, "the volatile re-derives on revision")
    }

    func testUtteranceTextSeesVolatileBehindAFreshBoundaryBeforeAnyRevision() async {
        // The detector stamps turn-start with latency, so the boundary time
        // can land BEFORE the open volatile's start, with no revision yet to
        // re-derive the stale tag. startTurn's doc promises "nothing
        // downstream sees a stale carve", and the plan's gate reads "the
        // WHOLE thought so far" — utteranceText must not return empty here.
        let store = TranscriptStore()
        let id = SegmentID()
        await store.append(id: id, text: "the whole thought", range: 0.5...1.5) // tag 0
        await store.startTurn(1, atAudioTime: 0.2) // retro stamp, before the volatile's start

        let text = await store.utteranceText(turn: 1)
        XCTAssertEqual(text, "the whole thought",
                       "the gate must see current-turn speech even before the tag re-derives")
        let previous = await store.utteranceText(turn: 0)
        XCTAssertEqual(previous, "", "and turn 0 must not double-count it")
    }

    func testSegmentsBeforeAnyStartTurnLiveInTurnZero() async {
        let store = TranscriptStore()
        let id = SegmentID()
        await store.append(id: id, text: "no turns yet", range: 0.0...1.0)
        let segments = await store.snapshot()
        XCTAssertEqual(segments[0].turn, 0)
        let zero = await store.utteranceText(turn: 0)
        XCTAssertEqual(zero, "no turns yet")
        let unknown = await store.utteranceText(turn: 7)
        XCTAssertEqual(unknown, "", "a turn nobody started has no utterance")
    }

    // ── utteranceText: straddlers with partial or absent runs ──

    func testTurnWithOnlyAStraddlingVolatileCarvesByAppendTimeRuns() async {
        // Runs supplied at APPEND (not revision), boundary recorded after the
        // append, turn 2 holding no finalized segment at all.
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let id = SegmentID()
        // "early words then late" — "then late" at UTF-16 offset 12, audio 2.3.
        await store.append(
            id: id,
            text: "early words then late",
            range: 0.5...3.0,
            runs: [
                TimedRun(charOffset: 0, charLength: 11, audioStart: 0.5, audioEnd: 1.4),
                TimedRun(charOffset: 12, charLength: 9, audioStart: 2.3, audioEnd: 3.0),
            ]
        )
        await store.startTurn(2, atAudioTime: 2.0)

        let text = await store.utteranceText(turn: 2)
        XCTAssertEqual(text, "then late", "append-time runs carve the post-boundary portion")
    }

    func testStraddlerRunsAllBeforeBoundaryContributeNothingToTheNewTurn() async {
        // Partial runs: everything timed lies before the boundary (the tail of
        // the text is not covered by any run). postBoundaryPortion's documented
        // reading: no run at/after the boundary — nothing carvable.
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let id = SegmentID()
        await store.append(id: id, text: "all early words", range: 0.5...1.0)
        await store.startTurn(2, atAudioTime: 2.0)
        await store.revise(
            id: id,
            text: "all early words trailing",
            range: 0.5...2.5,
            runs: [TimedRun(charOffset: 0, charLength: 15, audioStart: 0.5, audioEnd: 1.0)]
        )

        let text = await store.utteranceText(turn: 2)
        XCTAssertEqual(text, "", "no run at/after the boundary — nothing attributable to turn 2")
    }

    func testStraddlerFirstRunAfterBoundaryAtOffsetZeroFallsBackToWholeText() async {
        // The first run at/after the boundary starts at offset 0 — no usable
        // cut point, so the whole volatile is the safe over-approximation.
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let id = SegmentID()
        await store.append(id: id, text: "spans", range: 0.5...1.0)
        await store.startTurn(2, atAudioTime: 2.0)
        await store.revise(
            id: id,
            text: "spans across",
            range: 0.5...3.0,
            runs: [TimedRun(charOffset: 0, charLength: 12, audioStart: 2.1, audioEnd: 3.0)]
        )

        let text = await store.utteranceText(turn: 2)
        XCTAssertEqual(text, "spans across")
    }

    // ── malformed run timings: never crash, never lose text ──

    func testRunOffsetsBeyondTextLengthNeitherCrashNorSplit() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let volatileID = SegmentID()
        await store.append(id: volatileID, text: "short", range: 0.5...1.0)
        await store.startTurn(2, atAudioTime: 2.0)
        // Volatile carve with an offset far past the text: whole-text fallback
        // (over-approximation is the documented safe direction), no crash.
        await store.revise(
            id: volatileID,
            text: "short text",
            range: 0.5...3.0,
            runs: [TimedRun(charOffset: 999, charLength: 4, audioStart: 2.2, audioEnd: 3.0)]
        )
        let carved = await store.utteranceText(turn: 2)
        XCTAssertEqual(carved, "short text")

        // Finalized straddler with out-of-range and negative offsets: the
        // split is impossible, so best-effort keeps the segment whole.
        await store.finalize(id: volatileID, into: [
            FinalizedText(
                id: volatileID,
                text: "short text",
                range: 0.5...3.0,
                runs: [
                    TimedRun(charOffset: -3, charLength: 2, audioStart: 2.1, audioEnd: 2.4),
                    TimedRun(charOffset: 999, charLength: 4, audioStart: 2.5, audioEnd: 3.0),
                ]
            ),
        ])
        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 1, "unsplittable stays whole — never crashes, never drops text")
        XCTAssertEqual(segments[0].text, "short text")
        XCTAssertEqual(segments[0].turn, 1, "tag stays start-derived")
        XCTAssertEqual(segments[0].state, .final)
    }

    func testRunOffsetInsideASurrogatePairSplitsWithoutCrashingOrLosingText() async {
        // UTF-16 offsets from a buggy engine can point INSIDE a surrogate
        // pair. Swift slicing rounds such an index down to a scalar boundary —
        // the store must survive and keep every non-space character across
        // the pieces.
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let id = SegmentID()
        let text = "ab \u{1F44B} cd" // waving hand occupies UTF-16 offsets 3–4
        await store.append(id: id, text: text, range: 0.5...1.0)
        await store.startTurn(2, atAudioTime: 2.0)
        await store.finalize(id: id, into: [
            FinalizedText(
                id: id,
                text: text,
                range: 0.5...3.5,
                runs: [
                    TimedRun(charOffset: 0, charLength: 3, audioStart: 0.5, audioEnd: 1.0),
                    TimedRun(charOffset: 4, charLength: 4, audioStart: 2.2, audioEnd: 3.5), // mid-pair
                ]
            ),
        ])

        let segments = await store.snapshot()
        XCTAssertFalse(segments.isEmpty)
        let kept = segments.map(\.text).joined().filter { !$0.isWhitespace }
        XCTAssertEqual(kept, text.filter { !$0.isWhitespace },
                       "a misaligned cut may move to a scalar boundary but must not lose text")
    }

    // ── listener misuse ──

    func testCloseListenerUnknownDoubleAndWrongSpeakerAreNoOps() async {
        let store = TranscriptStore()
        let stream = await store.updates(replayingSnapshot: false)

        await store.closeListener(id: SegmentID(), actualEnd: 1.0) // unknown

        let thinker = SegmentID()
        await store.append(id: thinker, text: "human words", range: 0.0...1.0)
        await store.closeListener(id: thinker, actualEnd: 0.8) // wrong speaker

        let reply = await store.appendListener(text: "mm", tier: .acknowledge, estimatedRange: 2.0...2.5)
        await store.closeListener(id: reply, actualEnd: 2.4)
        await store.closeListener(id: reply, actualEnd: 9.9, bargedIn: true) // already closed

        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0].state, .volatile, "closeListener must not touch a thinker segment")
        XCTAssertEqual(segments[1].audioEnd, 2.4, "the second close must not move the end")
        XCTAssertFalse(segments[1].bargedIn, "nor retroactively flag a barge-in")

        // Event log: exactly thinker add, listener add, listener finalized.
        let events = await collect(3, from: stream)
        XCTAssertEqual(events.count, 3)
        guard case .segmentAdded = events[0],
              case .segmentAdded = events[1],
              case .segmentFinalized(let closed) = events[2]
        else { return XCTFail("unexpected event shape \(events)") }
        XCTAssertEqual(closed.audioEnd, 2.4)
    }

    func testUtteranceTextExcludesListenerSegmentsEvenWhenStraddling() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let t = SegmentID()
        await store.append(id: t, text: "thinker words", range: 0.5...1.0)
        await store.finalize(id: t, into: [
            FinalizedText(id: t, text: "Thinker words.", range: 0.5...1.0),
        ])
        // An OPEN listener reply straddling the next boundary — the carve
        // logic must not pick it up for turn 2 either.
        await store.appendListener(text: "a long reply", tier: .reflection, estimatedRange: 1.5...3.0)
        await store.startTurn(2, atAudioTime: 2.0)

        let one = await store.utteranceText(turn: 1)
        XCTAssertEqual(one, "Thinker words.", "the listener's reply is not the thinker's utterance")
        let two = await store.utteranceText(turn: 2)
        XCTAssertEqual(two, "", "a straddling listener volatile contributes nothing")
    }

    // ── index discipline across splits and listener interleaving ──

    func testIndexesStayUniqueAndFreshAcrossSplitsAndListenerAppends() async {
        let store = TranscriptStore()
        await store.startTurn(1, atAudioTime: 0.0)
        let a = SegmentID()
        await store.append(id: a, text: "spans the line", range: 0.5...1.0)
        await store.appendListener(text: "mm", tier: .acknowledge, estimatedRange: 1.2...1.4)
        await store.startTurn(2, atAudioTime: 2.0)
        // Straddling finalize → split → the extra piece needs a FRESH index,
        // not a collision with the listener segment appended in between.
        await store.finalize(id: a, into: [
            FinalizedText(
                id: a,
                text: "before after",
                range: 0.5...3.0,
                runs: [
                    TimedRun(charOffset: 0, charLength: 6, audioStart: 0.5, audioEnd: 1.0),
                    TimedRun(charOffset: 7, charLength: 5, audioStart: 2.2, audioEnd: 3.0),
                ]
            ),
        ])
        let b = SegmentID()
        await store.append(id: b, text: "later", range: 3.5...4.0)

        let segments = await store.snapshot()
        XCTAssertEqual(segments.count, 4)
        let indexes = segments.map(\.index)
        XCTAssertEqual(Set(indexes).count, indexes.count, "indexes are identity for order — no collisions")
        let latest = segments.first(where: { $0.id == b })!
        XCTAssertEqual(latest.index, indexes.max(),
                       "a fresh append lands above every index handed out so far, splits included")
        let firstPiece = segments.first(where: { $0.id == a })!
        XCTAssertEqual(firstPiece.index, 0, "the first split piece inherits the closed slot's order")
    }

    // ── multicast under stress ──

    func testConcurrentHammerEverySubscriberSeesSameOrderAndEveryFinal() async {
        let store = TranscriptStore()
        let writers = 6
        let perWriter = 20
        let total = writers * perWriter

        let streams = [
            await store.updates(replayingSnapshot: false),
            await store.updates(replayingSnapshot: false),
            await store.updates(replayingSnapshot: false),
        ]
        // Consumers race the writers, pulling until every final has landed.
        async let c0 = collectUntil(from: streams[0]) { finalizedIDs($0).count == total }
        async let c1 = collectUntil(from: streams[1]) { finalizedIDs($0).count == total }
        async let c2 = collectUntil(from: streams[2]) { finalizedIDs($0).count == total }

        let expectedIDs = await withTaskGroup(of: [SegmentID].self) { group in
            for w in 0..<writers {
                group.addTask {
                    var ids: [SegmentID] = []
                    for k in 0..<perWriter {
                        let id = SegmentID()
                        ids.append(id)
                        let base = Double(w * perWriter + k)
                        await store.append(id: id, text: "w\(w)s\(k)", range: base...(base + 0.4))
                        await store.revise(id: id, text: "w\(w)s\(k)+", range: base...(base + 0.7))
                        await store.finalize(id: id, into: [
                            FinalizedText(id: id, text: "w\(w)s\(k).", range: base...(base + 1.0)),
                        ])
                    }
                    return ids
                }
            }
            var all: Set<SegmentID> = []
            for await ids in group { all.formUnion(ids) }
            return all
        }

        let collected = [await c0, await c1, await c2]
        let logOrder = await store.snapshot().map(\.id)
        for (n, events) in collected.enumerated() {
            let finals = finalizedIDs(events)
            XCTAssertEqual(Set(finals), expectedIDs, "subscriber \(n) lost or invented finals")
            XCTAssertEqual(finals.count, total, "subscriber \(n) saw a final twice")
            XCTAssertEqual(addedIDs(events), logOrder,
                           "subscriber \(n)'s adds must replay the store's append order")
            XCTAssertEqual(finals, finalizedIDs(collected[0]),
                           "every subscriber must observe the SAME serialization of finals")
            // An event for a segment never precedes its add, and nothing
            // follows its finalization.
            var seenAdd: Set<SegmentID> = []
            var seenFinal: Set<SegmentID> = []
            for event in events {
                switch event {
                case .segmentAdded(let s):
                    seenAdd.insert(s.id)
                case .segmentRevised(let s):
                    XCTAssertTrue(seenAdd.contains(s.id), "revision before add for \(s.id)")
                    XCTAssertFalse(seenFinal.contains(s.id), "revision after finalize for \(s.id)")
                case .segmentFinalized(let s):
                    XCTAssertTrue(seenAdd.contains(s.id), "finalize before add for \(s.id)")
                    seenFinal.insert(s.id)
                case .turnStarted:
                    break
                }
            }
        }
    }

    func testSlowConsumerSeesNewestVolatileTextAndAllFinalsInOrder() async {
        let store = TranscriptStore()
        let stream = await store.updates(replayingSnapshot: false)
        let a = SegmentID()
        let b = SegmentID()

        // Producer races ahead while the consumer sleeps between pulls.
        let producer = Task {
            await store.append(id: a, text: "v0", range: 0.0...0.2)
            for v in 1...30 {
                await store.revise(id: a, text: "v\(v)", range: 0.0...(0.2 + Double(v) * 0.1))
            }
            await store.finalize(id: a, into: [FinalizedText(id: a, text: "A.", range: 0.0...3.2)])
            await store.append(id: b, text: "w0", range: 4.0...4.2)
            await store.finalize(id: b, into: [FinalizedText(id: b, text: "B.", range: 4.0...4.5)])
        }
        var events: [TranscriptEvent] = []
        while finalizedIDs(events).count < 2 && events.count < 200 {
            try? await Task.sleep(nanoseconds: 5_000_000) // deliberately lag
            events += await collect(1, from: stream, timeout: 5)
        }
        await producer.value

        // Coalescing contract: revision texts only move FORWARD — a lagging
        // consumer may skip versions, never see a stale one after a newer one.
        var lastVersion = -1
        for event in events {
            if case .segmentRevised(let s) = event, s.id == a {
                let version = Int(s.text.dropFirst())!
                XCTAssertGreaterThan(version, lastVersion, "stale revision after a newer one")
                lastVersion = version
            }
        }
        XCTAssertEqual(finalizedIDs(events), [a, b], "every final arrives, in order, exactly once")
    }

    func testSubscribingWhileAppendsAreInFlightYieldsNoDuplicatesNoHoles() async {
        let store = TranscriptStore()
        let count = 100
        let writer = Task { () -> [SegmentID] in
            var ids: [SegmentID] = []
            for k in 0..<count {
                let id = SegmentID()
                ids.append(id)
                let base = Double(k)
                await store.append(id: id, text: "seg\(k)", range: base...(base + 0.4))
                await store.finalize(id: id, into: [
                    FinalizedText(id: id, text: "Seg \(k).", range: base...(base + 0.5)),
                ])
            }
            return ids
        }
        // Land the subscription mid-flight: snapshot + deltas must seam with
        // no duplicate and no hole regardless of where the seam falls.
        try? await Task.sleep(nanoseconds: 2_000_000)
        let stream = await store.updates() // replayingSnapshot: true
        let ids = await writer.value

        let sentinel = SegmentID()
        await store.append(id: sentinel, text: "sentinel", range: 999.0...999.5)
        await store.finalize(id: sentinel, into: [
            FinalizedText(id: sentinel, text: "Sentinel.", range: 999.0...999.5),
        ])
        let events = await collectUntil(from: stream) { finalizedIDs($0).last == sentinel }

        // Exactly one "final sighting" per segment — either the snapshot
        // replayed it already-final, or the live delta finalized it — and the
        // sightings replay the append order with no hole.
        var finalSightings: [SegmentID] = []
        var addSeen: Set<SegmentID> = []
        for event in events {
            switch event {
            case .segmentAdded(let s):
                XCTAssertFalse(addSeen.contains(s.id), "duplicate add for \(s.id)")
                addSeen.insert(s.id)
                if s.state == .final { finalSightings.append(s.id) }
            case .segmentFinalized(let s):
                finalSightings.append(s.id)
            case .segmentRevised, .turnStarted:
                break
            }
        }
        XCTAssertEqual(finalSightings, ids + [sentinel],
                       "each final exactly once, in append order — no duplicates, no holes")
    }
}
