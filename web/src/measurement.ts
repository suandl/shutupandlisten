// Scenario 6: does smart-turn earn its place over a bare patience floor?
//
// "EOU evaluation on real thinking-out-loud audio: measure false-cutoff rate and
//  false-continuation rate for smart-turn-plus-floor against a patience-window-
//  only baseline arm; the EOU must beat the bare floor to earn its place."
//   — 2026-06-25 validation plan, U3 scenario 6.
//
// This module is PURE (no fs / no DOM): it takes labeled vectors and produces a
// metrics table, so it runs identically under the Node test runner, the
// `npm run measure` CLI (src/measure.ts), and in the browser. Disk loading lives
// in those callers, not here.
//
// Scoring. Each labeled vector carries ground-truth `trueTurnBoundaries` — the
// times a real completed thought ended (where the detector SHOULD fire, after
// patience). We replay the vector through two arms (combined: useSmartTurn=true;
// baseline: useSmartTurn=false) and match emitted turn-ends to boundaries within
// a per-vector tolerance (floor + extension + grace — a detection inside the
// patience window plus a little is on-time):
//   - false cutoff       — a turn-end with no boundary in tolerance (ended
//                           mid-thought: the cardinal sin).
//   - false continuation — a boundary with no turn-end in tolerance (stayed
//                           silent when the thought was done).
// The asymmetric cost is reflected by weighting cutoffs above continuations.

import { TurnDetector, type InputEvent, type TurnKnobs } from './turn-detection.ts';

export interface LabeledVector {
  name: string;
  description: string;
  knobs: Partial<TurnKnobs>;
  trueTurnBoundaries: Array<{ t: number; note?: string }>;
  events: InputEvent[];
}

export type Arm = 'combined' | 'baseline';

/** False cutoff is the cardinal sin; weight it well above a benign continuation. */
export const FALSE_CUTOFF_WEIGHT = 1.0;
export const FALSE_CONTINUATION_WEIGHT = 0.25;
/** Grace beyond floor+extension within which a detection still counts as on-time. */
export const MATCH_GRACE_MS = 1500;

export interface ArmResult {
  arm: Arm;
  turnEnds: number[];
  falseCutoffs: number;
  falseContinuations: number;
  truePositives: number;
  meanLatencyMs: number | null;
  weightedError: number;
}

export interface VectorResult {
  name: string;
  toleranceMs: number;
  combined: ArmResult;
  baseline: ArmResult;
}

export interface AggregateArm {
  arm: Arm;
  falseCutoffs: number;
  falseContinuations: number;
  truePositives: number;
  meanLatencyMs: number | null;
  weightedError: number;
}

export interface MeasurementSummary {
  perVector: VectorResult[];
  combined: AggregateArm;
  baseline: AggregateArm;
  /**
   * The verdict the unit gate cares about: smart-turn beats the bare floor when
   * it produces strictly fewer false cutoffs (the cardinal sin) and no worse
   * total weighted error.
   */
  eouBeatsFloor: boolean;
}

function effectiveKnobs(vector: LabeledVector): TurnKnobs {
  return new TurnDetector(vector.knobs).config as TurnKnobs;
}

function toleranceFor(vector: LabeledVector): number {
  const k = effectiveKnobs(vector);
  return k.silenceFloorMs + k.incompleteExtensionMs + MATCH_GRACE_MS;
}

/** Replay one arm and collect the times at which a turn ended. */
function turnEndTimes(vector: LabeledVector, useSmartTurn: boolean): number[] {
  const det = new TurnDetector({ ...vector.knobs, useSmartTurn });
  const ends: number[] = [];
  for (const ev of vector.events) {
    for (const out of det.input(ev)) {
      if (out.type === 'turn-end') ends.push(out.t);
    }
  }
  return ends;
}

export function scoreArm(vector: LabeledVector, arm: Arm): ArmResult {
  const tolerance = toleranceFor(vector);
  const ends = turnEndTimes(vector, arm === 'combined').slice().sort((a, b) => a - b);
  const boundaries = vector.trueTurnBoundaries
    .map((b) => b.t)
    .slice()
    .sort((a, b) => a - b);

  const boundaryUsed = boundaries.map(() => false);
  const latencies: number[] = [];
  let falseCutoffs = 0;

  // Greedy earliest-match: each turn-end claims the earliest unused boundary it
  // lands within [B, B + tolerance]; an unmatched turn-end is a false cutoff.
  for (const te of ends) {
    let matched = -1;
    for (let i = 0; i < boundaries.length; i++) {
      if (boundaryUsed[i]) continue;
      if (te >= boundaries[i] && te <= boundaries[i] + tolerance) {
        matched = i;
        break;
      }
    }
    if (matched >= 0) {
      boundaryUsed[matched] = true;
      latencies.push(te - boundaries[matched]);
    } else {
      falseCutoffs += 1;
    }
  }

  const truePositives = boundaryUsed.filter(Boolean).length;
  const falseContinuations = boundaryUsed.filter((u) => !u).length;
  const meanLatencyMs =
    latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  return {
    arm,
    turnEnds: ends,
    falseCutoffs,
    falseContinuations,
    truePositives,
    meanLatencyMs,
    weightedError: falseCutoffs * FALSE_CUTOFF_WEIGHT + falseContinuations * FALSE_CONTINUATION_WEIGHT,
  };
}

export function measureVector(vector: LabeledVector): VectorResult {
  return {
    name: vector.name,
    toleranceMs: toleranceFor(vector),
    combined: scoreArm(vector, 'combined'),
    baseline: scoreArm(vector, 'baseline'),
  };
}

function aggregate(arm: Arm, results: VectorResult[]): AggregateArm {
  const pick = (r: VectorResult) => (arm === 'combined' ? r.combined : r.baseline);
  let falseCutoffs = 0;
  let falseContinuations = 0;
  let truePositives = 0;
  let weightedError = 0;
  let latencySum = 0;
  let latencyN = 0;
  for (const r of results) {
    const a = pick(r);
    falseCutoffs += a.falseCutoffs;
    falseContinuations += a.falseContinuations;
    truePositives += a.truePositives;
    weightedError += a.weightedError;
    if (a.meanLatencyMs !== null) {
      latencySum += a.meanLatencyMs * a.truePositives;
      latencyN += a.truePositives;
    }
  }
  return {
    arm,
    falseCutoffs,
    falseContinuations,
    truePositives,
    meanLatencyMs: latencyN > 0 ? Math.round(latencySum / latencyN) : null,
    weightedError,
  };
}

export function summarize(vectors: LabeledVector[]): MeasurementSummary {
  const perVector = vectors.map(measureVector);
  const combined = aggregate('combined', perVector);
  const baseline = aggregate('baseline', perVector);
  const eouBeatsFloor =
    combined.falseCutoffs < baseline.falseCutoffs && combined.weightedError <= baseline.weightedError;
  return { perVector, combined, baseline, eouBeatsFloor };
}

/** Render a human-readable metrics table (used by the CLI and test output). */
export function formatTable(summary: MeasurementSummary): string {
  const lines: string[] = [];
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  lines.push('scenario 6 — smart-turn+floor (combined) vs patience-only (baseline)');
  lines.push('');
  lines.push(
    `  ${pad('vector', 33)}${pad('arm', 10)}${pad('cutoff', 8)}${pad('cont', 6)}${pad('hit', 5)}${pad('latency', 9)}`,
  );
  lines.push(`  ${'-'.repeat(71)}`);
  for (const r of summary.perVector) {
    for (const a of [r.combined, r.baseline]) {
      lines.push(
        `  ${pad(a === r.combined ? r.name : '', 33)}${pad(a.arm, 10)}${pad(a.falseCutoffs, 8)}${pad(
          a.falseContinuations,
          6,
        )}${pad(a.truePositives, 5)}${pad(a.meanLatencyMs === null ? '-' : `${a.meanLatencyMs}ms`, 9)}`,
      );
    }
  }
  lines.push(`  ${'-'.repeat(71)}`);
  const agg = (a: AggregateArm) =>
    `  ${pad('TOTAL', 33)}${pad(a.arm, 10)}${pad(a.falseCutoffs, 8)}${pad(a.falseContinuations, 6)}${pad(
      a.truePositives,
      5,
    )}${pad(a.meanLatencyMs === null ? '-' : `${a.meanLatencyMs}ms`, 9)}  (weighted err ${a.weightedError})`;
  lines.push(agg(summary.combined));
  lines.push(agg(summary.baseline));
  lines.push('');
  lines.push(
    `  verdict: smart-turn ${summary.eouBeatsFloor ? 'BEATS' : 'does NOT beat'} the bare floor ` +
      `(${summary.baseline.falseCutoffs - summary.combined.falseCutoffs} fewer false cutoffs, ` +
      `weighted err ${summary.combined.weightedError} vs ${summary.baseline.weightedError}).`,
  );
  return lines.join('\n');
}
