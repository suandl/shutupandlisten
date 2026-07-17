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
// segments (from stt.ts) plus the detector's turn-start / turn-end OutputEvents and
// renders the returned view model. It is strictly additive: it reads the detector's
// output, never alters the InputEvent stream or the tested timing.

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

export interface TurnEndMark {
  turn: number;
  t: number;
  reason: 'floor' | 'extended';
}

/** A turn's worth of transcript: its segments in order, and where it ended. */
export interface TurnTranscript {
  turn: number;
  segments: TranscriptSegment[];
  /** null while the turn is still open (no turn-end emitted yet). */
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
 * when a sub-floor thinking-pause kept the same turn open (no new turn-start was
 * emitted) — exactly the case the operator most needs to see laid out.
 */
export function groupTranscript(input: GroupInput): TurnTranscript[] {
  const starts = [...input.turnStarts].sort((a, b) => a.t - b.t || a.turn - b.turn);
  const endByTurn = new Map<number, TurnEndMark>();
  for (const e of input.turnEnds) endByTurn.set(e.turn, e);

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
