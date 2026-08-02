// One growing, seam-free live transcript across recognition-task rotations.
//
// SFSpeechRecognizer has a ~1-minute duty-cycle limit, so the recorder rotates
// its recognition task internally. To avoid dropping words during the hop, the
// replacement task is fed a short REPLAYED tail of mic audio — which means its
// first words re-transcribe the end of what we already have. `merge` strips
// that overlap; `TranscriptStitcher` drives the two-task lifecycle with it.
//
// PURE — no audio, no I/O. The live transcript is best-effort by design (spec
// §1): the authoritative saved transcript is derived from the .m4a by
// TranscriptReconciler, so this only has to be seam-free, not perfect.

import Foundation

public enum TranscriptStitching {
    /// Append `incoming` onto `committed`, stripping the leading run of
    /// `incoming` that duplicates the trailing run of `committed`. The overlap
    /// is matched on whitespace-split, case-insensitive words; only a run of at
    /// least `minOverlapWords` counts, so a one-word coincidence between
    /// genuinely-new speech is appended, not merged away. The LONGEST qualifying
    /// overlap wins.
    public static func merge(
        committed: String,
        incoming: String,
        minOverlapWords: Int = 2
    ) -> String {
        let base = committed.trimmingCharacters(in: .whitespacesAndNewlines)
        let inc = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
        if base.isEmpty { return inc }
        if inc.isEmpty { return base }

        let baseWords = base.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let incWords = inc.split(whereSeparator: { $0.isWhitespace }).map(String.init)

        let maxK = min(baseWords.count, incWords.count)
        var k = maxK
        while k >= minOverlapWords {
            let baseTail = baseWords.suffix(k).map { $0.lowercased() }
            let incHead = incWords.prefix(k).map { $0.lowercased() }
            if baseTail == incHead {
                let remainder = incWords.dropFirst(k)
                return remainder.isEmpty ? base : base + " " + remainder.joined(separator: " ")
            }
            k -= 1
        }
        return base + " " + inc
    }
}

/// The stateful driver `SpeechTranscriber` owns. `committed` is text finalized
/// by completed recognition tasks; `partial` is the active task's in-flight
/// result. `text` overlays the partial onto committed via `merge`, so a
/// replayed-tail partial de-dups and a task's final replaces its own partial.
public struct TranscriptStitcher: Equatable, Sendable {
    private var committed = ""
    private var partial = ""
    private let minOverlapWords: Int

    public init(minOverlapWords: Int = 2) {
        self.minOverlapWords = minOverlapWords
    }

    /// The active recognition task refined its in-flight partial.
    public mutating func setPartial(_ text: String) {
        partial = text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The active task ended (a final result, or a proactive rotation). Fold its
    /// text into the committed transcript — stripping any overlap a replayed
    /// audio tail re-transcribed — and clear the partial for the next task.
    public mutating func commit(_ text: String) {
        committed = TranscriptStitching.merge(
            committed: committed, incoming: text, minOverlapWords: minOverlapWords
        )
        partial = ""
    }

    /// The active task went away WITHOUT a final — a proactive rotation, or a
    /// task that died with an error. Lock in whatever it had heard: the live
    /// partial becomes committed text, so the replacement task's first partial
    /// (which only re-covers the short replayed tail) can't overwrite the
    /// minute of speech that lived only here. `text` is unchanged by this call
    /// — it just stops being fragile — and with no partial in flight it is a
    /// no-op, so callers can fire it on any teardown path.
    public mutating func commitPartial() {
        commit(partial)
    }

    /// A new session: empty everything.
    public mutating func reset() {
        committed = ""
        partial = ""
    }

    /// One growing transcript: committed text with the live partial overlaid.
    public var text: String {
        TranscriptStitching.merge(
            committed: committed, incoming: partial, minOverlapWords: minOverlapWords
        )
    }
}
