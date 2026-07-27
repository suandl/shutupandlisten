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
