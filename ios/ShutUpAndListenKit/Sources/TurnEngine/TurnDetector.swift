// The crux: the patience-tuned turn detector.
//
// A pure, runtime-agnostic reducer over (state, event) implementing
// spec/turn-state-machine.md — the Swift reimplementation of the same document
// the browser build implements in web/src/turn-detection.ts. Per the spec's
// two-runtimes note, the two share the ALGORITHM and the golden vectors
// (spec/turn-vectors/), not the code. It contains NO audio code — the iOS
// adapters (MicrophoneVAD, LinguisticEOU) translate microphone audio into the
// InputEvent stream this consumes.
//
// The one load-bearing idea (spec §2): the silence floor (patience window) is
// primary and an EOU verdict is an ASYMMETRIC veto on top of it — an
// `incomplete` verdict *extends* the floor; a `complete` verdict is *ignored
// until the floor elapses*. The veto may only lengthen patience, never shorten
// it, because a false cutoff (interrupting a thinker) is the cardinal sin.
//
// The second idea (spec §4a): the floor TRIGGERS EVALUATION, it does not make
// the decision. When the patience window closes the machine emits `evaluate`
// and waits in `deciding` for the host's verdict; only a `speak` verdict takes
// the floor, while `silence` re-arms straight back to `listening`.
//
// The third idea (spec §4b): `turn` counts UTTERANCES (thoughts) and
// `evaluation` counts patience-window closures; only the listener taking the
// floor ends a turn.

import Foundation

public enum Verdict: String, Codable, Sendable {
    case complete, incomplete
}

public enum TurnState: String, Sendable {
    case listening, speaking, pending, deciding, responding
}

/// Why the patience window closed. Carried by `evaluate`, and replayed onto the
/// `turn-end` that a speaking verdict produces.
public enum PatienceReason: String, Codable, Sendable {
    case floor, extended
}

/// The host's answer to an `evaluate`: does the listener take the floor, or stay quiet?
public enum DecisionOutcome: String, Codable, Sendable {
    case speak, silence
}

public enum EvaluateTrigger: String, Codable, Sendable {
    case deadline, evidence
}

public enum ResponseEndReason: String, Codable, Sendable {
    case completed
    case bargeIn = "barge-in"
}

public struct TurnKnobs: Equatable, Sendable {
    /// Patience window: min silence (ms) after speech before a pause may end the turn.
    public var silenceFloorMs: Double
    /// Extra patience (ms) added when the EOU verdict for the pause is `incomplete`.
    public var incompleteExtensionMs: Double
    /// EOU P(complete) >= this ⇒ `complete`, else `incomplete`. Higher ⇒ more patient.
    /// The gate thresholds the SAME probability for its rule 2 — see CompletionThreshold.swift.
    public var completionThreshold: Double
    /// Length (ms) the response is expected to hold the floor. The iOS host sets this
    /// per-response from a TTS duration estimate just before answering `speak`.
    public var responseDurationMs: Double
    /// false ⇒ patience-only baseline arm: ignore every EOU verdict.
    public var useSmartTurn: Bool

    public init(
        silenceFloorMs: Double = 2000,
        incompleteExtensionMs: Double = 4000,
        completionThreshold: Double = defaultCompletionThreshold,
        responseDurationMs: Double = 1500,
        useSmartTurn: Bool = true
    ) {
        self.silenceFloorMs = silenceFloorMs
        self.incompleteExtensionMs = incompleteExtensionMs
        self.completionThreshold = completionThreshold
        self.responseDurationMs = responseDurationMs
        self.useSmartTurn = useSmartTurn
    }

    public static let defaults = TurnKnobs()
}

public enum InputEvent: Sendable {
    case speechStart(t: Double)
    case speechEnd(t: Double)
    case eou(t: Double, verdict: Verdict?, completionProb: Double?)
    /// The host's answer to an outstanding `evaluate`. Ignored in any other state.
    case decision(t: Double, outcome: DecisionOutcome)
    case tick(t: Double)

    public var t: Double {
        switch self {
        case .speechStart(let t), .speechEnd(let t), .eou(let t, _, _),
             .decision(let t, _), .tick(let t):
            return t
        }
    }
}

/// TWO IDENTITIES, NOT ONE (spec §4b): `turn` is the utterance id — which thought
/// this is; it advances only when the previous turn actually ENDED (the listener
/// took the floor). `evaluation` is the evaluation-tick id — which patience-window
/// closure this is; one turn can carry many. Anything calibrated to a THOUGHT
/// (word counts, the question cooldown, transcript grouping) keys on `turn`.
public enum OutputEvent: Equatable, Sendable {
    case turnStart(t: Double, turn: Int)
    case evaluate(t: Double, turn: Int, evaluation: Int, reason: PatienceReason, trigger: EvaluateTrigger)
    case turnEnd(t: Double, turn: Int, evaluation: Int, reason: PatienceReason)
    case responseStart(t: Double, turn: Int)
    case responseEnd(t: Double, turn: Int, reason: ResponseEndReason)
    case bargeIn(t: Double, turn: Int)
}

/// A read-only snapshot for live UI (state + countdown), with no side effects.
public struct TurnSnapshot: Sendable {
    public let state: TurnState
    public let turn: Int
    public let evaluation: Int
    public let verdict: Verdict?
    /// ms until the patience window closes (and evaluation fires), if currently
    /// timing a pause; nil otherwise.
    public let msUntilTurnEnd: Double?
}

public final class TurnDetector {
    private var knobs: TurnKnobs
    private let onEmit: ((OutputEvent) -> Void)?

    private var _state: TurnState = .listening
    /// Utterance id — advanced only when a new thought opens.
    private var turn = 0
    /// Whether the current turn is still the thinker's. Set when a turn opens,
    /// cleared when the listener takes the floor — the ONLY thing that ends a
    /// turn (§4b). It is what makes a declined evaluation free: the thinker
    /// resumes into the same turn.
    private var turnOpen = false
    /// Evaluation-tick id — advanced by each patience-window closure.
    private var evaluation = 0
    private var silenceStart: Double = 0
    private var verdict: Verdict?
    private var responseStart: Double = 0
    private var clock: Double = 0
    private var buffer: [OutputEvent] = []
    /// The patience reason of the evaluation in flight; replayed onto `turn-end`.
    private var evaluationReason: PatienceReason?
    /// Re-entrancy guard: events fed from inside an `onEmit` callback (see input()).
    private var running = false
    private var queued: [InputEvent] = []

    public init(knobs: TurnKnobs = .defaults, onEmit: ((OutputEvent) -> Void)? = nil) {
        self.knobs = knobs
        self.onEmit = onEmit
    }

    public var state: TurnState { _state }
    public var currentTurn: Int { turn }
    public var currentEvaluation: Int { evaluation }
    public var config: TurnKnobs { knobs }

    /// Live-tune knobs; the change applies to the next deadline computation.
    public func setKnobs(_ mutate: (inout TurnKnobs) -> Void) {
        mutate(&knobs)
    }

    /// Abandon the current turn without a spoken response, so the next speech
    /// opens a FRESH one — the host dropped the conversation (a mode switch, a
    /// new session). Not a transition: it emits nothing and moves no state, it
    /// only clears the "this turn is still open" latch. An outstanding
    /// `evaluate` is unaffected and must still be answered (a `silence` verdict
    /// is the cheap way).
    public func dropTurn() {
        turnOpen = false
    }

    /// Feed one input event. Returns the output events emitted by THIS call
    /// (also delivered to the constructor's onEmit callback). Time is advanced
    /// to the event's timestamp first — firing any deadline that elapsed in the
    /// interval at its exact time — then the discrete change is applied, then a
    /// settle pass catches a deadline made newly-due by that change.
    ///
    /// Feeding an event from *inside* an `onEmit` callback is supported and is
    /// the expected shape for the decision loop: such an event is queued and
    /// applied right after the in-flight one settles, and its output joins the
    /// same returned array.
    @discardableResult
    public func input(_ event: InputEvent) -> [OutputEvent] {
        if running {
            queued.append(event)
            return []
        }
        running = true
        defer {
            running = false
            queued.removeAll() // a throw must not leave work stranded for the next call
        }
        buffer = []
        apply(event)
        while !queued.isEmpty { apply(queued.removeFirst()) }
        let out = buffer
        buffer = []
        return out
    }

    /// Advance → discrete change → settle, for one already-dequeued event.
    private func apply(_ event: InputEvent) {
        let t = max(event.t, clock) // monotonic guard
        advance(t)
        switch event {
        case .speechStart:
            onSpeechStart(t)
        case .speechEnd:
            onSpeechEnd(t)
        case .eou(_, let verdict, let completionProb):
            onEou(verdict: verdict, completionProb: completionProb, t: t)
        case .decision(_, let outcome):
            onDecision(outcome, t: t)
        case .tick:
            break // time already advanced
        }
        advance(t)
    }

    /// Non-mutating snapshot for UI rendering.
    public func peek(now: Double) -> TurnSnapshot {
        var msUntilTurnEnd: Double?
        if _state == .pending {
            msUntilTurnEnd = max(0, deadline() - max(now, clock))
        }
        return TurnSnapshot(
            state: _state,
            turn: turn,
            evaluation: evaluation,
            verdict: verdict,
            msUntilTurnEnd: msUntilTurnEnd
        )
    }

    // ── internals ──

    private func emit(_ e: OutputEvent) {
        buffer.append(e)
        onEmit?(e)
    }

    /// Whether the current pause's deadline is extended by an `incomplete` veto.
    private func extended() -> Bool {
        knobs.useSmartTurn && verdict == .incomplete
    }

    private func deadline() -> Double {
        let base = silenceStart + knobs.silenceFloorMs
        return extended() ? base + knobs.incompleteExtensionMs : base
    }

    /// Fire timer-driven transitions (evaluate, response-end) due at/before t.
    private func advance(_ t: Double) {
        clock = max(clock, t)
        while true {
            if _state == .pending {
                let d = deadline()
                if t < d { return }
                // The patience window closed. This is a request to EVALUATE, not
                // a decision to speak: the machine parks in `deciding` until the
                // host answers. `deciding` carries no timer of its own.
                //
                // A closing window is a NEW question about the same thought, so
                // it opens a fresh evaluation tick while `turn` stays put (§4b).
                evaluationReason = extended() ? .extended : .floor
                evaluation += 1
                _state = .deciding
                emit(.evaluate(t: d, turn: turn, evaluation: evaluation,
                               reason: evaluationReason ?? .floor, trigger: .deadline))
                return
            }
            if _state == .responding {
                let rEnd = responseStart + knobs.responseDurationMs
                if t < rEnd { return }
                emit(.responseEnd(t: rEnd, turn: turn, reason: .completed))
                _state = .listening
                continue
            }
            return // listening / speaking carry no timer
        }
    }

    /// Speech from a resting state. A turn opens ONLY if the last one is over —
    /// the listener took the floor, or the host dropped it. Coming back from a
    /// `silence` verdict the turn is still open, so this is the same thought
    /// resuming and nothing is emitted (§4b).
    private func openTurnIfEnded(_ t: Double) {
        _state = .speaking
        if turnOpen { return }
        turn += 1
        turnOpen = true
        emit(.turnStart(t: t, turn: turn))
    }

    private func onSpeechStart(_ t: Double) {
        switch _state {
        case .listening:
            openTurnIfEnded(t)
        case .pending:
            // Resumed before the deadline (advance() would have evaluated
            // otherwise): the thinking-pause is preserved and the SAME turn continues.
            _state = .speaking
            verdict = nil
        case .deciding:
            // Resumed while the verdict was still outstanding. Nothing has been
            // spoken — there is no floor to yield and nothing to interrupt — so
            // this is a resume, not a barge-in: the evaluation is abandoned and
            // the SAME turn continues. Ties resolve toward keeping the turn open (§1).
            _state = .speaking
            verdict = nil
            evaluationReason = nil
        case .responding:
            // Barge-in — yield the floor instantly and open a fresh turn. The
            // interrupted response is cut at t, not at its natural end. Reaching
            // `responding` means the listener took the floor, which already ended
            // the interrupted turn, so openTurnIfEnded always opens a new one here.
            emit(.bargeIn(t: t, turn: turn))
            emit(.responseEnd(t: t, turn: turn, reason: .bargeIn))
            openTurnIfEnded(t)
        case .speaking:
            break // already speaking
        }
    }

    private func onSpeechEnd(_ t: Double) {
        guard _state == .speaking else { return } // defensive; VAD shouldn't emit otherwise
        _state = .pending
        silenceStart = t
        verdict = nil
    }

    private func onEou(verdict eventVerdict: Verdict?, completionProb: Double?, t: Double) {
        // A verdict matters while a pause is being timed (`pending`) and while an
        // evaluation is awaiting an answer (`deciding`) — in any other state no
        // decision hangs on it, so it is ignored.
        guard _state == .pending || _state == .deciding else { return }
        guard let v = resolveVerdict(verdict: eventVerdict, completionProb: completionProb) else { return }
        let changed = v != verdict
        verdict = v
        // Re-evaluation is EVIDENCE-driven, not clock-driven: fresh EOU evidence
        // arriving while the host is still deciding supersedes the outstanding
        // evaluation. Same evaluation tick: the window has not closed again,
        // only the evidence behind the question improved (§4b). The baseline arm
        // ignores every verdict, so it never re-evaluates on one.
        if _state == .deciding && changed && knobs.useSmartTurn {
            emit(.evaluate(t: t, turn: turn, evaluation: evaluation,
                           reason: evaluationReason ?? .floor, trigger: .evidence))
        }
    }

    /// The host's verdict on the outstanding evaluation. `speak` takes the floor —
    /// NOW the turn ends and the response begins; `silence` re-arms straight back
    /// to `listening` with no response park: declining to speak must cost nothing.
    private func onDecision(_ outcome: DecisionOutcome, t: Double) {
        guard _state == .deciding else { return } // stale: the evaluation it answers is gone
        let reason = evaluationReason ?? .floor
        evaluationReason = nil
        if outcome == .silence {
            _state = .listening
            return
        }
        turnOpen = false
        emit(.turnEnd(t: t, turn: turn, evaluation: evaluation, reason: reason))
        _state = .responding
        responseStart = t
        emit(.responseStart(t: t, turn: turn))
    }

    private func resolveVerdict(verdict: Verdict?, completionProb: Double?) -> Verdict? {
        if let verdict { return verdict }
        if let p = completionProb {
            // NaN compares false against the threshold, so a verdict the
            // classifier could not score falls to `incomplete` — mirroring the
            // TS build and the fail-safe reading of "no evidence".
            return p >= knobs.completionThreshold ? .complete : .incomplete
        }
        return nil
    }
}
