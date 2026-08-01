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
// Old records carry no timings, so `segments(from:)` restores zeroed ranges
// (order preserved via `index`) and `hasTimings` is how the detail view knows
// to degrade to the static, non-seek presentation (plan R3.3).

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

    public init(speaker: String, text: String, tier: String?, turn: Int) {
        self.speaker = speaker
        self.text = text
        self.tier = tier
        self.turn = turn
    }

    public init(_ segment: TranscriptSegment) {
        self.init(
            speaker: segment.speaker.rawValue,
            text: segment.text,
            tier: segment.tier?.rawValue,
            turn: segment.turn
        )
    }
}

/// Flatten a segment log for storage/export, in log order. Empty lines are
/// dropped — same as the old stop-path save — but blank segments are the only
/// filter: volatile segments flatten too, so a stop-path snapshot taken before
/// the engine drained still keeps the words.
public func storedEntries(from segments: [TranscriptSegment]) -> [StoredEntry] {
    segments
        .filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
        .map(StoredEntry.init)
}

/// Rehydrate stored entries as final segments: zeroed audio ranges (old
/// records carry no timings), `index` = entry order, store-minted IDs. An
/// unknown speaker string falls to `thinker` — the fail-safe reading for a
/// hand-edited or future-versioned blob.
public func segments(from entries: [StoredEntry]) -> [TranscriptSegment] {
    entries.enumerated().map { position, entry in
        TranscriptSegment(
            id: SegmentID(),
            speaker: Speaker(rawValue: entry.speaker) ?? .thinker,
            text: entry.text,
            state: .final,
            audioStart: 0,
            audioEnd: 0,
            turn: entry.turn,
            tier: entry.tier.flatMap(Tier.init(rawValue:)),
            index: position
        )
    }
}

/// Whether replay affordances (tap-to-seek, follow-along highlight) have real
/// timings to work with: any segment with a non-zero range. Computed, never a
/// stored flag — pre-migration records rehydrate with zeroed ranges and
/// degrade to the static view.
public func hasTimings(_ segments: [TranscriptSegment]) -> Bool {
    segments.contains { $0.audioStart != 0 || $0.audioEnd != 0 }
}
