// Two completion thresholds — leaf constants, owned by neither module that reads them.
//
// Mirrors web/src/completion-threshold.ts. The EOU P(complete) is read for two
// different jobs. Until su-uzy9.5 both read ONE number (0.5) and were required to
// agree — which is exactly what let an uncued mid-thought pause defeat B1 (see
// docs/findings/b1-gate-measurement-2026-08.md). The two jobs are:
//
//   TurnDetector    the ASYMMETRIC VETO that extends the patience floor. Patience
//                   is primary (spec §2) and a false cutoff is the cardinal sin, so
//                   the veto extends on any pause that is not CONFIDENTLY finished —
//                   it reads `confidentCompletionThreshold`.
//   ResponseGate    rule 2 of the gate: below `completionThreshold` the classifier
//                   read the thinker as positively mid-thought and the listener
//                   holds silence — it reads `completionThreshold`.
//
// WHY TWO, NOT ONE. LinguisticEOU returns 0.6 for a bare unpunctuated ending and
// calls it, in its own comment, "weak evidence of completeness at best" — the
// ABSENCE of a cue, not a finished thought. A single 0.5 boundary collapsed "no
// cue" into "complete": the veto did not extend (0.6 ≥ 0.5) and the gate did not
// hold (0.6 ≥ 0.5), so 200 ms of floor was all that stood between a thinker
// drawing breath and an interruption. Splitting the two lets the band
// [completionThreshold, confidentCompletionThreshold) — "weak evidence of
// completeness" — buy extra patience from the veto WITHOUT the verdict having to
// claim the utterance is incomplete, which would be a lie about the evidence.
//
// This is NOT a retune of the bar. `completionThreshold` (the finished boundary the
// gate holds silence below) is UNCHANGED at 0.5; the fix adds a SECOND, higher bar
// for a DIFFERENT decision — how long to stay patient — so the two readers stop
// being welded to one constant. The veto's extra patience only ever lengthens the
// floor (spec §2), so a weak-cue pause that turns out finished costs a little
// latency, never an interruption; the gate still decides silence-vs-speak on its
// own `completionThreshold` when the floor does elapse.
//
// The live app also derives the gate's runtime value from the detector's live knob
// (`GateConfig.derived(from:)`), so a retune of `completionThreshold` still moves
// both readers at once; the confident threshold is the detector's alone.

/// EOU P(complete) at/above which a pause reads as a FINISHED thought; below it the
/// thinker is positively mid-thought and the gate holds silence (rule 2). Higher ⇒
/// more pauses read as incomplete ⇒ more patient.
public let defaultCompletionThreshold: Double = 0.5

/// EOU P(complete) at/above which a pause reads as CONFIDENTLY finished, so the
/// detector's asymmetric veto stops extending the patience floor. It sits above
/// LinguisticEOU's "no strong cue" default (0.6) and below its positive-cue scores
/// (terminal punctuation 0.85, wrap-up 0.95): only a POSITIVE completeness cue
/// releases the floor, and the mere absence of a cue keeps it patient. Must be
/// ≥ `defaultCompletionThreshold`; the band between them is the "weak evidence of
/// completeness" that earns patience but is never called incomplete.
public let defaultConfidentCompletionThreshold: Double = 0.8
