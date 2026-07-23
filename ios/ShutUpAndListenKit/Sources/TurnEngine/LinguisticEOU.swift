// A lightweight, transcript-only end-of-utterance heuristic.
//
// The web build's EOU stage is the smart-turn v3 acoustic classifier; iOS v1
// has no on-device port of it, so this heuristic stands in — a deliberate
// "substitute and note", exactly the pattern the web adapters use when a model
// is unavailable. It scores P(complete) from the words alone: a pause after a
// trailing conjunction ("and", "because", …) or a discourse marker ("…", ",")
// is almost certainly a thinking-pause, and a pause after terminal punctuation
// or a wrap-up phrase ("that's the gist") is probably a finished thought.
//
// It feeds the SAME asymmetric veto as smart-turn does (spec §2): an
// `incomplete` reading can only EXTEND patience, never shorten it, so the
// worst a bad score can do is make the companion more patient — the failure
// mode the product prefers. Setting `useSmartTurn = false` in the knobs
// collapses to the patience-only baseline arm, and the gate then falls back to
// the two-valued turn-end bridge.

import Foundation

public enum LinguisticEOU {
    /// Words that, when a pause lands right after them, read as "still going".
    /// Trailing conjunctions, prepositions mid-reach, and fillers.
    static let trailingContinuations: Set<String> = [
        "and", "but", "or", "so", "because", "then", "also", "plus", "like",
        "the", "a", "an", "to", "of", "with", "that", "which", "if", "when",
        "while", "where", "since", "although", "though", "unless", "whereas",
        "um", "uh", "erm", "hmm", "basically", "maybe",
    ]

    /// Phrases that hand the idea over — the thinker wrapped the thought.
    static let wrapUps: [String] = [
        "that's it", "thats it", "that's the gist", "thats the gist",
        "that's basically it", "thats basically it", "that's the whole thing",
        "thats the whole thing", "so yeah", "what do you think",
    ]

    /// P(complete) for a pause that just followed `text` (the utterance so far).
    /// Returns a probability the detector thresholds with `completionThreshold`
    /// and the gate reads directly as `EvalContext.completionProb`.
    public static func completionProbability(for text: String) -> Double {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return 0.5 } // no evidence either way

        let lowered = trimmed.lowercased()

        // Trailing discourse markers — mid-thought with near certainty.
        if let last = trimmed.last, "…,-—".contains(last) { return 0.05 }

        // Wrap-up phrases — the idea was explicitly handed over.
        for phrase in wrapUps {
            if lowered.hasSuffix(phrase) || lowered.hasSuffix(phrase + ".") || lowered.hasSuffix(phrase + "?") {
                return 0.95
            }
        }

        // Terminal punctuation — the sentence, at least, is finished.
        if let last = trimmed.last, ".!?".contains(last) { return 0.85 }

        // A trailing continuation word — the next clause was already in flight.
        let lastWord = lowered
            .split(whereSeparator: { $0.isWhitespace })
            .last.map { $0.trimmingCharacters(in: .punctuationCharacters) } ?? ""
        if trailingContinuations.contains(lastWord) { return 0.1 }

        // No strong cue either way. STT often drops terminal punctuation, so a
        // bare unpunctuated ending is weak evidence of completeness at best.
        return 0.6
    }
}
