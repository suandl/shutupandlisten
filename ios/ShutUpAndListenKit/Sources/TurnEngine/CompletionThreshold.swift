// The completion threshold — ONE constant, owned by neither module that reads it.
//
// Mirrors web/src/completion-threshold.ts. The EOU P(complete) is thresholded in
// two places, for two different jobs, and the two must agree:
//
//   TurnDetector    `TurnKnobs.completionThreshold` resolves the EOU verdict that
//                   EXTENDS the patience window (`incomplete` ⇒ the floor gains
//                   `incompleteExtensionMs`).
//   ResponseGate    rule 2 of the gate: below it the classifier read the thinker
//                   as mid-thought and the listener holds silence.
//
// Let them drift and the detector extends the floor on one boundary while the
// gate reads the same pause as finished on another — a companion that holds the
// turn open and then answers anyway. The live app also derives the gate's runtime
// value from the detector's live knob (`GateConfig.derived(from:)`), so a retune
// moves both readers at once.

/// EOU P(complete) at/above which a pause reads as a FINISHED thought; below it
/// the thinker is mid-thought. Higher ⇒ more pauses read as incomplete ⇒ more patient.
public let defaultCompletionThreshold: Double = 0.5
