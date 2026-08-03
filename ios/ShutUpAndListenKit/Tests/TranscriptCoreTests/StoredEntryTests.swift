// Tests for the storage DTO and mapping helpers — the persistence/export
// logic that must stay byte-compatible with the app's existing
// `transcriptJSON` blobs (SessionRecord.swift) while the schema migrates
// underneath it in Phase 4.

import XCTest
@testable import TranscriptCore
import TurnEngine

final class StoredEntryTests: XCTestCase {
    private func segment(
        speaker: Speaker,
        text: String,
        turn: Int,
        tier: Tier? = nil,
        range: ClosedRange<TimeInterval> = 0...0,
        index: Int
    ) -> TranscriptSegment {
        TranscriptSegment(
            id: SegmentID(), speaker: speaker, text: text, state: .final,
            audioStart: range.lowerBound, audioEnd: range.upperBound,
            turn: turn, tier: tier, index: index
        )
    }

    func testRoundTripPreservesOrderAndFields() {
        let entries = [
            StoredEntry(speaker: "thinker", text: "So the idea is a reading app.", tier: nil, turn: 1),
            StoredEntry(speaker: "listener", text: "mm", tier: "acknowledge", turn: 1),
            StoredEntry(speaker: "thinker", text: "It hides every number.", tier: nil, turn: 2),
            StoredEntry(speaker: "listener", text: "What would replace them?", tier: "question", turn: 2),
        ]

        let restored = segments(from: entries)
        XCTAssertEqual(restored.map(\.index), [0, 1, 2, 3], "index preserves entry order")
        XCTAssertEqual(restored.map(\.speaker), [.thinker, .listener, .thinker, .listener])
        XCTAssertEqual(restored.map(\.tier), [nil, .acknowledge, nil, .question])
        XCTAssertTrue(restored.allSatisfy { $0.audioStart == 0 && $0.audioEnd == 0 },
                      "old records carry no timings — ranges are zeroed")
        XCTAssertTrue(restored.allSatisfy { $0.state == .final })

        XCTAssertEqual(storedEntries(from: restored), entries, "the round trip is lossless")
    }

    func testMappingDropsBlankSegmentsOnly() {
        let segs = [
            segment(speaker: .thinker, text: "kept", turn: 1, index: 0),
            segment(speaker: .thinker, text: "   ", turn: 1, index: 1),
            segment(speaker: .listener, text: "also kept", turn: 1, tier: .reflection, index: 2),
        ]
        let entries = storedEntries(from: segs)
        XCTAssertEqual(entries.map(\.text), ["kept", "also kept"])
        XCTAssertEqual(entries.map(\.tier), [nil, "reflection"])
    }

    func testVolatileSegmentsFlattenToo() {
        // The stop-path snapshot may be taken before the engine drained; the
        // words in an open volatile still make it into storage.
        var open = segment(speaker: .thinker, text: "still open words", turn: 3, index: 0)
        open.state = .volatile
        let entries = storedEntries(from: [open])
        XCTAssertEqual(entries, [StoredEntry(speaker: "thinker", text: "still open words", tier: nil, turn: 3)])
    }

    func testDecodesTheAppsCurrentEncoderOutput() throws {
        // A fixture in the exact shape the app target's JSONEncoder writes
        // today (SessionRecord.transcriptJSON): synthesized keys, nil tier
        // omitted. Old persisted blobs must keep decoding forever.
        let fixture = Data("""
        [{"speaker":"thinker","text":"So the whole point is momentum.","turn":1},
         {"speaker":"listener","text":"mm-hm","tier":"acknowledge","turn":1},
         {"speaker":"listener","text":"Where does the momentum come from?","tier":"question","turn":2}]
        """.utf8)

        let entries = try JSONDecoder().decode([StoredEntry].self, from: fixture)
        XCTAssertEqual(entries, [
            StoredEntry(speaker: "thinker", text: "So the whole point is momentum.", tier: nil, turn: 1),
            StoredEntry(speaker: "listener", text: "mm-hm", tier: "acknowledge", turn: 1),
            StoredEntry(speaker: "listener", text: "Where does the momentum come from?", tier: "question", turn: 2),
        ])

        // And the segments view keeps the listener tiers as real Tier values.
        let restored = segments(from: entries)
        XCTAssertEqual(restored[2].tier, .question)
        XCTAssertFalse(hasTimings(restored))
    }

    func testEncodingMatchesTheAppShape() throws {
        // Encode → decode through plain JSONSerialization to check the wire
        // keys (not just Codable symmetry).
        let entry = StoredEntry(speaker: "listener", text: "hm", tier: "acknowledge", turn: 4)
        let data = try JSONEncoder().encode([entry])
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        ).first
        XCTAssertEqual(object?["speaker"] as? String, "listener")
        XCTAssertEqual(object?["text"] as? String, "hm")
        XCTAssertEqual(object?["tier"] as? String, "acknowledge")
        XCTAssertEqual(object?["turn"] as? Int, 4)

        let thinker = StoredEntry(speaker: "thinker", text: "hi", tier: nil, turn: 1)
        let thinkerKeys = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode([thinker])) as? [[String: Any]]
        ).first?.keys
        XCTAssertEqual(Set(thinkerKeys ?? [:].keys), ["speaker", "text", "turn"],
                       "nil tier is omitted, exactly as the app's encoder does")
    }

    func testStoredEntriesOrderChronologicallyWhenSplitIndexesInterleave() async {
        // The interleave the index sort gets wrong: a volatile spans two
        // sentences; a listener reply is appended mid-volatile (later audio
        // range, but the NEXT append index); the finalize-split then hands the
        // second sentence a fresh index AFTER the listener's. Pure index order
        // reads s1, listener, s2 — persisted/export order must be the spoken
        // order: s1, s2, listener.
        let store = TranscriptStore()
        let volatileID = SegmentID()
        let secondID = SegmentID()
        await store.append(id: volatileID, text: "first sentence. second sentence", range: 0.0...5.0)
        let listenerID = await store.appendListener(
            text: "mm", tier: .acknowledge, estimatedRange: 5.0...6.0
        )
        await store.closeListener(id: listenerID, actualEnd: 6.5)
        await store.finalize(id: volatileID, into: [
            FinalizedText(id: volatileID, text: "First sentence.", range: 0.0...2.5),
            FinalizedText(id: secondID, text: "Second sentence.", range: 2.5...5.0),
        ])

        // Persisted rows come back index-sorted (SwiftData relationships are
        // unordered; `index` is the append order) — exactly the interleaved shape.
        let byIndex = await store.snapshot().sorted { $0.index < $1.index }
        XCTAssertEqual(byIndex.map(\.text), ["First sentence.", "mm", "Second sentence."],
                       "append order really does interleave — the fixture is honest")

        let entries = storedEntries(from: byIndex)
        XCTAssertEqual(entries.map(\.text), ["First sentence.", "Second sentence.", "mm"],
                       "storage/export order is chronological: (audioStart, index)")
        XCTAssertEqual(entries.map(\.speaker), ["thinker", "thinker", "listener"])
    }

    // ── PR#37-era timings (port plan §5.3 part 1) ──
    //
    // These three pin the fix for a silent data-loss path: `JSONDecoder` ignores
    // unknown keys, so before `startMs`/`endMs` existed on this type, a PR#37-era
    // blob decoded through it *successfully* and dropped its timings with no
    // error — which would have denied replay to every session recorded on
    // current main, permanently and invisibly.

    func testStoredEntryDecodesPR37Timings() throws {
        // A blob in the exact shape PR#37's encoder wrote: the four original
        // keys plus startMs/endMs.
        let pr37 = Data("""
        [{"speaker":"thinker","text":"So the whole point is momentum.","turn":1,"startMs":1500,"endMs":4200},
         {"speaker":"listener","text":"mm-hm","tier":"acknowledge","turn":1,"startMs":4300,"endMs":4800}]
        """.utf8)

        let entries = try JSONDecoder().decode([StoredEntry].self, from: pr37)
        XCTAssertEqual(entries.map(\.startMs), [1500, 4300] as [Int?], "PR#37 timings survive the decode")
        XCTAssertEqual(entries.map(\.endMs), [4200, 4800] as [Int?])

        // And the base-era blob — no such keys — must still decode, as nil.
        let base = Data("""
        [{"speaker":"thinker","text":"no timings here","turn":1}]
        """.utf8)
        let legacy = try JSONDecoder().decode([StoredEntry].self, from: base)
        XCTAssertEqual(legacy.map(\.startMs), [nil] as [Int?], "base-era blobs decode with absent timings")
        XCTAssertEqual(legacy.map(\.endMs), [nil] as [Int?])
    }

    func testSegmentsFromEntriesCarryTimings() {
        let entries = [
            StoredEntry(speaker: "thinker", text: "timed", tier: nil, turn: 1,
                        startMs: 1500, endMs: 4200),
            StoredEntry(speaker: "listener", text: "mm", tier: "acknowledge", turn: 1,
                        startMs: 4300, endMs: 4800),
            StoredEntry(speaker: "thinker", text: "untimed", tier: nil, turn: 2),
        ]

        let restored = segments(from: entries)
        XCTAssertEqual(restored[0].audioStart, 1.5, accuracy: 0.0001, "ms → s, ÷1000")
        XCTAssertEqual(restored[0].audioEnd, 4.2, accuracy: 0.0001)
        XCTAssertEqual(restored[1].audioStart, 4.3, accuracy: 0.0001)
        XCTAssertEqual(restored[1].audioEnd, 4.8, accuracy: 0.0001)

        XCTAssertEqual(restored[2].audioStart, 0, "an entry with no timings rehydrates zeroed")
        XCTAssertEqual(restored[2].audioEnd, 0)

        XCTAssertTrue(hasTimings(restored), "a blob carrying real timings keeps replay")
        XCTAssertFalse(hasTimings(segments(from: [entries[2]])),
                       "a blob carrying none still degrades to the static view")
    }

    func testStoredEntryRoundTripsTimings() {
        // storedEntries(from:) → segments(from:) must preserve the ranges, or
        // every new record flattens on export exactly as the PR#37 blobs did.
        let segs = [
            segment(speaker: .thinker, text: "first", turn: 1, range: 1.5...4.2, index: 0),
            segment(speaker: .listener, text: "mm", turn: 1, tier: .acknowledge,
                    range: 4.3...4.8, index: 1),
        ]

        let entries = storedEntries(from: segs)
        XCTAssertEqual(entries.map(\.startMs), [1500, 4300] as [Int?], "the export DTO carries the ranges out")
        XCTAssertEqual(entries.map(\.endMs), [4200, 4800] as [Int?])

        let restored = segments(from: entries)
        XCTAssertEqual(restored.map(\.audioStart), segs.map(\.audioStart))
        XCTAssertEqual(restored.map(\.audioEnd), segs.map(\.audioEnd))
        XCTAssertTrue(hasTimings(restored))

        // The other direction of the bijection: a zero-range segment writes back
        // as ABSENT, not as 0, so a base-era record stays byte-identical through
        // a round trip rather than gaining keys the app's encoder never wrote.
        let untimed = [segment(speaker: .thinker, text: "legacy", turn: 1, index: 0)]
        let untimedEntries = storedEntries(from: untimed)
        XCTAssertEqual(untimedEntries.map(\.startMs), [nil] as [Int?])
        XCTAssertEqual(untimedEntries.map(\.endMs), [nil] as [Int?])
        XCTAssertFalse(hasTimings(segments(from: untimedEntries)))
    }

    func testHasTimings() {
        let zeroed = [
            segment(speaker: .thinker, text: "a", turn: 1, index: 0),
            segment(speaker: .listener, text: "b", turn: 1, tier: .acknowledge, index: 1),
        ]
        XCTAssertFalse(hasTimings(zeroed))
        XCTAssertFalse(hasTimings([]))

        let timed = zeroed + [segment(speaker: .thinker, text: "c", turn: 2, range: 3.5...4.0, index: 2)]
        XCTAssertTrue(hasTimings(timed))
    }
}
