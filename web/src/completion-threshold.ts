// The completion threshold — ONE constant, owned by neither module that reads it.
//
// smart-turn's P(complete) is thresholded in two places, for two different jobs, and
// the two must agree:
//
//   turn-detection.ts   `DEFAULT_KNOBS.completionThreshold` resolves the EOU verdict
//                       that EXTENDS the patience window (`incomplete` ⇒ the floor
//                       gains `incompleteExtensionMs`).
//   response-hierarchy.ts `DEFAULT_GATE_CONFIG.completionThreshold` is rule 2 of the
//                       gate: below it the classifier read the thinker as mid-thought
//                       and the listener holds silence.
//
// They were two literals, both 0.5, mirrored by a comment and enforced by nothing.
// One probability, two thresholds: let them drift and the detector extends the floor
// on one boundary while the gate reads the same pause as finished on another — a
// companion that holds the turn open and then answers anyway, or ends the turn and
// then refuses to speak. That reads as a state-machine bug; it is two constants
// disagreeing. The equivalence oracle cannot catch it — it pins the gate's policy
// given the gate's inputs and knows nothing about the reducer's knob.
//
// WHY A MODULE OF ITS OWN, rather than one of them importing the other: the gate is
// deliberately standalone (response-hierarchy.ts's header — it is the pure escalate-
// slowly policy, testable with no detector in sight), and the detector must not learn
// about the response policy either. A leaf constant that both import couples neither
// to the other, which was the live objection to sharing when the duplication was
// first documented (su-lou.10.3).
//
// This closes the DEFAULT. The RUNTIME values are a second, independent mirror —
// `TurnDetector.setKnobs()` and `GateConfig` are separately overridable — and that is
// the half su-lou.10.6 actually moves, because it retunes this from the live UI knob
// and not by editing a default. So the live app derives the gate's threshold from the
// detector's knob rather than re-defaulting it: knobs.ts `gateConfigFromTurnKnobs`,
// which main.ts passes to `decideTier`. Two mirrors, both closed; neither closed by
// the other.

/**
 * smart-turn P(complete) at/above which a pause reads as a FINISHED thought; below it
 * the thinker is mid-thought. Higher ⇒ more pauses read as incomplete ⇒ more patient.
 *
 * 0.5 is the classifier's own decision boundary, inherited from when the EOU stage was
 * the duration heuristic. It has never been tuned against the real smart-turn v3
 * distribution — that is su-lou.10.6's job, from the live knob.
 */
export const DEFAULT_COMPLETION_THRESHOLD = 0.5;
