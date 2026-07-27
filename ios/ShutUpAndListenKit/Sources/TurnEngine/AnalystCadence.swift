// When the ambient analyst recomputes (spec §2). It has no pause to fire on, so
// the trigger is: a finished substantive turn since the last run (marked by the
// host setting `pendingSince`), rate-limited so two cycles never land closer
// than `minIntervalMs`. It always analyzes the WHOLE transcript, so this only
// answers "may I run now?" — not "what has changed".
//
// PURE — same inputs → same output.

import Foundation

public enum AnalystCadence {
    /// ~25 s between cycles: often enough to feel current, rare enough to keep
    /// cost modest with the transcript prefix cached (spec tradeoffs).
    public static let defaultMinIntervalMs: Double = 25_000

    /// Should the analyst recompute now?
    /// - `pendingSince`: ms of the oldest finished-substantive-turn awaiting a
    ///   cycle; nil ⇒ nothing new to analyze.
    /// - `lastRunMs`: when the analyst last ran; nil ⇒ never.
    public static func shouldRecompute(
        nowMs: Double,
        lastRunMs: Double?,
        pendingSince: Double?,
        minIntervalMs: Double = defaultMinIntervalMs
    ) -> Bool {
        guard pendingSince != nil else { return false }
        guard let lastRunMs else { return true }
        return nowMs - lastRunMs >= minIntervalMs
    }
}
