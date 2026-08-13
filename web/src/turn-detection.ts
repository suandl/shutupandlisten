// The crux: the patience-tuned turn detector.
//
// A pure, runtime-agnostic reducer over (state, event) implementing
// spec/turn-state-machine.md. It contains NO audio code — the browser adapters
// (vad.ts, smart-turn.ts) translate microphone audio into the InputEvent stream
// this consumes, and render the OutputEvent stream it produces. Keeping it pure
// is what lets the golden vectors test it headlessly and what makes it the
// cross-runtime parity contract for the U7 native build.
//
// The one load-bearing idea (spec §2): the silence floor (patience window) is
// primary and a smart-turn EOU verdict is an ASYMMETRIC veto on top of it — an
// `incomplete` verdict *extends* the floor; a `complete` verdict is *ignored
// until the floor elapses*. The veto may only lengthen patience, never shorten
// it, because a false cutoff (interrupting a thinker) is the cardinal sin.
//
// The second idea (spec §4, §6): the floor TRIGGERS EVALUATION, it does not make
// the decision. When the patience window closes the machine emits `evaluate` and
// waits in `deciding` for the host's verdict; only a `speak` verdict takes the
// floor (`turn-end` → `responding`), while `silence` re-arms straight back to
// `listening` with no response park. A timer is a poor proxy for "should I
// speak"; the intelligence makes that call, and it is asked early enough that its
// answer still matters. The reducer stays PURE — it never calls the gate itself;
// the verdict arrives as an ordinary input event.
//
// The third idea (spec §4b): once the floor only EVALUATES, "which turn is this"
// and "which evaluation is this" stop being the same number. A thinker who pauses,
// is declined, and keeps going is still on ONE thought — so the machine counts the
// UTTERANCE (`turn`) separately from the EVALUATION TICK (`evaluation`). See the
// OutputEvent doc block below; everything calibrated to a thought — word counts,
// the question cooldown, transcript grouping — keys on the former.

import {
  DEFAULT_COMPLETION_THRESHOLD,
  DEFAULT_CONFIDENT_COMPLETION_THRESHOLD,
} from './completion-threshold.ts';

export type Verdict = 'complete' | 'incomplete';
export type TurnState = 'listening' | 'speaking' | 'pending' | 'deciding' | 'responding';

/**
 * Why the patience window closed. Carried by `evaluate`, and replayed onto the
 * `turn-end` that a speaking verdict produces, so the reason a turn ended still
 * describes the patience decision that triggered the evaluation.
 */
export type PatienceReason = 'floor' | 'extended';

/** The host's answer to an `evaluate`: does the listener take the floor, or stay quiet? */
export type DecisionOutcome = 'speak' | 'silence';

export interface TurnKnobs {
  /** Patience window: min silence (ms) after speech before a pause may end the turn. */
  silenceFloorMs: number;
  /**
   * Extra patience (ms) added when the pause's EOU reading is not confidently
   * complete (the asymmetric veto — see `confidentCompletionThreshold`).
   */
  incompleteExtensionMs: number;
  /**
   * smart-turn P(complete) >= this ⇒ the two-valued `complete`/`incomplete` verdict
   * is `complete`, else `incomplete`. This is the gate's rule-2 boundary too, so both
   * read one shared default (completion-threshold.ts) and the live app derives the
   * gate's runtime value from this knob — see that module for why drift here is a
   * companion that holds the turn open and then answers anyway. Higher ⇒ more patient.
   */
  completionThreshold: number;
  /**
   * smart-turn P(complete) below which the asymmetric veto still EXTENDS the floor,
   * even when the verdict is `complete`. Decouples patience from the verdict: a
   * weak-cue pause (the linguistic EOU's 0.6 "no strong cue") stays patient without
   * being relabelled incomplete. Must be `>= completionThreshold` to mean anything;
   * the DEFAULTS satisfy that (see completion-threshold.ts) but `completionThreshold`
   * is a live knob and this one is not, so a retune can invert them — `extended()`
   * therefore floors the bar at `completionThreshold` rather than trusting the pair.
   * Read only by the detector; the gate never sees it.
   */
  confidentCompletionThreshold: number;
  /** Length (ms) of the stubbed canned response (timing-only milestone). */
  responseDurationMs: number;
  /** false ⇒ patience-only baseline arm: ignore every EOU verdict. */
  useSmartTurn: boolean;
}

export const DEFAULT_KNOBS: TurnKnobs = {
  // 200ms: operator feel-test verdict (su-lou.10.6), down from 2000ms — the shortest
  // floor the sweep offered, and the ratified default. Mechanism caveat: 200ms is BELOW
  // the measured ~270ms warmed EOU cost (smart-turn.ts), so at this floor the verdict is
  // still null when the deadline fires — the smart-turn veto (extended(), which only
  // lengthens the floor on `incomplete`) cannot gate the FIRST evaluation of a pause. The
  // late verdict lands as EVIDENCE (spec §4b) that can supersede an in-flight `deciding`,
  // not as the veto; see su-lou.10.8 for the open blind-first-evaluation race. Runtime-
  // tunable as always via TURN_KNOBS / ?silenceFloorMs=.
  silenceFloorMs: 200,
  incompleteExtensionMs: 4000,
  completionThreshold: DEFAULT_COMPLETION_THRESHOLD,
  confidentCompletionThreshold: DEFAULT_CONFIDENT_COMPLETION_THRESHOLD,
  responseDurationMs: 1500,
  useSmartTurn: true,
};

export type InputEvent =
  | { t: number; type: 'speech-start' }
  | { t: number; type: 'speech-end' }
  | { t: number; type: 'eou'; verdict?: Verdict; completionProb?: number }
  /** The host's answer to an outstanding `evaluate`. Ignored in any other state. */
  | { t: number; type: 'decision'; outcome: DecisionOutcome }
  | { t: number; type: 'tick' };

/**
 * TWO IDENTITIES, NOT ONE (spec §4b).
 *
 * `turn` is the **utterance** id — *which thought is this*. It advances only when
 * the previous turn actually ENDED, i.e. when the listener took the floor (or at
 * the first speech of the session). A pause the listener declines to speak into
 * does not end anything: the thinker resumes and it is the same turn, one thought,
 * one `turn-start`.
 *
 * `evaluation` is the **evaluation-tick** id — *which patience-window closure is
 * this*. One turn can carry MANY: every deadline that closes the window opens a
 * fresh evaluation, and the evidence-driven re-evaluation that supersedes one
 * (spec §6) reuses its id, because it is the same question asked again with better
 * evidence. `turn-end` carries the id of the evaluation the `speak` verdict
 * answered.
 *
 * They were one integer while the floor both timed and decided — one evaluation
 * per turn made the distinction invisible. Un-collapsing `Deciding` (su-lou.10.2)
 * split them in fact; su-lou.10.4 splits them in the contract, before the floor
 * drops and a single utterance starts drawing several evaluations routinely.
 * Anything calibrated to a THOUGHT (word counts, the question cooldown, transcript
 * grouping, one loop-metrics iteration) keys on `turn`; anything about one
 * question-and-answer with the host keys on `evaluation`.
 */
export type OutputEvent =
  | { t: number; type: 'turn-start'; turn: number }
  | {
      t: number;
      type: 'evaluate';
      turn: number;
      evaluation: number;
      reason: PatienceReason;
      trigger: 'deadline' | 'evidence';
    }
  | { t: number; type: 'turn-end'; turn: number; evaluation: number; reason: PatienceReason }
  | { t: number; type: 'response-start'; turn: number }
  | { t: number; type: 'response-end'; turn: number; reason: 'completed' | 'barge-in' }
  | { t: number; type: 'barge-in'; turn: number };

/** A read-only snapshot for live UI (state + countdown), with no side effects. */
export interface TurnSnapshot {
  state: TurnState;
  /** The utterance id — see the OutputEvent doc block. */
  turn: number;
  /** The latest evaluation-tick id (0 before the first patience window closed). */
  evaluation: number;
  verdict: Verdict | null;
  /**
   * The graded P(complete) the current pause's `verdict` came from, or null when the
   * evidence was a bare two-valued verdict (or the pause has no evidence yet).
   *
   * Exposed because `verdict` alone no longer determines what the pause MEANS.
   * Decoupling the two B1 mechanisms (su-uzy9.5) gave the veto its own higher bar, so
   * a weak-cue score in [completionThreshold, confidentCompletionThreshold) reads
   * `complete` and still extends the floor. A host that needs the classifier's actual
   * reading — the response gate, whose rule 2 thresholds this same probability —
   * cannot recover it from `verdict`, and must NOT recover it from the patience
   * `reason` either: `extended` no longer implies `incomplete`, so bridging the reason
   * back to a certainty (`completionProbFromTurnEnd`) re-couples the two mechanisms
   * through the UI path and hands the gate a 0 for a pause the classifier scored 0.6.
   * That is the whole B1 decoupling lost in the bridge — see main.ts's `maybeRespond`.
   *
   * The detector is the only component that knows which score belongs to the CURRENT
   * pause: it clears this wherever it clears `verdict` (speech resume, a new pause).
   * A host tracking the score itself would have to duplicate that lifecycle, which is
   * how the two copies drift.
   */
  completionProb: number | null;
  /**
   * Whether the asymmetric veto is currently extending this pause's floor — i.e.
   * whether the live deadline includes `incompleteExtensionMs`.
   *
   * Same reason as `completionProb`: a UI cannot infer this from `verdict` any more.
   * A weak-cue pause is held open while reading `complete`, so a caption keyed on
   * `verdict === 'incomplete'` under-reports the total the countdown is running
   * against and renders more milliseconds left than the window it claims they are
   * left of. False outside `pending`, where no deadline is being timed.
   */
  extended: boolean;
  /** ms until the patience window closes (and evaluation fires), if currently timing a pause; null otherwise. */
  msUntilTurnEnd: number | null;
}

export class TurnDetector {
  private knobs: TurnKnobs;
  private readonly onEmit?: (e: OutputEvent) => void;

  private _state: TurnState = 'listening';
  /** Utterance id — advanced only when a new thought opens. See OutputEvent. */
  private turn = 0;
  /**
   * Whether the current turn is still the thinker's. Set when a turn opens, cleared
   * when the listener takes the floor — the ONLY thing that ends a turn (§4b). It is
   * what makes a declined evaluation free: the thinker resumes into the same turn.
   */
  private turnOpen = false;
  /** Evaluation-tick id — advanced by each patience-window closure. See OutputEvent. */
  private evaluation = 0;
  private silenceStart = 0;
  private verdict: Verdict | null = null;
  /**
   * The graded P(complete) the current pause's `verdict` came from, when the EOU
   * evidence was a score rather than a bare verdict. The veto reads THIS against
   * `confidentCompletionThreshold`, so weak evidence of completeness extends the floor
   * without the verdict having to call the utterance incomplete. null ⇒ only a
   * two-valued verdict was supplied (or the pause has no evidence yet), and the veto
   * falls back to `verdict === 'incomplete'`. Reset with `verdict`.
   */
  private lastCompletionProb: number | null = null;
  private responseStart = 0;
  private clock = 0;
  private buffer: OutputEvent[] = [];
  /** The patience reason of the evaluation in flight; replayed onto `turn-end`. */
  private evaluationReason: PatienceReason | null = null;
  /** Re-entrancy guard: events fed from inside an `onEmit` callback (see input()). */
  private running = false;
  private readonly queued: InputEvent[] = [];

  constructor(knobs: Partial<TurnKnobs> = {}, onEmit?: (e: OutputEvent) => void) {
    this.knobs = { ...DEFAULT_KNOBS, ...knobs };
    this.onEmit = onEmit;
  }

  get state(): TurnState {
    return this._state;
  }

  get currentTurn(): number {
    return this.turn;
  }

  get currentEvaluation(): number {
    return this.evaluation;
  }

  get config(): Readonly<TurnKnobs> {
    return this.knobs;
  }

  /** Live-tune knobs; the change applies to the next deadline computation. */
  setKnobs(partial: Partial<TurnKnobs>): void {
    this.knobs = { ...this.knobs, ...partial };
  }

  /**
   * Abandon the current turn without a spoken response, so the next speech opens a
   * FRESH one — the host dropped the conversation (a mode switch, a new demo
   * script), which is the one turn boundary that is not the listener taking the
   * floor. Not a transition: it emits nothing and moves no state, it only clears
   * the "this turn is still open" latch. An outstanding `evaluate` is unaffected
   * and must still be answered (a `silence` verdict is the cheap way).
   */
  dropTurn(): void {
    this.turnOpen = false;
  }

  /**
   * Feed one input event. Returns the output events emitted by THIS call (also
   * delivered to the constructor's onEmit callback). Time is advanced to the
   * event's timestamp first — firing any deadline that elapsed in the interval
   * at its exact time — then the discrete change is applied, then a settle pass
   * catches a deadline made newly-due by that change (e.g. an incomplete→complete
   * re-classification past the floor).
   *
   * Feeding an event from *inside* an `onEmit` callback is supported and is the
   * expected shape for the decision loop: a host that answers `evaluate` the
   * moment it sees one re-enters here. Such an event is queued and applied right
   * after the in-flight one settles, and its output joins the same returned
   * array — so the caller still sees one ordered, complete stream.
   */
  input(event: InputEvent): OutputEvent[] {
    if (this.running) {
      this.queued.push(event);
      return [];
    }
    this.running = true;
    try {
      this.buffer = [];
      this.apply(event);
      while (this.queued.length > 0) this.apply(this.queued.shift() as InputEvent);
      const out = this.buffer;
      this.buffer = [];
      return out;
    } finally {
      this.running = false;
      this.queued.length = 0; // a throw must not leave work stranded for the next call
    }
  }

  /** Advance → discrete change → settle, for one already-dequeued event. */
  private apply(event: InputEvent): void {
    const t = Math.max(event.t, this.clock); // monotonic guard
    this.advance(t);
    switch (event.type) {
      case 'speech-start':
        this.onSpeechStart(t);
        break;
      case 'speech-end':
        this.onSpeechEnd(t);
        break;
      case 'eou':
        this.onEou(event, t);
        break;
      case 'decision':
        this.onDecision(event.outcome, t);
        break;
      case 'tick':
        break; // time already advanced
    }
    this.advance(t);
  }

  /** Non-mutating snapshot for UI rendering. */
  peek(now: number): TurnSnapshot {
    let msUntilTurnEnd: number | null = null;
    if (this._state === 'pending') {
      msUntilTurnEnd = Math.max(0, this.deadline() - Math.max(now, this.clock));
    }
    return {
      state: this._state,
      turn: this.turn,
      evaluation: this.evaluation,
      verdict: this.verdict,
      completionProb: this.lastCompletionProb,
      // Scoped to `pending` to match `msUntilTurnEnd`: the two describe one live
      // deadline, and reporting an extension while no window is being timed would
      // invite a caption about a countdown that is not running.
      extended: this._state === 'pending' && this.extended(),
      msUntilTurnEnd,
    };
  }

  // ── internals ──

  private emit(e: OutputEvent): void {
    this.buffer.push(e);
    this.onEmit?.(e);
  }

  /**
   * The confidence bar the veto actually applies: never below `completionThreshold`.
   *
   * Decoupling the two B1 mechanisms (su-uzy9.5) made the veto read a SECOND, higher
   * number — but only `completionThreshold` has a live knob (0..1, knobs.ts), while
   * `confidentCompletionThreshold` is a fixed default. Raise the slider past 0.8 and
   * the pair INVERTS, which un-decouples them in the one direction that costs
   * patience: a pause whose score sits in [confident, completion) is called
   * `incomplete` by resolveVerdict and yet clears the confidence bar, so the veto
   * does not extend. That is a floor extension the two-valued rule below would have
   * bought, silently lost to a knob whose whole advertised effect is "more patient".
   *
   * The bands only ever meant anything ordered — completion-threshold.ts specifies
   * `confidentCompletionThreshold >= completionThreshold` — so enforce the ordering
   * where it is READ rather than trusting it to hold. Here and not in knobs.ts
   * because `setKnobs()` takes a partial at any time and callers construct knobs
   * directly (the replay harness, the vectors), so every one of those paths would
   * need its own guard.
   *
   * Splitting the thresholds is preserved exactly wherever the pair is ordered — at
   * the shipped defaults (0.5, 0.8) this is 0.8 and nothing moves.
   */
  private confidentBar(): number {
    return Math.max(this.knobs.confidentCompletionThreshold, this.knobs.completionThreshold);
  }

  /**
   * Whether the current pause's deadline is extended by the asymmetric veto (spec §2
   * — it may only LENGTHEN patience). It fires for any pause that is not CONFIDENTLY
   * complete: given a graded probability the bar is `confidentBar()`, so weak evidence
   * of completeness (e.g. the linguistic EOU's no-strong-cue 0.6) still extends the
   * floor WITHOUT the verdict having to claim the utterance is incomplete. The gate's
   * rule-2 silence keeps the lower `completionThreshold`, so the two B1 mechanisms no
   * longer read one number — but the veto's bar is floored at the gate's, which keeps
   * the guarantee that an `incomplete` verdict ALWAYS extends. A bare verdict with no
   * probability — the golden scenario vectors, or a caller supplying only
   * `complete`/`incomplete` — keeps the original two-valued rule. A non-finite score
   * is not evidence of completeness, so it too extends, matching resolveVerdict's
   * NaN → `incomplete`.
   */
  private extended(): boolean {
    if (!this.knobs.useSmartTurn) return false;
    if (this.lastCompletionProb !== null) {
      return !(this.lastCompletionProb >= this.confidentBar());
    }
    return this.verdict === 'incomplete';
  }

  private deadline(): number {
    const base = this.silenceStart + this.knobs.silenceFloorMs;
    return this.extended() ? base + this.knobs.incompleteExtensionMs : base;
  }

  /** Fire timer-driven transitions (evaluate, response-end) due at/before t. */
  private advance(t: number): void {
    this.clock = Math.max(this.clock, t);
    for (;;) {
      if (this._state === 'pending') {
        const d = this.deadline();
        if (t < d) return;
        // The patience window closed. This is a request to EVALUATE, not a
        // decision to speak: the machine parks in `deciding` until the host
        // answers. `deciding` carries no timer of its own — nothing else can
        // fire here, so the loop is done either way.
        //
        // A closing window is a NEW question about the same thought, so it opens a
        // fresh evaluation tick while `turn` stays put (§4b).
        this.evaluationReason = this.extended() ? 'extended' : 'floor';
        this.evaluation += 1;
        this._state = 'deciding';
        this.emit({
          t: d,
          type: 'evaluate',
          turn: this.turn,
          evaluation: this.evaluation,
          reason: this.evaluationReason,
          trigger: 'deadline',
        });
        return;
      }
      if (this._state === 'responding') {
        const rEnd = this.responseStart + this.knobs.responseDurationMs;
        if (t < rEnd) return;
        this.emit({ t: rEnd, type: 'response-end', turn: this.turn, reason: 'completed' });
        this._state = 'listening';
        continue;
      }
      return; // listening / speaking carry no timer
    }
  }

  /**
   * Speech from a resting state. A turn opens ONLY if the last one is over — the
   * listener took the floor, or the host dropped it. Coming back from a `silence`
   * verdict the turn is still open, so this is the same thought resuming and
   * nothing is emitted: that is what makes declining free downstream too, not just
   * in the state machine (§4b).
   */
  private openTurnIfEnded(t: number): void {
    this._state = 'speaking';
    if (this.turnOpen) return;
    this.turn += 1;
    this.turnOpen = true;
    this.emit({ t, type: 'turn-start', turn: this.turn });
  }

  private onSpeechStart(t: number): void {
    switch (this._state) {
      case 'listening':
        this.openTurnIfEnded(t);
        return;
      case 'pending':
        // Resumed before the deadline (advance() would have ended it otherwise):
        // the thinking-pause is preserved and the SAME turn continues.
        this._state = 'speaking';
        this.verdict = null;
        this.lastCompletionProb = null;
        return;
      case 'deciding':
        // Resumed while the verdict was still outstanding. Nothing has been
        // spoken — there is no floor to yield and nothing to interrupt — so this
        // is a resume, not a barge-in: the evaluation is abandoned and the SAME
        // turn continues. Ties resolve toward keeping the turn open (spec §1).
        this._state = 'speaking';
        this.verdict = null;
        this.lastCompletionProb = null;
        this.evaluationReason = null;
        return;
      case 'responding':
        // Barge-in — yield the floor instantly and open a fresh turn. The
        // interrupted response is cut at t, not at its natural end. Unchanged by
        // the utterance split (B2): reaching `responding` means the listener took
        // the floor, which already ended the interrupted turn, so `openTurnIfEnded`
        // always opens a new one here.
        this.emit({ t, type: 'barge-in', turn: this.turn });
        this.emit({ t, type: 'response-end', turn: this.turn, reason: 'barge-in' });
        this.openTurnIfEnded(t);
        return;
      case 'speaking':
        return; // already speaking
    }
  }

  private onSpeechEnd(t: number): void {
    if (this._state !== 'speaking') return; // defensive; VAD shouldn't emit otherwise
    this._state = 'pending';
    this.silenceStart = t;
    this.verdict = null;
    this.lastCompletionProb = null;
  }

  private onEou(event: { verdict?: Verdict; completionProb?: number }, t: number): void {
    // A verdict matters while a pause is being timed (`pending`) and while an
    // evaluation is awaiting an answer (`deciding`) — in any other state no
    // decision hangs on it, so it is ignored.
    if (this._state !== 'pending' && this._state !== 'deciding') return;
    const v = this.resolveVerdict(event);
    if (!v) return;
    const changed = v !== this.verdict;
    this.verdict = v;
    // Keep the graded score the verdict came from so the veto can weigh confidence
    // directly. When the caller supplied an explicit verdict, leave this null so the
    // veto falls back to the two-valued rule — mirroring resolveVerdict, where an
    // explicit verdict wins over any probability.
    this.lastCompletionProb = event.verdict == null ? (event.completionProb ?? null) : null;
    // Re-evaluation is EVIDENCE-driven, not clock-driven: fresh EOU evidence
    // arriving while the host is still deciding supersedes the outstanding
    // evaluation instead of waiting for a tick or a debounce timer. The patience
    // reason is unchanged — the deadline that opened this evaluation has already
    // passed; only the evidence is new. The baseline arm ignores every verdict,
    // so it never re-evaluates on one.
    //
    // It is the SAME evaluation tick: the window that opened it has not closed
    // again, only the evidence behind the question improved (§4b).
    if (this._state === 'deciding' && changed && this.knobs.useSmartTurn) {
      this.emit({
        t,
        type: 'evaluate',
        turn: this.turn,
        evaluation: this.evaluation,
        reason: this.evaluationReason ?? 'floor',
        trigger: 'evidence',
      });
    }
  }

  /**
   * The host's verdict on the outstanding evaluation. `speak` takes the floor —
   * NOW the turn ends and the response begins; `silence` re-arms straight back to
   * `listening` with no response park, which is the whole point of un-collapsing
   * `Deciding`: declining to speak must cost nothing.
   *
   * Taking the floor is also the one thing that ENDS a turn (§4b): after `speak`
   * the next speech is a new thought, after `silence` it is the same one continuing.
   */
  private onDecision(outcome: DecisionOutcome, t: number): void {
    if (this._state !== 'deciding') return; // stale: the evaluation it answers is gone
    const reason = this.evaluationReason ?? 'floor';
    this.evaluationReason = null;
    if (outcome === 'silence') {
      this._state = 'listening';
      return;
    }
    this.turnOpen = false;
    this.emit({ t, type: 'turn-end', turn: this.turn, evaluation: this.evaluation, reason });
    this._state = 'responding';
    this.responseStart = t;
    this.emit({ t, type: 'response-start', turn: this.turn });
  }

  private resolveVerdict(event: { verdict?: Verdict; completionProb?: number }): Verdict | null {
    if (event.verdict === 'complete' || event.verdict === 'incomplete') return event.verdict;
    if (typeof event.completionProb === 'number') {
      return event.completionProb >= this.knobs.completionThreshold ? 'complete' : 'incomplete';
    }
    return null;
  }
}
