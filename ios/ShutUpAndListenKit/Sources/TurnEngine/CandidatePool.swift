// The candidate pool (spec §2): a small, ranked, best-first set of ready-to-
// speak interjections the analyst maintains from its whole-transcript
// understanding. The screen surfaces the top 1–2 as silent hints; the voice
// surface speaks the best-fitting still-fresh one at a pause instead of a cold
// model call.
//
// PURE — no model, no I/O. Freshness is anchored to a transcript position
// (character length at formation): a candidate expires once the thinker has
// drifted more than `maxDrift` characters past it. The pool is an optimization
// + coherence layer, NEVER a correctness dependency — empty ⇒ nil, caller
// falls back to a live call or silence.

import Foundation

/// One ready-to-speak interjection. `register` is `.reflection` or `.question`
/// (the model tiers); `anchorPosition` is the transcript length when it was
/// formed, so freshness can be measured as drift.
public struct Candidate: Equatable, Sendable {
    public let text: String
    public let register: Tier
    public let anchorPosition: Int

    public init(text: String, register: Tier, anchorPosition: Int) {
        self.text = text
        self.register = register
        self.anchorPosition = anchorPosition
    }
}

public struct CandidatePool: Equatable, Sendable {
    /// Ranked best-first, capped to `maxCount`.
    public private(set) var candidates: [Candidate] = []
    public let maxCount: Int
    /// Max characters the thinker may drift past a candidate's anchor before it
    /// expires (~a paragraph). Above this, the candidate no longer fits "now".
    public let maxDrift: Int

    public init(maxCount: Int = 3, maxDrift: Int = 600) {
        self.maxCount = maxCount
        self.maxDrift = maxDrift
    }

    public var isEmpty: Bool { candidates.isEmpty }

    /// Replace the pool with a fresh ranked set (best first), capped to maxCount.
    public mutating func replace(with fresh: [Candidate]) {
        candidates = Array(fresh.prefix(maxCount))
    }

    /// Drop a candidate that has been SPOKEN, so the pool can never offer the
    /// same line twice (a second pause inside one cadence window would otherwise
    /// repeat it verbatim, and the on-screen hint would keep advertising a line
    /// already said). Siblings stay — they are still-fresh, differently-anchored
    /// options; expiry and the next cycle retire them normally. Matched by text:
    /// the caller holds the value it spoke, not an index into a pool that may
    /// have been replaced since.
    public mutating func remove(_ candidate: Candidate) {
        candidates.removeAll { $0.text == candidate.text }
    }

    /// Drop candidates the thinker has clearly moved past.
    public mutating func expire(currentPosition: Int) {
        candidates.removeAll { currentPosition - $0.anchorPosition > maxDrift }
    }

    /// The best (highest-ranked) fresh candidate of `register`, or of any
    /// register when `register` is nil. Nil when the pool is empty of matches.
    public func best(register: Tier? = nil) -> Candidate? {
        guard let register else { return candidates.first }
        return candidates.first { $0.register == register }
    }

    /// The best fresh question, or nil.
    public func bestQuestion() -> Candidate? { best(register: .question) }
}
