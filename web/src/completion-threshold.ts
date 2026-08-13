// Two completion thresholds — leaf constants, owned by neither module that reads them.
//
// smart-turn's P(complete) is read for two different jobs. Until su-uzy9.5 both read
// ONE number (0.5) and were required to agree — which is exactly what let an uncued
// mid-thought pause defeat B1 (see docs/findings/b1-gate-measurement-2026-08.md). The
// two jobs are:
//
//   turn-detection.ts   the ASYMMETRIC VETO that extends the patience floor. Patience
//                       is primary (spec §2) and a false cutoff is the cardinal sin,
//                       so the veto extends on any pause that is not CONFIDENTLY
//                       finished — it reads `confidentCompletionThreshold`.
//   response-hierarchy.ts rule 2 of the gate: below `completionThreshold` the
//                       classifier read the thinker as positively mid-thought and the
//                       listener holds silence — it reads `completionThreshold`.
//
// WHY TWO, NOT ONE. The linguistic EOU returns 0.6 for a bare unpunctuated ending and
// calls it, in its own comment, "weak evidence of completeness at best" — the ABSENCE
// of a cue, not a finished thought. A single 0.5 boundary collapsed "no cue" into
// "complete": the veto did not extend (0.6 ≥ 0.5) and the gate did not hold (0.6 ≥
// 0.5), so 200 ms of floor was all that stood between a thinker drawing breath and an
// interruption. Splitting the two lets the band [completionThreshold,
// confidentCompletionThreshold) — "weak evidence of completeness" — buy extra patience
// from the veto WITHOUT the verdict having to claim the utterance is incomplete, which
// would be a lie about the evidence. That reads as a state-machine bug otherwise; it
// was two duties on one constant.
//
// This is NOT a retune of the bar. `completionThreshold` (the finished boundary the
// gate holds silence below) is UNCHANGED at 0.5; the fix adds a SECOND, higher bar for
// a DIFFERENT decision — how long to stay patient. The veto's extra patience only ever
// lengthens the floor (spec §2), so a weak-cue pause that turns out finished costs a
// little latency, never an interruption; the gate still decides silence-vs-speak on
// its own `completionThreshold` when the floor does elapse.
//
// WHY A MODULE OF ITS OWN, rather than one of them importing the other: the gate is
// deliberately standalone (response-hierarchy.ts's header — it is the pure escalate-
// slowly policy, testable with no detector in sight), and the detector must not learn
// about the response policy either. A leaf module both import couples neither to the
// other, which was the live objection to sharing when the duplication was first
// documented (su-lou.10.3). The confident threshold is the detector's alone; the gate
// never imports it.
//
// This closes the DEFAULT. The RUNTIME values are a second, independent mirror —
// `TurnDetector.setKnobs()` and `GateConfig` are separately overridable — and the live
// app derives the gate's threshold from the detector's `completionThreshold` knob
// (knobs.ts `gateConfigFromTurnKnobs`), so retuning that one still moves both readers
// at once. `confidentCompletionThreshold` is not wired to the gate at all.
//
// ORDERING IS A RUNTIME PROPERTY, NOT A CONSTRUCTION ONE. The band only exists while
// `confidentCompletionThreshold >= completionThreshold`, and only the DEFAULTS below
// are pinned that way: `completionThreshold` carries a live 0..1 slider and the
// confident bar carries no knob at all, so any retune past 0.8 inverts the pair. An
// inverted pair is worse than a welded one — a pause scoring inside the inverted band
// is called `incomplete` and STILL clears the confidence bar, so it collects neither
// the veto's extra patience nor (on web, where the gate reads the patience reason
// through `completionProbFromTurnEnd`) rule-2's silence, which is the whole B1 hold
// lost to a knob advertised as "more patient". So the detector floors its bar at
// `completionThreshold` when it reads them (turn-detection.ts `confidentBar()`) rather
// than trusting the two numbers to stay ordered.

/**
 * smart-turn P(complete) at/above which a pause reads as a FINISHED thought; below it
 * the thinker is positively mid-thought and the gate holds silence (rule 2). Higher ⇒
 * more pauses read as incomplete ⇒ more patient.
 *
 * 0.5 is the classifier's own decision boundary, inherited from when the EOU stage was
 * the duration heuristic. It has never been tuned against the real smart-turn v3
 * distribution — that is su-lou.10.6's job, from the live knob.
 */
export const DEFAULT_COMPLETION_THRESHOLD = 0.5;

/**
 * smart-turn P(complete) at/above which a pause reads as CONFIDENTLY finished, so the
 * detector's asymmetric veto stops extending the patience floor. It sits above the
 * linguistic EOU's "no strong cue" default (0.6) and below its positive-cue scores
 * (terminal punctuation 0.85, wrap-up 0.95): only a POSITIVE completeness cue releases
 * the floor, and the mere absence of a cue keeps it patient. Must be ≥
 * `DEFAULT_COMPLETION_THRESHOLD`; the band between them is the "weak evidence of
 * completeness" that earns patience but is never called incomplete. That ordering is
 * pinned HERE only — a live `completionThreshold` can exceed this, which is why the
 * detector floors its bar rather than assuming it (see the header).
 */
export const DEFAULT_CONFIDENT_COMPLETION_THRESHOLD = 0.8;
