// The storage DTO and the segment ↔ entry mapping — persistence/export logic
// kept headless-testable (plan: "TranscriptCore also owns the storage DTO").
//
// `StoredEntry` is byte-compatible with the app target's original
// (ios/App/Support/SessionRecord.swift): same field names, same JSON encoding,
// so every previously persisted `transcriptJSON` blob still decodes. The app's
// own copy is replaced by this one in Phase 4 (schema V2 migration); until
// then the two coexist — this one is the canonical shape the migration stage
// and the stop-path bridge read through.
//
// Base-era records carry no timings, so `segments(from:)` restores zeroed ranges
// (order preserved via `index`) and `hasTimings` is how the detail view knows
// to degrade to the static, non-seek presentation (plan R3.3). PR#37-era records
// DO carry `startMs`/`endMs` in the blob, and those are mapped through — see the
// note on `startMs` below for the clock caveat.

import Foundation
import TurnEngine

/// One transcript line, flattened for storage. `speaker` is "thinker" or
/// "listener"; `tier` is the listener tier's raw value ("acknowledge" /
/// "reflection" / "question"), nil for thinker turns.
public struct StoredEntry: Codable, Equatable, Sendable {
    public let speaker: String
    public let text: String
    public let tier: String?
    public let turn: Int
    /// Utterance timing in ms, as PR#37-era records wrote it. Optional on
    /// purpose, and the optionality is load-bearing in both directions:
    /// base-era blobs legitimately carry no such keys and must still decode,
    /// while PR#37-era blobs carry them and must not be flattened.
    ///
    /// `JSONDecoder` ignores unknown keys, so before these existed a PR#37 blob
    /// decoded through this type *successfully* and silently lost its timings —
    /// which is exactly how the migration would have denied replay to every
    /// session recorded on current main, with no error and no log line.
    ///
    /// Clock caveat: PR#37 stamped these as wall-clock ms from the session's
    /// `clockOrigin`, whereas this module's `audioStart`/`audioEnd` are
    /// canonical fed-samples audio seconds. The two agree except across an
    /// interruption, where the wall clock keeps running and the audio clock does
    /// not. For a legacy record that is the best information that exists, and it
    /// is strictly better than zero.
    public let startMs: Int?
    public let endMs: Int?

    public init(
        speaker: String,
        text: String,
        tier: String?,
        turn: Int,
        startMs: Int? = nil,
        endMs: Int? = nil
    ) {
        self.speaker = speaker
        self.text = text
        self.tier = tier
        self.turn = turn
        self.startMs = startMs
        self.endMs = endMs
    }

    /// Flatten a segment for storage/export. The audio range is written back as
    /// ms so the DTO round-trips: without this, every NEW record exported and
    /// re-read would lose its timings the same way a PR#37-era blob did.
    ///
    /// A wholly-zero range writes back as *absent* rather than as `0`, which
    /// makes the mapping a true inverse of `segments(from:)` in both directions
    ///   — nil → 0 → nil      (base-era: no timings were ever recorded)
    ///   — 1500 → 1.5 → 1500  (PR#37-era and native: real timings preserved)
    /// and keeps a base-era blob byte-identical through a round trip, instead of
    /// inventing `"startMs":0` keys the app's encoder never wrote. An all-zero
    /// range IS this module's encoding of "no timings" — `hasTimings` reads it
    /// exactly the same way — so the two stay consistent by construction.
    public init(_ segment: TranscriptSegment) {
        let hasRange = segment.audioStart != 0 || segment.audioEnd != 0
        self.init(
            speaker: segment.speaker.rawValue,
            text: segment.text,
            tier: segment.tier?.rawValue,
            turn: segment.turn,
            startMs: hasRange ? Int((segment.audioStart * 1000).rounded()) : nil,
            endMs: hasRange ? Int((segment.audioEnd * 1000).rounded()) : nil
        )
    }
}

/// Flatten a segment log for storage/export, in CHRONOLOGICAL order —
/// (audioStart, index), not raw append order. The two can diverge: a
/// finalize-split allocates fresh indexes for the pieces after the first, so
/// a listener segment appended mid-volatile sits BETWEEN the split finals by
/// index while its audio plainly follows them. Sorting by audio time with the
/// index as tiebreak reads the log in spoken order; records that carried no
/// timings at all (all-zero ranges) fall back to pure index order through the
/// tiebreak. Records rehydrated from a PR#37-era blob sort by their real
/// ranges, which is the same answer the tiebreak was standing in for.
/// Empty lines are dropped — same as the old stop-path save — but blank
/// segments are the only filter: volatile segments flatten too, so a
/// stop-path snapshot taken before the engine drained still keeps the words.
public func storedEntries(from segments: [TranscriptSegment]) -> [StoredEntry] {
    segments
        .sorted { ($0.audioStart, $0.index) < ($1.audioStart, $1.index) }
        .filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
        .map(StoredEntry.init)
}

/// Rehydrate stored entries as final segments: `index` = entry order,
/// store-minted IDs. An unknown speaker string falls to `thinker` — the
/// fail-safe reading for a hand-edited or future-versioned blob.
///
/// Audio ranges come from the entry's `startMs`/`endMs` when the blob carried
/// them (PR#37-era records), converted ms → s; entries without them (base-era
/// records, which never recorded timings) rehydrate zeroed and degrade to the
/// static view through `hasTimings`. This function and the app-side row
/// materializer must agree: a record must not gain or lose replay depending on
/// whether the migration stage reached it or the lazy read-path fallback did.
public func segments(from entries: [StoredEntry]) -> [TranscriptSegment] {
    entries.enumerated().map { position, entry in
        TranscriptSegment(
            id: SegmentID(),
            speaker: Speaker(rawValue: entry.speaker) ?? .thinker,
            text: entry.text,
            state: .final,
            audioStart: entry.startMs.map { Double($0) / 1000 } ?? 0,
            audioEnd: entry.endMs.map { Double($0) / 1000 } ?? 0,
            turn: entry.turn,
            tier: entry.tier.flatMap(Tier.init(rawValue:)),
            index: position
        )
    }
}

/// Whether replay affordances (tap-to-seek, follow-along highlight) have real
/// timings to work with: any segment with a non-zero range. Computed, never a
/// stored flag — base-era records recorded no timings, rehydrate zeroed, and
/// degrade to the static view; PR#37-era records carry real ranges through the
/// blob and keep replay.
public func hasTimings(_ segments: [TranscriptSegment]) -> Bool {
    segments.contains { $0.audioStart != 0 || $0.audioEnd != 0 }
}
