// B1 replay — does the gate hold silence through an unfinished thought?
//
// This is a MEASUREMENT, not a unit test of a component. docs/usefulness-bar.md
// B1 ("Holds silence through an unfinished thought") is the cardinal dealbreaker,
// and docs/on-device-quiet-companion-recommendation.md (U8) records that the
// listener MODEL will not self-restrain — restraint 1.94, 0 of 16 cells above 2,
// invariant across both frontier models and both prompts. U8's F3 names the only
// untried lever as architectural: a GATE that owns silence-vs-speak. This file
// measures that gate against B1.
//
// WHAT MAKES THIS A MEASUREMENT OF THE GATE AND NOT OF ITSELF
// The harness below is PLUMBING ONLY. Every judgement is delegated:
//
//   is this pause a finished thought?  → LinguisticEOU.completionProbability
//   does the patience window close?    → TurnDetector (the asymmetric veto)
//   silence, ack, reflection, question?→ decideTier  (the gate)
//   is a backchannel actually spoken?  → resolveAcknowledge
//   may the analyst refresh the pool?  → AnalystCadence.shouldRecompute
//   is a candidate still fresh?        → CandidatePool.expire / .best(register:)
//
// Nothing here re-states a threshold, a word count, or a silence rule. A test
// that modelled the policy would prove nothing about the policy, so it doesn't:
// it feeds the real event stream in and records what the real gate did.
//
// GROUND TRUTH, NOT EXPECTED OUTPUT
// The vectors in spec/turn-vectors/gate/ carry `groundTruth` — which pauses are
// mid-thought and where the thought actually lands — in the same spirit as
// labeled/'s `trueTurnBoundaries`. They deliberately carry no `expected` block:
// pinning the gate's output in the fixture would turn a measurement into a
// tautology. The bar is scored against ground truth here, in code.
//
// KNOBS: the vectors deliberately omit `knobs`, so the measurement runs at the
// SHIPPED defaults (TurnKnobs.defaults / GateConfig.derived(from:)). The
// question is whether the companion as configured holds B1, so a retune of the
// defaults must move this measurement.
//
// SCOPE: this measures the ARCHITECTURAL question — does the gate withhold
// through an unfinished thought. It does NOT measure device behaviour:
// ios/App/SessionController.swift composes the gate's verdict into an actual
// utterance and is App-target, unreachable from any headless toolchain, and out
// of scope here. A green result here is not a green device.

import XCTest
@testable import TurnEngine

// ── vector schema (additive over spec/turn-vectors/README.md) ──

private struct GateVector: Decodable {
    struct Knobs: Decodable {
        var silenceFloorMs: Double?
        var incompleteExtensionMs: Double?
        var completionThreshold: Double?
        var responseDurationMs: Double?
        var useSmartTurn: Bool?
    }

    struct Event: Decodable {
        let t: Double
        let type: String
        /// speech-end: what was transcribed during that speech segment.
        let text: String?
        /// eou: "linguistic" ⇒ score the utterance-so-far with the real
        /// LinguisticEOU rather than handing the answer to the engine.
        let source: String?
        let verdict: String?
        let completionProb: Double?
        let outcome: String?
    }

    struct Marker: Decodable {
        let t: Double
        let note: String?
    }

    struct GroundTruth: Decodable {
        let midThoughtPauses: [Marker]?
        let landings: [Marker]?
    }

    struct AnalystCandidate: Decodable {
        let text: String
        let register: String
    }

    struct Analyst: Decodable {
        let candidates: [AnalystCandidate]
    }

    let name: String
    let description: String
    let knobs: Knobs?
    let groundTruth: GroundTruth
    let analyst: Analyst?
    let events: [Event]
}

// ── what the replay records ──

/// One gate decision, as it actually happened.
private struct GateObservation {
    let t: Double
    let turn: Int
    let evaluation: Int
    let patience: PatienceReason
    let completionProb: Double
    let tier: Tier
    let reason: String
    /// What the companion would utter; nil ⇒ it held silence.
    let spoken: String?
    /// Where the utterance came from: silence / rules-ack / pool / model-call.
    let source: String
    /// For a pool draw: how far the transcript had moved past the candidate's
    /// anchor when it was spoken. nil for every other source.
    let candidateDrift: Int?
}

private final class GateReplay {
    /// The host's timer granularity. A patience deadline is only DISCOVERED when
    /// an event advances the clock past it, so a replay driven by speech events
    /// alone would attribute an evaluation to whenever the thinker happened to
    /// speak next. A fixed tick grid stands in for the host's timer and puts each
    /// evaluation within one tick of its true deadline. Plumbing, not policy.
    static let tickMs: Double = 50

    /// Stand-in for a substantive tier with an empty pool: the real host falls
    /// back to a live model call. Headlessly there is no model, but the gate has
    /// already DECIDED to speak — which is the whole of what B1 measures.
    static let liveModelCall = "<live model call>"

    private let vector: GateVector
    let knobs: TurnKnobs
    private let gateConfig: GateConfig
    private let detector: TurnDetector

    /// The current THOUGHT's text (reset at each turn-start) — what rules 4/5 size.
    private var utteranceText = ""
    /// The whole session's finalized transcript. Monotonic by construction, which
    /// is the basis CandidatePool.expire requires (see CandidatePoolTests).
    private var finalizedText = ""
    private var lastProb = Double.nan
    private var lastSpeechEnd = Double.nan
    private var lastResponseEnd: Double?
    private var priorDecisions: [PriorDecision] = []
    private var pool = CandidatePool()
    private var analystLastRun: Double?
    private var analystPendingSince: Double?

    private(set) var observations: [GateObservation] = []
    private(set) var bargeIns: [Double] = []
    private(set) var problems: [String] = []

    init(_ vector: GateVector) {
        self.vector = vector
        var k = TurnKnobs.defaults
        if let v = vector.knobs {
            if let x = v.silenceFloorMs { k.silenceFloorMs = x }
            if let x = v.incompleteExtensionMs { k.incompleteExtensionMs = x }
            if let x = v.completionThreshold { k.completionThreshold = x }
            if let x = v.responseDurationMs { k.responseDurationMs = x }
            if let x = v.useSmartTurn { k.useSmartTurn = x }
        }
        self.knobs = k
        self.gateConfig = GateConfig.derived(from: k)
        self.detector = TurnDetector(knobs: k)
    }

    // ── timeline: the vector's events merged with the tick grid ──

    private enum Step {
        case scripted(GateVector.Event)
        case tick(Double)
    }

    private func timeline() -> [Step] {
        // (time, rank, seq): rank puts a scripted event ahead of a tick at the
        // same instant, seq keeps the order total so the sort is deterministic
        // regardless of the sort's stability.
        var rows: [(t: Double, rank: Int, seq: Int, step: Step)] = []
        for (i, e) in vector.events.enumerated() {
            rows.append((e.t, 0, i, .scripted(e)))
        }
        let lastT = vector.events.map { $0.t }.max() ?? 0
        var t: Double = 0
        var seq = 0
        while t <= lastT {
            rows.append((t, 1, seq, .tick(t)))
            seq += 1
            t += Self.tickMs
        }
        rows.sort { a, b in
            if a.t != b.t { return a.t < b.t }
            if a.rank != b.rank { return a.rank < b.rank }
            return a.seq < b.seq
        }
        return rows.map { $0.step }
    }

    func run() {
        for step in timeline() {
            switch step {
            case .tick(let t):
                handle(detector.input(.tick(t: t)))

            case .scripted(let e):
                switch e.type {
                case "speech-start":
                    handle(detector.input(.speechStart(t: e.t)))

                case "speech-end":
                    lastSpeechEnd = e.t
                    appendTranscript(e.text ?? "")
                    handle(detector.input(.speechEnd(t: e.t)))
                    // The thinker moved on; retire candidates they have drifted past.
                    pool.expire(currentPosition: finalizedText.count)

                case "eou":
                    if e.source == "linguistic" {
                        lastProb = LinguisticEOU.completionProbability(for: utteranceText)
                    } else if let p = e.completionProb {
                        lastProb = p
                    }
                    handle(detector.input(.eou(
                        t: e.t,
                        verdict: e.verdict.flatMap(Verdict.init(rawValue:)),
                        completionProb: lastProb
                    )))

                case "tick":
                    handle(detector.input(.tick(t: e.t)))

                case "decision":
                    // A gate vector never scripts a decision: the point is that
                    // the GATE answers every evaluate. A scripted one would be
                    // the test supplying the very verdict under measurement.
                    problems.append("\(vector.name): scripted `decision` at \(e.t) — the gate must answer, not the fixture")

                default:
                    problems.append("\(vector.name): unknown event type '\(e.type)' at \(e.t)")
                }
            }
        }
    }

    private func appendTranscript(_ text: String) {
        let piece = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !piece.isEmpty else { return }
        utteranceText = utteranceText.isEmpty ? piece : utteranceText + " " + piece
        finalizedText = finalizedText.isEmpty ? piece : finalizedText + " " + piece
    }

    /// Fold the detector's output. Re-entrant: answering an `evaluate` feeds a
    /// `decision` straight back in, and its output is folded by the same routine.
    private func handle(_ out: [OutputEvent]) {
        for e in out {
            switch e {
            case .turnStart:
                utteranceText = "" // a new thought begins
            case .bargeIn(let t, _):
                bargeIns.append(t)
            case .responseEnd(let t, _, _):
                lastResponseEnd = t
            case .turnEnd(let t, _, _, _):
                // A finished turn is what the analyst has to react to.
                if analystPendingSince == nil { analystPendingSince = t }
                runAnalystIfDue(now: t)
            case .evaluate(let t, let turn, let evaluation, let reason, _):
                decide(t: t, turn: turn, evaluation: evaluation, patience: reason)
            case .responseStart:
                break
            }
        }
    }

    /// The analyst is a MODEL, so it cannot run headlessly — the vector supplies
    /// what it would have returned. WHEN it may run is still the engine's call.
    private func runAnalystIfDue(now: Double) {
        guard AnalystCadence.shouldRecompute(
            nowMs: now, lastRunMs: analystLastRun, pendingSince: analystPendingSince
        ) else { return }
        let anchor = finalizedText.count
        let fresh: [Candidate] = (vector.analyst?.candidates ?? []).compactMap { c -> Candidate? in
            guard let register = Tier(rawValue: c.register) else {
                problems.append("\(vector.name): analyst candidate has unknown register '\(c.register)'")
                return nil
            }
            return Candidate(text: c.text, register: register, anchorPosition: anchor)
        }
        pool.replace(with: fresh)
        analystLastRun = now
        analystPendingSince = nil
    }

    /// Answer one `evaluate` with the REAL gate, then hand the detector the
    /// outcome. Everything decided here is decided by an engine call.
    private func decide(t: Double, turn: Int, evaluation: Int, patience: PatienceReason) {
        let ctx = EvalContext(
            utteranceIndex: turn,
            utteranceTextSoFar: utteranceText,
            completionProb: lastProb,
            msSinceSpeechEnd: lastSpeechEnd.isNaN ? Double.nan : t - lastSpeechEnd,
            msSinceWeLastSpoke: lastResponseEnd.map { t - $0 } ?? Double.infinity,
            priorDecisions: priorDecisions
        )
        let decision = decideTier(ctx, config: gateConfig)

        var spoken: String? = nil
        var source: String
        var drift: Int? = nil
        var recordedTier = decision.tier

        switch decision.tier {
        case .silence:
            source = "silence"

        case .acknowledge:
            let resolved = resolveAcknowledge(decision, speakAcknowledgments: true)
            recordedTier = resolved.recordedTier
            spoken = resolved.spokenText
            source = resolved.spokenText == nil ? "silence" : "rules-ack"

        case .reflection, .question:
            if let candidate = pool.best(register: decision.tier) {
                spoken = candidate.text
                source = "pool"
                drift = finalizedText.count - candidate.anchorPosition
                pool.remove(candidate) // never offer the same line twice
            } else {
                // Empty pool ⇒ the host falls back to a live call. The gate has
                // still decided to speak, which is what B1 scores.
                spoken = Self.liveModelCall
                source = "model-call"
            }
        }

        priorDecisions.append(PriorDecision(turn: turn, tier: recordedTier))
        observations.append(GateObservation(
            t: t, turn: turn, evaluation: evaluation, patience: patience,
            completionProb: lastProb, tier: decision.tier, reason: decision.reason,
            spoken: spoken, source: source, candidateDrift: drift
        ))

        handle(detector.input(.decision(t: t, outcome: spoken == nil ? .silence : .speak)))
    }

    var maxDrift: Int { pool.maxDrift }
}

// ── scoring the bar against ground truth ──

/// A pause runs from a speech-end to the next speech-start (or to the end of the
/// stream). Anything the companion utters inside a MID-THOUGHT pause lands on an
/// unfinished thought — the cardinal failure.
private func pauseWindowEnd(after speechEnd: Double, in vector: GateVector) -> Double {
    vector.events
        .filter { $0.type == "speech-start" && $0.t > speechEnd }
        .map { $0.t }
        .min() ?? Double.infinity
}

private struct VectorScore {
    let vector: GateVector
    let replay: GateReplay
    /// Utterances that landed inside a mid-thought pause: B1 failures.
    let violations: [(pause: GateVector.Marker, observation: GateObservation)]
    /// Replies per landing, in vector order.
    let repliesPerLanding: [(landing: GateVector.Marker, count: Int)]
    /// Pool draws, for the freshness/brevity checks.
    let poolDraws: [GateObservation]

    var heldB1: Bool { violations.isEmpty }
    var spokeCount: Int { replay.observations.filter { $0.spoken != nil }.count }
}

private func score(_ vector: GateVector) -> VectorScore {
    let replay = GateReplay(vector)
    replay.run()

    let spoke = replay.observations.filter { $0.spoken != nil }
    let mid = vector.groundTruth.midThoughtPauses ?? []
    let landings = vector.groundTruth.landings ?? []

    var violations: [(pause: GateVector.Marker, observation: GateObservation)] = []
    for pause in mid {
        let end = pauseWindowEnd(after: pause.t, in: vector)
        for o in spoke where o.t >= pause.t && o.t < end {
            violations.append((pause, o))
        }
    }

    var perLanding: [(landing: GateVector.Marker, count: Int)] = []
    for landing in landings {
        let end = pauseWindowEnd(after: landing.t, in: vector)
        perLanding.append((landing, spoke.filter { $0.t >= landing.t && $0.t < end }.count))
    }

    return VectorScore(
        vector: vector, replay: replay, violations: violations,
        repliesPerLanding: perLanding,
        poolDraws: replay.observations.filter { $0.source == "pool" }
    )
}

final class B1GateReplayTests: XCTestCase {
    /// B4 ("rare and brief"): a spoken line is a sentence or two, not a paragraph.
    /// NOTE this bounds the FIXTURE's candidate register — the gate-decided half of
    /// "brief and anchored" is the register match and the freshness check, both of
    /// which are CandidatePool's answers rather than the test's.
    private static let briefWordCap = 30

    private static var gateDir: URL {
        // …/ios/ShutUpAndListenKit/Tests/TurnEngineTests/B1GateReplayTests.swift
        // → repo root is five directories up (same walk as GoldenVectorTests).
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TurnEngineTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ShutUpAndListenKit
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("spec/turn-vectors/gate")
    }

    private func loadVectors() throws -> [GateVector] {
        let files = try FileManager.default
            .contentsOfDirectory(at: Self.gateDir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertFalse(files.isEmpty, "no B1 gate vectors found at \(Self.gateDir.path)")
        return try files.map { try JSONDecoder().decode(GateVector.self, from: Data(contentsOf: $0)) }
    }

    /// Every speech-end must be classified as mid-thought or a landing. Without
    /// this a vector could quietly drop the very pause it exists to exercise and
    /// still report a clean B1.
    func testEveryPauseIsClassifiedAsGroundTruth() throws {
        for vector in try loadVectors() {
            let ends = vector.events.filter { $0.type == "speech-end" }.map { $0.t }
            let classified = Set(
                (vector.groundTruth.midThoughtPauses ?? []).map { $0.t }
                    + (vector.groundTruth.landings ?? []).map { $0.t }
            )
            for e in ends {
                XCTAssertTrue(
                    classified.contains(e),
                    "\(vector.name): the pause at \(e) is in neither midThoughtPauses nor landings — "
                        + "an unclassified pause is silently exempt from the bar"
                )
            }
        }
    }

    /// **The bar.** B1: a thinking-pause is not a turn boundary, and no listener
    /// turn lands mid-thought.
    ///
    /// A failure here is a MEASUREMENT RESULT, not a broken build: it means the
    /// gate spoke into an unfinished thought at the shipped defaults. Per
    /// docs/on-device-quiet-companion-recommendation.md that finding is to be
    /// escalated, not tuned away — do not weaken a vector to make this green.
    func testGateHoldsSilenceThroughUnfinishedThought() throws {
        for vector in try loadVectors() {
            let s = score(vector)
            XCTAssertTrue(s.replay.problems.isEmpty, s.replay.problems.joined(separator: "; "))
            for v in s.violations {
                XCTFail(
                    """
                    B1 VIOLATED — \(vector.name)
                      the companion spoke at t=\(v.observation.t) inside the mid-thought pause \
                    that began at t=\(v.pause.t) (\(v.pause.note ?? "mid-thought"))
                      tier=\(v.observation.tier.rawValue) via \(v.observation.source): \
                    \(v.observation.spoken ?? "-")
                      the gate's own reason: "\(v.observation.reason)"
                      EOU P(complete)=\(v.observation.completionProb) vs threshold \
                    \(s.replay.knobs.completionThreshold); patience closed on \
                    \(v.observation.patience.rawValue)
                      This is the cardinal failure of docs/usefulness-bar.md B1.
                    """
                )
            }
        }
    }

    /// The other half of the bar: silence is only useful if the companion still
    /// speaks when the thought genuinely lands — at most once, briefly, and
    /// anchored to what was actually said.
    func testLandingEarnsAtMostOneBriefAnchoredReply() throws {
        for vector in try loadVectors() {
            let s = score(vector)
            for l in s.repliesPerLanding {
                XCTAssertLessThanOrEqual(
                    l.count, 1,
                    "\(vector.name): the landing at t=\(l.landing.t) drew \(l.count) replies — "
                        + "B4 says most pauses get nothing and a reply is one brief move"
                )
            }
            for draw in s.poolDraws {
                let text = draw.spoken ?? ""
                XCTAssertLessThanOrEqual(
                    wordCount(text), Self.briefWordCap,
                    "\(vector.name): spoke \(wordCount(text)) words at t=\(draw.t) — not brief"
                )
                // Anchored: CandidatePool's own freshness rule, measured against
                // the transcript as it stood when the line was spoken.
                XCTAssertLessThanOrEqual(
                    draw.candidateDrift ?? Int.max, s.replay.maxDrift,
                    "\(vector.name): spoke a candidate at t=\(draw.t) that the transcript had "
                        + "drifted \(draw.candidateDrift ?? -1) chars past — not anchored to the landed thought"
                )
            }
        }
    }

    /// The deliverable: the measurement itself, printed so the CI log carries the
    /// verdict whether or not the bar assertion above passed. Never fails — a
    /// report that can fail is a report you stop reading.
    func testB1MeasurementReport() throws {
        let vectors = try loadVectors()
        var lines: [String] = []
        var held = 0
        var failed = 0
        var totalEvaluations = 0
        var totalSpoke = 0
        var totalBargeIns = 0

        lines.append("")
        lines.append("──── B1 GATE MEASUREMENT (usefulness-bar B1: holds silence through an unfinished thought) ────")

        for vector in vectors {
            let s = score(vector)
            let k = s.replay.knobs
            totalEvaluations += s.replay.observations.count
            totalSpoke += s.spokeCount
            totalBargeIns += s.replay.bargeIns.count
            if s.heldB1 { held += 1 } else { failed += 1 }

            lines.append("")
            lines.append("  \(s.heldB1 ? "HELD  " : "FAILED")  \(vector.name)")
            lines.append("     knobs: floor=\(k.silenceFloorMs)ms extension=\(k.incompleteExtensionMs)ms "
                + "threshold=\(k.completionThreshold) smartTurn=\(k.useSmartTurn)")
            for o in s.replay.observations {
                let what = o.spoken.map { "SPOKE [\(o.source)] \"\($0)\"" } ?? "withheld"
                lines.append("     t=\(o.t) turn=\(o.turn) eval=\(o.evaluation) "
                    + "P(complete)=\(o.completionProb) closed-on=\(o.patience.rawValue) "
                    + "→ \(o.tier.rawValue): \(what)")
                lines.append("        reason: \(o.reason)")
            }
            if s.replay.observations.isEmpty {
                lines.append("     (the patience window never closed — the gate was never asked)")
            }
            for v in s.violations {
                lines.append("     ✗ B1 VIOLATION: spoke at t=\(v.observation.t) inside the "
                    + "mid-thought pause from t=\(v.pause.t) — \(v.pause.note ?? "")")
            }
            for l in s.repliesPerLanding {
                lines.append("     landing t=\(l.landing.t): \(l.count) repl\(l.count == 1 ? "y" : "ies")")
            }
            if !s.replay.bargeIns.isEmpty {
                lines.append("     barge-ins (the thinker had to talk over us): "
                    + s.replay.bargeIns.map { "\($0)" }.joined(separator: ", "))
            }
        }

        lines.append("")
        lines.append("  ── totals ──")
        lines.append("  vectors: \(vectors.count)   B1 held: \(held)   B1 failed: \(failed)")
        lines.append("  evaluations: \(totalEvaluations)   utterances: \(totalSpoke)   barge-ins: \(totalBargeIns)")
        lines.append("")
        if failed == 0 {
            lines.append("  VERDICT: the gate HELD B1 on all \(vectors.count) vectors. The architectural")
            lines.append("  lever (U8 F3) withholds where the raw model would not — measured on the gate")
            lines.append("  only, NOT on device (SessionController is out of scope).")
        } else {
            lines.append("  VERDICT: the gate FAILED B1 on \(failed) of \(vectors.count) vectors.")
            lines.append("  Per docs/on-device-quiet-companion-recommendation.md this is to be ESCALATED,")
            lines.append("  not built through: with F2 (the model will not self-restrain) already")
            lines.append("  established, a gate that also fails B1 leaves the quiet companion with no")
            lines.append("  demonstrated path on any rung measured so far.")
        }
        lines.append("─────────────────────────────────────────────────────────────────────────────")
        print(lines.joined(separator: "\n"))
    }
}
