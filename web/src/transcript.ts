// Transcript alignment — the U4 legibility unlock.
//
// Groups transcribed VAD speech segments under the detector's TURNS and marks
// where each speech-end and the turn-end landed relative to the words, so the
// operator can read back what was said AND see exactly where the patience window
// cut (or held) the turn. That is what makes the turn-detection knobs diagnosable
// rather than only feelable.
//
// PURE — no DOM, no audio, no detector coupling. The grouping logic is unit-tested
// headlessly, the same discipline as turn-detection.ts. main.ts feeds it transcript
// segments (from stt.ts) plus the detector's turn-start / evaluate OutputEvents and
// renders the returned view model. It is strictly additive: it reads the detector's
// output, never alters the InputEvent stream or the tested timing.
//
// The end mark comes from `evaluate`, not `turn-end`: what the operator needs to
// see is where the PATIENCE WINDOW closed — that is the knob they are tuning — and
// it closes whether or not the companion then decides to speak (spec §4a). A turn
// the gate answered with `silence` still gets its marker, and still reads as
// "held Nms after last speech".
//
// A turn is ONE UTTERANCE, not one evaluation (spec §4b): a pause the gate declined
// to speak into keeps the turn open, so the words either side of it group together
// and the gate's next look sees the whole thought rather than the fragment after
// the pause. Several evaluations can therefore land on one turn; the mark carries
// which one (`evaluation`) and the LATEST wins the display, since that is the
// window the currently-shown decision answers.

// 'sim' — scripted demo words from the simulator (su-lou.4.1), NOT a real STT run.
// Distinct from 'stub' (an unlabelled/absent-model placeholder): a 'sim' segment
// carries genuine, deterministic words the response-hierarchy gate treats as real
// speech, so the mic-less demo loop can escalate. 'stub' words are excluded from
// gate input; 'sim' words are not.
export type TranscriberMode = 'moonshine' | 'whisper' | 'stub' | 'sim';

/** One transcribed VAD speech segment (the same Float32Array handed to smart-turn). */
export interface TranscriptSegment {
  /** Monotonic id in completion order; lets the UI replace a pending placeholder. */
  id: number;
  /** performance.now() ms at speech-start / speech-end for this segment. */
  startT: number;
  endT: number;
  /** Transcribed text. Empty while pending; a labelled stub when no model is live. */
  text: string;
  mode: TranscriberMode;
  /** True between speech-end and the transcription resolving. */
  pending: boolean;
}

export interface TurnStartMark {
  turn: number;
  t: number;
}

/** Where a turn's patience window closed (the detector's `evaluate`) and why. */
export interface TurnEndMark {
  turn: number;
  /** The evaluation tick this window opened — `OutputEvent.evaluation`. */
  evaluation: number;
  t: number;
  reason: 'floor' | 'extended';
  /**
   * The graded P(complete) behind the pause's verdict at the moment this window
   * closed (`TurnSnapshot.completionProb`), when there was one.
   *
   * Carried because `reason` is NOT a proxy for it. Since su-uzy9.5 decoupled the two
   * B1 mechanisms, `extended` means "not confidently complete", which includes pauses
   * the classifier scored ABOVE the gate's own completion threshold — so a consumer
   * that reconstructs a probability from `reason` alone (`completionProbFromTurnEnd`)
   * feeds the gate a certainty the classifier never expressed, and rule-2 silence
   * follows every floor extension. That is the coupling re-formed one layer up.
   *
   * Absent/null ⇒ the pause's evidence was a bare two-valued verdict, or there was
   * none; the reason-bridge is then the correct and only reading. Optional so the
   * pure grouping contract (and its tests) is unchanged for callers with no score.
   */
  completionProb?: number | null;
}

/** One `evaluate` emit, as the host reads it off the detector. */
export interface TurnEndClosure {
  turn: number;
  evaluation: number;
  /** The emit's own timestamp — the deadline on a fresh tick, the evidence's arrival on a re-emit. */
  t: number;
  reason: 'floor' | 'extended';
  /**
   * The detector's graded P(complete) AT THIS EMIT (`TurnSnapshot.completionProb`), or
   * null when its evidence was a bare two-valued verdict — or had not arrived yet, which
   * is the blind first evaluation.
   */
  completionProb: number | null;
}

export interface RecordTurnEndResult {
  marks: TurnEndMark[];
  /**
   * `opened` — a new evaluation tick, so this closure is a loop-metric origin the caller
   * must mark at `t`. `refreshed` — the SAME tick re-asked with better evidence; the
   * origin has not moved and must not be re-marked.
   */
  effect: 'opened' | 'refreshed';
  /**
   * The turn whose superseded marks were dropped, and whose loop-metric origin the caller
   * must clear before marking the new one. Null when nothing was superseded.
   */
  clearedTurn: number | null;
}

/**
 * Fold one `evaluate` emit into the turn-end marks — the host's whole bookkeeping for
 * "where did this turn's patience window close, and what did the classifier think".
 *
 * Three cases, and the middle one is the bug this function exists to pin (su-l74p):
 *
 * - **A new evaluation on a fresh turn** — record it.
 * - **A re-emit of the SAME evaluation** (§4b: evidence-driven, not clock-driven — an EOU
 *   verdict landing while the host is still deciding supersedes the outstanding question
 *   instead of opening a new one). The deadline has not moved, so `t` and `reason` are
 *   kept from the original emit; the EVIDENCE is what changed, so `completionProb` is
 *   taken from the re-emit. Skipping the update entirely — which is what main.ts did —
 *   strands the mark on the evidence the window closed with, and after a BLIND first
 *   evaluation (deadline before any verdict: `completionProb: null`, `reason: 'floor'`)
 *   that is no evidence at all. The gate then falls back to `completionProbFromTurnEnd`
 *   and reads a certain 1, "finished thought", from a pause the classifier has since
 *   scored 0.3 — and speaks into it. That is B1, the cardinal failure, restored by the
 *   bookkeeping after the score was threaded correctly everywhere else.
 * - **A new evaluation on a turn that already has one** — the gate declined, the thinker
 *   kept going, and the window has closed again further along. The predecessor marked an
 *   origin for a loop iteration that never happened, so drop it and clear that origin.
 *
 * Pure, and returns fresh marks rather than mutating, so the caller's loop-metric writes
 * stay in the caller and this stays testable without a DOM.
 */
export function recordTurnEnd(marks: readonly TurnEndMark[], closure: TurnEndClosure): RecordTurnEndResult {
  if (marks.some((m) => m.evaluation === closure.evaluation)) {
    return {
      marks: marks.map((m) =>
        m.evaluation === closure.evaluation ? { ...m, completionProb: closure.completionProb } : m,
      ),
      effect: 'refreshed',
      clearedTurn: null,
    };
  }
  const superseded = marks.some((m) => m.turn === closure.turn);
  return {
    marks: [...marks.filter((m) => m.turn !== closure.turn), { ...closure }],
    effect: 'opened',
    clearedTurn: superseded ? closure.turn : null,
  };
}

/** A turn's worth of transcript: its segments in order, and where it ended. */
export interface TurnTranscript {
  turn: number;
  segments: TranscriptSegment[];
  /**
   * The turn's LATEST patience-window closure, or null while it has had none. With
   * several evaluations on one turn the earlier ones are superseded — the newest is
   * the window the turn's current decision answers.
   */
  end: TurnEndMark | null;
}

export interface GroupInput {
  segments: TranscriptSegment[];
  turnStarts: TurnStartMark[];
  turnEnds: TurnEndMark[];
}

/**
 * Assign each segment to the turn that was open when its speech ENDED — the
 * latest turn-start at or before the segment's endT.
 *
 * Using endT (not startT) is robust to the detector's monotonic-clock guard: a
 * segment's speech-end always falls strictly inside its own turn (before that
 * turn's turn-end, which is endT + the silence floor, and before the next turn's
 * start), so the containing turn is unambiguous. Several segments map to one turn
 * when a thinking-pause kept the same turn open — a sub-floor one the detector
 * never evaluated, or an evaluated one the gate declined to speak into — which is
 * exactly the case the operator most needs to see laid out.
 */
export function groupTranscript(input: GroupInput): TurnTranscript[] {
  const starts = [...input.turnStarts].sort((a, b) => a.t - b.t || a.turn - b.turn);
  // A turn can close its patience window several times; the LATEST evaluation is
  // the live one, so it wins regardless of the order the marks arrived in.
  const endByTurn = new Map<number, TurnEndMark>();
  for (const e of input.turnEnds) {
    const prev = endByTurn.get(e.turn);
    if (!prev || e.evaluation >= prev.evaluation) endByTurn.set(e.turn, e);
  }

  const byTurn = new Map<number, TurnTranscript>();
  const ensure = (turn: number): TurnTranscript => {
    let g = byTurn.get(turn);
    if (!g) {
      g = { turn, segments: [], end: endByTurn.get(turn) ?? null };
      byTurn.set(turn, g);
    }
    return g;
  };

  // Seed every started turn so an in-progress turn with no transcript yet still
  // shows (e.g. speaking, or transcription still pending).
  for (const s of starts) ensure(s.turn);

  for (const seg of input.segments) {
    let turn = turnAt(starts, seg.endT);
    // A segment with no preceding turn-start should not happen in the live flow
    // (speech-start emits turn-start before speech-end), but never drop one:
    // attach it to the earliest known turn, or turn 1 if none.
    if (turn === null) turn = starts.length > 0 ? starts[0].turn : 1;
    ensure(turn).segments.push(seg);
  }

  for (const g of byTurn.values()) {
    g.segments.sort((a, b) => a.startT - b.startT || a.id - b.id);
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

/** The turn number of the latest turn-start at or before time t, or null. */
function turnAt(starts: TurnStartMark[], t: number): number | null {
  let turn: number | null = null;
  for (const s of starts) {
    if (s.t <= t) turn = s.turn;
    else break;
  }
  return turn;
}
