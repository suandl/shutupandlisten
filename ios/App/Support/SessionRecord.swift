// The session library's SwiftData schema — now VERSIONED, per the rewrite
// plan's PersistenceWriter section (docs/plans/
// 2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, R3 + "Migration"),
// reconciled with PR#37's own schema additions by the port plan
// (docs/plans/2026-08-02-001-port-transcript-core-onto-post-pr37-main-plan.md
// §5).
//
// THREE shapes have shipped or are about to, and V1 has to cover two of them:
//
//   base      (pre-PR#37)  the launch shape
//   PR#37     current main  + costUSD, + transcriptIsReconciled;
//                           StoredEntry gains startMs/endMs inside the blob
//   V2        this port     + state, transcriptJSON optional, SegmentRecord rows
//
// V1 BELOW IS DECLARED AT THE PR#37 SHAPE, NOT THE BASE SHAPE. The rewrite
// declared its V1 as a snapshot of the base — it had never seen PR#37 — so
// landing that as-is would point SwiftData's migration source at a shape that
// does not match the store on any device that ran a current-main build. Both
// PR#37 additions are lightweight-inferrable from the true base (costUSD is
// optional, transcriptIsReconciled is defaulted), so ONE V1 at the PR#37 shape
// opens a pre-PR#37 store and a PR#37 store alike.
//
// V2 is the incremental-persistence shape: the record is created at session
// START in `recording` state, grows a `SegmentRecord` row per finalized segment
// (cascade-deleted with the record), and is closed as `complete` at stop — or
// `recovered` by launch recovery after a crash (R3.1/R3.2).
//
// Migration runs in two halves, and NEITHER is a staged migration plan — that
// plan is gone, because SwiftData's staged migration manager cannot open the
// store this app shipped (it has to NAME the store's model version, and the
// base-era container was unversioned); `ShutUpAndListenApp.openContainer`
// records the finding in full. The halves that replace it:
//
// 1. SHAPE — inferred (lightweight) migration, which needs no version name.
//    Every V1 → V2 change is within its reach: a new entity, a new
//    relationship, `transcriptJSON` widened to optional, `transcriptIsReconciled`
//    REMOVED (attribute deletion is lightweight-migratable; reconciliation
//    itself is deleted, so the flag has no meaning), and `state` added with the
//    declaration default.
// 2. DATA — `PersistenceWriter.materializeLegacyRecords`, at launch: decode
//    each old record's `transcriptJSON` into `SegmentRecord` rows via
//    `materializeLegacySegments(in:)` below. Idempotent, so it is safe on every
//    launch and covers any record an earlier pass missed.
//
// The blob is KEPT as a legacy optional field, and the derived views fall back
// to decoding it on read whenever a record has no segment rows — the plan's
// lazy-materialize guard rail, and now also the safety net for a record the
// backfill has not reached yet. The two paths MUST agree: a record must not
// gain or lose replay depending on which one reached it.
//
// `costUSD` is carried INTO V2. The rewrite's V2 omitted it; dropping it would
// silently void the cost readout for every past session.
//
// The storage DTO (`StoredEntry`) and the segment ↔ entry mapping live in
// TranscriptCore — byte-compatible with the blob this app has always written,
// verified by TranscriptCoreTests/StoredEntryTests. The app-local StoredEntry
// struct that used to live in this file is gone.

import Foundation
import SwiftData
import TranscriptCore
import TurnEngine

/// The record's lifecycle (plan R3): `recording` from session start until a
/// graceful stop closes it as `complete`; a crash leaves it `recording` and
/// launch recovery closes it as `recovered`. Stored as the raw string —
/// `#Predicate` compares against raw values.
enum SessionState: String {
    case recording, complete, recovered
}

// ── Schema V1: the PR#37 shape (what current main writes) ──

enum SessionSchemaV1: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(1, 0, 0) }
    static var models: [any PersistentModel.Type] { [SessionRecord.self] }

    @Model
    final class SessionRecord {
        var id: UUID
        var startedAt: Date
        var duration: TimeInterval
        var title: String
        /// JSON-encoded `[StoredEntry]`. PR#37-era blobs carry per-utterance
        /// `startMs`/`endMs`; base-era blobs do not.
        var transcriptJSON: Data
        /// The coverage checklist in effect (one topic per line; may be empty).
        var criteriaText: String
        /// JSON-encoded `CoverageResult`, when a coverage check ran.
        var coverageJSON: Data?
        /// File name under Application Support/Recordings, when audio was captured.
        var audioFileName: String?
        /// PR#37. Optional, so a pre-PR#37 store still infers into this shape.
        var costUSD: Double?
        /// PR#37. Defaulted, so a pre-PR#37 store still infers into this shape.
        /// Dropped at V2 — the second offline transcription pass it gated is
        /// deleted, so the flag has no meaning there.
        var transcriptIsReconciled: Bool = false

        init(
            id: UUID = UUID(),
            startedAt: Date,
            duration: TimeInterval,
            title: String,
            transcriptJSON: Data,
            criteriaText: String,
            coverageJSON: Data? = nil,
            audioFileName: String? = nil,
            costUSD: Double? = nil,
            transcriptIsReconciled: Bool = false
        ) {
            self.id = id
            self.startedAt = startedAt
            self.duration = duration
            self.title = title
            self.transcriptJSON = transcriptJSON
            self.criteriaText = criteriaText
            self.coverageJSON = coverageJSON
            self.audioFileName = audioFileName
            self.costUSD = costUSD
            self.transcriptIsReconciled = transcriptIsReconciled
        }
    }
}

// ── Schema V2: incremental persistence (record-at-start + segment rows) ──

enum SessionSchemaV2: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(2, 0, 0) }
    static var models: [any PersistentModel.Type] {
        [SessionRecord.self, SegmentRecord.self]
    }

    @Model
    final class SessionRecord {
        var id: UUID
        var startedAt: Date
        var duration: TimeInterval
        var title: String
        /// Raw `SessionState`. The declaration default is what migrated V1
        /// records receive from the schema transform (every V1 record is a
        /// finished session); the custom stage re-stamps it anyway.
        var state: String = "complete"
        /// LEGACY: the V1 whole-transcript blob (JSON-encoded `[StoredEntry]`).
        /// Nil for records written under V2 — segments are the truth; this
        /// survives only as the lazy-materialize fallback for old records.
        var transcriptJSON: Data?
        /// The coverage checklist in effect (one topic per line; may be empty).
        var criteriaText: String
        /// JSON-encoded `CoverageResult`, when a coverage check ran.
        var coverageJSON: Data?
        /// File name under Application Support/Recordings, when audio was
        /// captured: the crash-safe `.caf` while `state == recording`, swapped
        /// to the remuxed `.m4a` at close-out/recovery. Set at session START so
        /// the file can never be orphaned (plan: record-at-start).
        var audioFileName: String?
        /// The session's model spend, when every call was metered — nil means
        /// "cost unknown", not "free" (the usage-less proxy path). Carried
        /// forward from PR#37: SessionDetailView reads it behind the
        /// `showCostReadout` toggle, so dropping it at V2 would have silently
        /// voided the readout for every past session.
        var costUSD: Double?
        /// One row per finalized transcript segment, owned by the record —
        /// deleting the record deletes its segments. SwiftData relationships
        /// are unordered; `SegmentRecord.index` is the order.
        @Relationship(deleteRule: .cascade, inverse: \SegmentRecord.session)
        var segments: [SegmentRecord] = []

        init(
            id: UUID = UUID(),
            startedAt: Date,
            duration: TimeInterval = 0,
            title: String,
            state: SessionState = .recording,
            transcriptJSON: Data? = nil,
            criteriaText: String,
            coverageJSON: Data? = nil,
            audioFileName: String? = nil,
            costUSD: Double? = nil
        ) {
            self.id = id
            self.startedAt = startedAt
            self.duration = duration
            self.title = title
            self.state = state.rawValue
            self.transcriptJSON = transcriptJSON
            self.criteriaText = criteriaText
            self.coverageJSON = coverageJSON
            self.audioFileName = audioFileName
            self.costUSD = costUSD
        }
    }

    /// One finalized transcript segment, mirroring `TranscriptSegment` minus
    /// `state` (only finals persist) and minus the engine's `SegmentID`
    /// (identity matters live, not at rest — `index` orders the log).
    @Model
    final class SegmentRecord {
        /// `Speaker` raw value: "thinker" or "listener".
        var speaker: String
        var text: String
        /// Listener tier raw value ("acknowledge"/"reflection"/"question"),
        /// nil for thinker segments.
        var tier: String?
        var turn: Int
        /// Canonical timeline (recorded-audio seconds). Zeroed only for
        /// segments materialized from a legacy blob that carried no timings at
        /// all (base-era records); a PR#37-era blob materializes with real
        /// ranges.
        var audioStart: TimeInterval
        var audioEnd: TimeInterval
        /// Listener segment cut short by barge-in — replay/export must never
        /// present the unspoken tail as spoken.
        var bargedIn: Bool
        /// Monotonic append order within the session.
        var index: Int
        var session: SessionRecord?

        init(
            speaker: String,
            text: String,
            tier: String?,
            turn: Int,
            audioStart: TimeInterval,
            audioEnd: TimeInterval,
            bargedIn: Bool,
            index: Int
        ) {
            self.speaker = speaker
            self.text = text
            self.tier = tier
            self.turn = turn
            self.audioStart = audioStart
            self.audioEnd = audioEnd
            self.bargedIn = bargedIn
            self.index = index
        }
    }
}

/// The app speaks the current schema version unqualified.
typealias SessionRecord = SessionSchemaV2.SessionRecord
typealias SegmentRecord = SessionSchemaV2.SegmentRecord

// NOTE: there is no `SchemaMigrationPlan` here by design — see the header and
// `ShutUpAndListenApp.openContainer`. SessionSchemaV1 stays even though nothing
// migrates *through* it now: it is the written record of the shipped shape, and
// MigrationTests needs it to write a real V1 store to migrate from.

// ── Derived views (segments first, legacy blob as the guard-rail fallback) ──

extension SessionSchemaV2.SessionRecord {
    static let placeholderTitle = "Session in progress"

    var sessionState: SessionState {
        SessionState(rawValue: state) ?? .complete
    }

    /// The segment rows in CHRONOLOGICAL order — (audioStart, index), matching
    /// TranscriptCore's storedEntries ordering. Append order (`index`) alone
    /// can interleave wrongly: a finalize-split gives the pieces after the
    /// first fresh indexes, so a listener segment appended mid-volatile would
    /// sort between the split thinker sentences. Rows materialized from a blob
    /// that carried no timings are all-zero and fall back to pure index order
    /// through the tiebreak; rows from a PR#37-era blob carry real ranges and
    /// sort correctly by `(audioStart, index)` — the same answer the tiebreak
    /// was standing in for.
    var orderedSegments: [SegmentRecord] {
        segments.sorted { ($0.audioStart, $0.index) < ($1.audioStart, $1.index) }
    }

    /// The legacy V1 blob, decoded. Empty for V2-written records.
    var legacyEntries: [StoredEntry] {
        guard let transcriptJSON else { return [] }
        return (try? JSONDecoder().decode([StoredEntry].self, from: transcriptJSON)) ?? []
    }

    /// The transcript as TranscriptCore segments: from the segment rows when
    /// any exist, otherwise decoded lazily from the legacy blob — the guard
    /// rail for records the migration stage never touched. That fallback goes
    /// through `TranscriptCore.segments(from:)`, which maps the blob's
    /// `startMs`/`endMs` exactly as `materializeLegacySegments` does, so a
    /// record cannot gain or lose replay depending on which path reached it.
    /// The read path deliberately does NOT insert rows (mutating a model from
    /// a SwiftUI body read is asking for trouble); row materialization is the
    /// migration stage's job, via `materializeLegacySegments(in:)`.
    /// NOTE: the returned segments carry fresh, per-call `SegmentID`s — order
    /// by position, never by `id`, when diffing.
    var transcriptSegments: [TranscriptSegment] {
        let ordered = orderedSegments
        guard ordered.isEmpty else { return ordered.map(\.transcriptSegment) }
        return TranscriptCore.segments(from: legacyEntries)
    }

    /// The transcript flattened to the storage/export DTO.
    var entries: [StoredEntry] {
        transcriptSegments.map(StoredEntry.init)
    }

    /// Whether replay affordances (tap-to-seek, follow-along highlight) have
    /// real timings to work with (R3.3). Rows materialized from a blob that
    /// carried no timings (base-era records) are zeroed, so those degrade to
    /// the static view; PR#37-era records migrate with real ranges and keep
    /// replay.
    ///
    /// Source selection mirrors `transcriptSegments` exactly — rows when any
    /// exist, the legacy blob otherwise — because the two answer the same
    /// question about the same transcript. Reading only the stored rows would
    /// report "no timings" for a PR#37-era record the migration stage never
    /// materialized, while the fallback hands the view timed segments: the
    /// replay affordances would be withheld from a record that has the timings
    /// to drive them.
    ///
    /// The row path stays a plain scan (no sort, no segment mapping); the
    /// fallback decodes the blob, which is why SessionDetailView reads this
    /// once per body rather than once per rendered line.
    var hasTimings: Bool {
        guard segments.isEmpty else {
            return segments.contains { $0.audioStart != 0 || $0.audioEnd != 0 }
        }
        return TranscriptCore.hasTimings(transcriptSegments)
    }

    var coverage: CoverageResult? {
        guard let coverageJSON else { return nil }
        return try? JSONDecoder().decode(CoverageResult.self, from: coverageJSON)
    }

    /// True when the listener asked at least one question in this session.
    var hasThreadPull: Bool {
        entries.contains { $0.tier == Tier.question.rawValue }
    }

    /// Everything said, joined — for library search.
    var searchableText: String {
        entries.map(\.text).joined(separator: " ")
    }

    /// The thread-pull the thinker left with: the LAST question the listener
    /// asked. The listener's whole job was this one sentence — post-session it
    /// becomes the record's durable hook and natural resume point.
    var openQuestion: String? {
        entries.last {
            $0.speaker == "listener" && $0.tier == Tier.question.rawValue
        }?.text
    }

    /// Whether the thinker said anything after the open question — i.e. the
    /// question got at least an attempt, rather than ending the session cold.
    /// Reads `entries`, the same source as `openQuestion`, so the card's check
    /// mark always describes the question the card is showing.
    var openQuestionAnsweredByThinker: Bool {
        let all = entries
        guard let idx = all.lastIndex(where: {
            $0.speaker == "listener" && $0.tier == Tier.question.rawValue
        }) else { return false }
        return all[(idx + 1)...].contains {
            $0.speaker == "thinker" && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    /// Title from the first ~8 words of the first thinker turn. The fallback
    /// string should be unreachable in practice — the zero-speech rule deletes
    /// sessions with no thinker segment — but any edge case still gets a
    /// readable row.
    static func deriveTitle(from entries: [StoredEntry]) -> String {
        guard let first = entries.first(where: {
            $0.speaker == "thinker" && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty
        }) else { return "Untitled session" }
        let words = first.text.split(whereSeparator: { $0.isWhitespace })
        let head = words.prefix(8).joined(separator: " ")
        return words.count > 8 ? head + "…" : head
    }

    /// The legacy backfill's materializer (`PersistenceWriter
    /// .materializeLegacyRecords`, at launch): decode the legacy blob into
    /// `SegmentRecord` rows, index = array order. Idempotent — a record that
    /// already has rows is left alone. The blob is kept as the
    /// belt-and-suspenders original.
    ///
    /// THE TIMINGS ARE CARRIED THROUGH, and this is the function where that
    /// actually matters: the backfill does not go through
    /// `TranscriptCore.segments(from:)` at all, so teaching `StoredEntry` to
    /// decode `startMs`/`endMs` changes nothing observable without this edit.
    /// Zeroing here would migrate every PR#37-era session replay-less,
    /// permanently and with no error. Entries that carry no timings (base-era
    /// blobs) still materialize zeroed, which is what keeps this a fix rather
    /// than an invention of timings that were never recorded.
    ///
    /// TIMING FIDELITY, and its documented approximation: PR#37 wrote
    /// `startMs`/`endMs` as WALL-clock ms from the session's `clockOrigin`,
    /// whereas V2's `audioStart`/`audioEnd` are canonical FED-SAMPLES audio
    /// seconds. The two agree except across an interruption, where the wall
    /// clock keeps running and the audio clock does not. Carrying them across
    /// is strictly better than zeroing them: the alternative loses working
    /// replay on every existing session to avoid drift on the subset that was
    /// interrupted.
    func materializeLegacySegments(in context: ModelContext) {
        guard segments.isEmpty else { return }
        for (position, entry) in legacyEntries.enumerated() {
            let row = SegmentRecord(
                speaker: entry.speaker,
                text: entry.text,
                tier: entry.tier,
                turn: entry.turn,
                audioStart: entry.startMs.map { Double($0) / 1000 } ?? 0,
                audioEnd: entry.endMs.map { Double($0) / 1000 } ?? 0,
                bargedIn: false,
                index: position
            )
            context.insert(row)
            row.session = self
        }
    }

    // ── export ──

    /// Markdown export: title, date, transcript, coverage when present.
    var markdown: String {
        var lines: [String] = ["# \(title)", ""]
        lines.append(startedAt.formatted(date: .abbreviated, time: .shortened))
        lines.append("")
        for entry in entries where !entry.text.isEmpty {
            lines.append("\(Self.markdownLabel(for: entry)) \(entry.text)")
            lines.append("")
        }
        if let coverage {
            lines.append("## Coverage")
            lines.append("")
            for topic in coverage.topics {
                let mark = topic.covered ? "x" : " "
                let evidence = topic.covered && !topic.evidence.isEmpty
                    ? " — “\(topic.evidence)”" : ""
                lines.append("- [\(mark)] \(topic.topic)\(evidence)")
            }
            if !coverage.nudge.isEmpty {
                lines.append("")
                lines.append("> \(coverage.nudge)")
            }
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    private static func markdownLabel(for entry: StoredEntry) -> String {
        guard entry.speaker == "listener" else { return "**You:**" }
        switch entry.tier {
        case Tier.question.rawValue: return "**Listener (thread-pull):**"
        case Tier.reflection.rawValue: return "**Listener (reflection):**"
        default: return "**Listener:**"
        }
    }
}

extension SessionSchemaV2.SegmentRecord {
    /// Rehydrate as a TranscriptCore segment. The `SegmentID` is minted fresh
    /// per call (engine identity is a live concern, not a stored one) — do not
    /// use it as a stable diffing key. An unknown speaker string falls to
    /// `thinker`, matching TranscriptCore's fail-safe reading.
    var transcriptSegment: TranscriptSegment {
        TranscriptSegment(
            id: SegmentID(),
            speaker: Speaker(rawValue: speaker) ?? .thinker,
            text: text,
            state: .final,
            audioStart: audioStart,
            audioEnd: audioEnd,
            turn: turn,
            tier: tier.flatMap(Tier.init(rawValue:)),
            bargedIn: bargedIn,
            index: index
        )
    }
}
