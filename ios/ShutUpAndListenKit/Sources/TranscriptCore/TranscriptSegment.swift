// The transcript spine's model types — the segment log entries every consumer
// (live UI, persistence, agents, the turn engine's evidence feed) shares.
//
// Part of the iOS 26 capture rewrite
// (docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md). Two
// load-bearing decisions from that plan live here:
//
// 1. SEGMENT IDENTITY IS THE ENGINE'S JOB. The transcription engine issues a
//    stable `SegmentID` when a volatile segment opens and keeps it across every
//    revision; the store never infers identity from audio ranges. That is what
//    makes "the same segment, revised" a fact rather than a heuristic — the old
//    build anchored utterances by character offset into a mutable string, which
//    could point past the end or into different words exactly when the gate
//    evaluated.
//
// 2. THE CANONICAL TIMELINE IS RECORDED-AUDIO POSITION (seconds of audio
//    actually fed since session start). `audioStart`/`audioEnd` are on that
//    timeline, which is what keeps replay in sync across interruptions by
//    construction: while no audio flows, neither the file nor these ranges
//    advance.
//
// Pure Swift, no audio or UI imports — testable headlessly on macOS/Linux.

import Foundation
import TurnEngine

/// Stable identity for one transcript segment, issued by whoever CREATES the
/// segment (the transcription engine for thinker segments, the store for
/// listener segments) and held constant from the first volatile appearance
/// through finalization. A small opaque value type on purpose: nothing about a
/// segment's position or timing leaks into its identity.
public struct SegmentID: Hashable, Sendable, Codable, CustomStringConvertible {
    private let raw: UUID

    public init() {
        raw = UUID()
    }

    public init(from decoder: Decoder) throws {
        raw = try decoder.singleValueContainer().decode(UUID.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(raw)
    }

    public var description: String { raw.uuidString }
}

/// Who said it. `thinker` is the human at the mic; `listener` is the quiet
/// companion (whose rare replies are appended by the host, not transcribed).
public enum Speaker: String, Codable, Sendable {
    case thinker, listener
}

/// One line of the append-only transcript log.
public struct TranscriptSegment: Codable, Equatable, Sendable, Identifiable {
    /// A segment is `volatile` while the engine may still revise it in place
    /// (or, for a listener segment, while the reply is still being spoken);
    /// `final` once its text and timing are settled. Finalization is one-way.
    public enum State: String, Codable, Sendable {
        case volatile, final
    }

    /// Engine-issued, stable volatile → final.
    public let id: SegmentID
    public let speaker: Speaker
    public var text: String
    public var state: State
    /// Canonical timeline (recorded-audio seconds). Volatile ranges are
    /// approximate; finalized ranges are trusted for seek/replay. Listener
    /// segments carry an estimate until `closeListener` supplies the actual end.
    public var audioStart: TimeInterval
    public var audioEnd: TimeInterval
    /// Derived by the store from the recorded turn boundaries — the segment is
    /// tagged with the turn whose boundary interval contains `audioStart`
    /// (0 before any turn has started). See TranscriptStore's turn tagging.
    public var turn: Int
    /// Listener segments only: the response-hierarchy rung the reply came from.
    public var tier: Tier?
    /// Listener segment cut short by barge-in — replay/export must never
    /// present the unspoken tail as spoken.
    public var bargedIn: Bool
    /// Monotonic append order. SwiftData relationships are unordered; this is
    /// the order. Preserved across volatile → final for the segment that keeps
    /// its ID; store-side splits give the extra pieces fresh indexes.
    public var index: Int

    public init(
        id: SegmentID,
        speaker: Speaker,
        text: String,
        state: State,
        audioStart: TimeInterval,
        audioEnd: TimeInterval,
        turn: Int,
        tier: Tier? = nil,
        bargedIn: Bool = false,
        index: Int
    ) {
        self.id = id
        self.speaker = speaker
        self.text = text
        self.state = state
        self.audioStart = audioStart
        self.audioEnd = audioEnd
        self.turn = turn
        self.tier = tier
        self.bargedIn = bargedIn
        self.index = index
    }
}

/// Word/run timing within a segment's text: which UTF-16 slice of the text was
/// spoken over which slice of the canonical timeline. Offsets are UTF-16 code
/// units, NOT `String.Index` (and not grapheme counts) — that is the unit the
/// platform transcribers report and the only one that survives serialization.
///
/// Defined here rather than next to the app-side `TranscriptionEngine`
/// protocol because the STORE consumes runs (splitting a finalized segment at
/// a turn boundary, carving the post-boundary portion of a straddling
/// volatile) — the type is shared, the protocol is not.
public struct TimedRun: Equatable, Sendable {
    public let charOffset: Int
    public let charLength: Int
    public let audioStart: TimeInterval
    public let audioEnd: TimeInterval

    public init(charOffset: Int, charLength: Int, audioStart: TimeInterval, audioEnd: TimeInterval) {
        self.charOffset = charOffset
        self.charLength = charLength
        self.audioStart = audioStart
        self.audioEnd = audioEnd
    }
}

/// One finalized text the engine produced when closing a volatile segment.
/// A single volatile may finalize into SEVERAL of these (sentence-level
/// splits); each carries its own engine-issued ID — reusing the volatile's ID
/// for the first is the engine's call, and keeps that segment's identity
/// stable volatile → final.
public struct FinalizedText: Equatable, Sendable {
    public let id: SegmentID
    public let text: String
    public let range: ClosedRange<TimeInterval>
    public let runs: [TimedRun]

    public init(id: SegmentID, text: String, range: ClosedRange<TimeInterval>, runs: [TimedRun] = []) {
        self.id = id
        self.text = text
        self.range = range
        self.runs = runs
    }
}

/// The multicast event log every subscriber shares (R4.1). Segment payloads
/// are value snapshots taken at emit time, so a slow consumer can never
/// observe a segment mid-mutation.
public enum TranscriptEvent: Equatable, Sendable {
    case segmentAdded(TranscriptSegment)
    case segmentRevised(TranscriptSegment)
    case segmentFinalized(TranscriptSegment)
    case turnStarted(turn: Int, atAudioTime: TimeInterval)
}
