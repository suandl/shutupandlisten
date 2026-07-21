// The warmed-loop instrumentation — U6. A PURE per-stage latency recorder for the
// end-to-end companion loop, so the operator can SEE where time goes between a turn
// ending and the companion speaking. This is the "warmed loop" measurement the epic
// names (the U6 bead: "per-stage latency: turn-end → transcript → gate → first reply
// token → speech-start").
//
// PURE — no DOM, no clock, no I/O. Timestamps are passed IN (the caller stamps
// `performance.now()` at each stage), exactly as turn-detection.ts takes its time
// from the caller. That keeps it in the same discipline as the rest of the crux
// (turn-detection.ts, transcript.ts, response-hierarchy.ts, measurement.ts) and
// unit-testable headlessly; main.ts is the DOM-coupled caller that records the marks
// and renders the panel.
//
// One loop = one detector turn. A turn records a mark as each stage completes; a
// missing mark (e.g. a `silence` turn is never spoken, so it has no `reply` /
// `speech-start`) simply omits the legs that touch it. The per-leg deltas isolate
// the pipeline's costs: turn-end→transcript is STT, gate→reply is the listener LLM,
// reply→speech-start is TTS synthesis + playback-start.

/** The ordered stages of one loop, turn-end → the companion's first spoken sample. */
export type LoopStage = 'turn-end' | 'transcript' | 'gate' | 'reply' | 'speech-start';

/** Lowest → highest in pipeline order. Adjacency here defines the timed legs. */
export const LOOP_STAGES: readonly LoopStage[] = [
  'turn-end',
  'transcript',
  'gate',
  'reply',
  'speech-start',
] as const;

/** Human labels for each stage's meaning — shown in the metrics panel. */
export const LOOP_STAGE_LABELS: Readonly<Record<LoopStage, string>> = {
  'turn-end': 'detector ended the turn',
  transcript: 'STT transcript resolved',
  gate: 'response-hierarchy gate decided',
  reply: 'reply text ready',
  'speech-start': 'TTS playback started',
};

/** The consecutive (from → to) legs of the pipeline, derived from LOOP_STAGES. */
export const LOOP_LEGS: ReadonlyArray<{ from: LoopStage; to: LoopStage }> = LOOP_STAGES.slice(0, -1).map(
  (from, i) => ({ from, to: LOOP_STAGES[i + 1] }),
);

/** A recorded latency between two consecutive stages of a single turn. */
export interface StageLeg {
  from: LoopStage;
  to: LoopStage;
  ms: number;
}

/** One turn's recorded marks + derived per-leg latencies. */
export interface TurnLatency {
  turn: number;
  /** Absolute ms timestamp recorded for each stage that completed. */
  marks: Partial<Record<LoopStage, number>>;
  /** Per-leg deltas, for the canonical legs whose BOTH endpoints were recorded. */
  legs: StageLeg[];
  /** turn-end → speech-start, if the turn was spoken; null otherwise (e.g. silence). */
  totalMs: number | null;
}

/** Key for a leg's mean in a summary: `${from}→${to}`. */
export function legKey(from: LoopStage, to: LoopStage): string {
  return `${from}→${to}`;
}

export interface LoopSummary {
  /** Turns with at least one recorded mark. */
  turns: number;
  /** Turns that produced spoken audio (both turn-end AND speech-start marked). */
  completed: number;
  /** Mean ms per canonical leg, over the turns where that leg was recorded. */
  meanLegMs: Record<string, number>;
  /** Mean turn-end → speech-start over completed turns; null if none. */
  meanTotalMs: number | null;
}

function computeTurnLatency(turn: number, m: ReadonlyMap<LoopStage, number>): TurnLatency {
  const marks: Partial<Record<LoopStage, number>> = {};
  for (const [stage, t] of m) marks[stage] = t;

  const legs: StageLeg[] = [];
  for (const { from, to } of LOOP_LEGS) {
    const a = m.get(from);
    const b = m.get(to);
    if (a !== undefined && b !== undefined) legs.push({ from, to, ms: b - a });
  }

  const end = m.get('turn-end');
  const speech = m.get('speech-start');
  const totalMs = end !== undefined && speech !== undefined ? speech - end : null;

  return { turn, marks, legs, totalMs };
}

/**
 * Records per-turn stage timestamps and derives per-leg latencies. Idempotent per
 * stage: the FIRST timestamp for a (turn, stage) wins, so a caller that re-records
 * on every UI render (main.ts renders on each transcript change) never overwrites
 * the real stage time with a later render's clock.
 */
export class LoopMetrics {
  private readonly marks = new Map<number, Map<LoopStage, number>>();

  /** Record `t` as the moment `stage` completed for `turn` (first write wins). */
  mark(turn: number, stage: LoopStage, t: number): void {
    let m = this.marks.get(turn);
    if (!m) {
      m = new Map<LoopStage, number>();
      this.marks.set(turn, m);
    }
    if (!m.has(stage)) m.set(stage, t);
  }

  /** True once `stage` has been recorded for `turn` — lets the caller mark once. */
  has(turn: number, stage: LoopStage): boolean {
    return this.marks.get(turn)?.has(stage) ?? false;
  }

  /**
   * Forget every mark for `turn`, so its next mark starts a fresh measurement.
   *
   * The counterpart to first-write-wins: a turn whose patience window closed and
   * was then ABANDONED (the thinker resumed while the verdict was outstanding —
   * spec §6) recorded a `turn-end` for a loop iteration that never happened. Left
   * in place it would pin that turn's origin to the abandoned window and measure
   * the real iteration's legs from too early an instant.
   */
  clear(turn: number): void {
    this.marks.delete(turn);
  }

  /** One turn's latencies, or null if the turn has no recorded marks. */
  turnLatency(turn: number): TurnLatency | null {
    const m = this.marks.get(turn);
    return m ? computeTurnLatency(turn, m) : null;
  }

  /** All recorded turns, ascending. */
  turns(): number[] {
    return [...this.marks.keys()].sort((a, b) => a - b);
  }

  /** Every turn's latencies, ascending by turn. */
  all(): TurnLatency[] {
    return this.turns().map((t) => computeTurnLatency(t, this.marks.get(t) as Map<LoopStage, number>));
  }

  /** Aggregate: mean per leg (over turns that recorded it) + mean total over spoken turns. */
  summary(): LoopSummary {
    const legSum = new Map<string, { sum: number; n: number }>();
    let totalSum = 0;
    let completed = 0;

    for (const tl of this.all()) {
      for (const leg of tl.legs) {
        const key = legKey(leg.from, leg.to);
        const acc = legSum.get(key) ?? { sum: 0, n: 0 };
        acc.sum += leg.ms;
        acc.n += 1;
        legSum.set(key, acc);
      }
      if (tl.totalMs !== null) {
        totalSum += tl.totalMs;
        completed += 1;
      }
    }

    const meanLegMs: Record<string, number> = {};
    for (const [key, { sum, n }] of legSum) meanLegMs[key] = Math.round(sum / n);

    return {
      turns: this.marks.size,
      completed,
      meanLegMs,
      meanTotalMs: completed > 0 ? Math.round(totalSum / completed) : null,
    };
  }

  /** Drop all recorded marks (e.g. on a mode switch / transcript reset). */
  reset(): void {
    this.marks.clear();
  }
}
