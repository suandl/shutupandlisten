// The authoritative saved transcript (spec §1): derived from the finished
// .m4a, not the lossy live stream. A file-based recognition pass yields
// timestamped thinker segments (the mic file is thinker-only — AEC removed our
// own TTS). The machine already recorded turn windows (so grouping and
// tap-to-seek survive), and we synthesized the listener lines. reconcile()
// folds all three into one time-ordered entry list.
//
// PURE — no audio, no I/O. The App runs SFSpeechURLRecognitionRequest to get
// the segments, then maps ReconciledEntry back onto its StoredEntry rows.

import Foundation

/// One timestamped chunk of file-derived transcription (thinker audio). ms are
/// offsets into the session audio, which shares the machine's clock origin.
public struct TranscriptSegment: Equatable, Sendable {
    public let text: String
    public let startMs: Int
    public let endMs: Int

    public init(text: String, startMs: Int, endMs: Int) {
        self.text = text
        self.startMs = startMs
        self.endMs = endMs
    }
}

/// A thinker turn as the live machine recorded it — identity and timing, used
/// to group file segments back into the turns the app displayed. `endMs` is nil
/// for a turn that never closed (the session stopped mid-thought).
public struct TurnWindow: Equatable, Sendable {
    public let turn: Int
    public let startMs: Int
    public let endMs: Int?

    public init(turn: Int, startMs: Int, endMs: Int?) {
        self.turn = turn
        self.startMs = startMs
        self.endMs = endMs
    }
}

/// A synthesized listener line — it is NOT in the mic .m4a (AEC removed it), so
/// it is inserted from what we spoke, at the time we spoke it.
public struct ListenerLine: Equatable, Sendable {
    public let text: String
    public let tier: Tier
    public let turn: Int
    public let startMs: Int

    public init(text: String, tier: Tier, turn: Int, startMs: Int) {
        self.text = text
        self.tier = tier
        self.turn = turn
        self.startMs = startMs
    }
}

/// A reconciled transcript entry. `speaker`/`tier` mirror `StoredEntry` so the
/// App maps this straight onto a saved row. Thinker text is file-authoritative;
/// listener text is the line we synthesized.
public struct ReconciledEntry: Equatable, Sendable {
    public enum Speaker: String, Sendable {
        case thinker, listener
        var rank: Int { self == .thinker ? 0 : 1 }
    }
    public let speaker: Speaker
    public let text: String
    public let tier: Tier?
    public let turn: Int
    public let startMs: Int
    public let endMs: Int?

    public init(speaker: Speaker, text: String, tier: Tier?, turn: Int, startMs: Int, endMs: Int?) {
        self.speaker = speaker
        self.text = text
        self.tier = tier
        self.turn = turn
        self.startMs = startMs
        self.endMs = endMs
    }
}

public enum TranscriptReconciler {
    /// Fold file-derived thinker `segments`, the machine's `turns`, and the
    /// synthesized `listenerLines` into one authoritative, time-ordered list.
    /// Each thinker turn becomes at most one entry (its segments joined);
    /// listener lines are inserted at their own timestamps. On a timestamp tie,
    /// the thinker turn precedes the listener line.
    public static func reconcile(
        segments: [TranscriptSegment],
        turns: [TurnWindow],
        listenerLines: [ListenerLine]
    ) -> [ReconciledEntry] {
        let sortedTurns = turns.sorted { $0.startMs < $1.startMs }

        // The turn active when a moment `ms` began: the last turn whose start it
        // is at or past. A moment before the first turn attaches to the first.
        func owningTurn(at ms: Int) -> Int? {
            guard let first = sortedTurns.first else { return nil }
            var owner = first.turn
            for t in sortedTurns where t.startMs <= ms { owner = t.turn }
            return owner
        }

        // Group thinker segments by their owning turn, preserving first-seen order.
        var byTurn: [Int: (startMs: Int, endMs: Int, texts: [String])] = [:]
        var order: [Int] = []
        for seg in segments.sorted(by: { $0.startMs < $1.startMs }) {
            let text = seg.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let turnId = owningTurn(at: seg.startMs) ?? 0
            if var g = byTurn[turnId] {
                g.texts.append(text)
                g.endMs = max(g.endMs, seg.endMs)
                byTurn[turnId] = g
            } else {
                byTurn[turnId] = (seg.startMs, seg.endMs, [text])
                order.append(turnId)
            }
        }

        var entries: [ReconciledEntry] = order.compactMap { turnId in
            guard let g = byTurn[turnId] else { return nil }
            return ReconciledEntry(
                speaker: .thinker, text: g.texts.joined(separator: " "),
                tier: nil, turn: turnId, startMs: g.startMs, endMs: g.endMs
            )
        }

        for line in listenerLines {
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            entries.append(ReconciledEntry(
                speaker: .listener, text: text, tier: line.tier,
                turn: line.turn, startMs: line.startMs, endMs: nil
            ))
        }

        return entries.sorted {
            $0.startMs != $1.startMs ? $0.startMs < $1.startMs : $0.speaker.rank < $1.speaker.rank
        }
    }
}
