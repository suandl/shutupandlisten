// The BLIND-FIRST-EVALUATION race — does a sub-EOU-cost silence floor commit to a
// speaking tier before the smart-turn verdict can veto? (su-lou.10.8)
//
// THE MECHANISM (read the reducers, not this prose, for ground truth —
// turn-detection.ts + response-hierarchy.ts + main.ts's maybeRespond):
//
//   - A pause opens with `verdict = null` (turn-detection.ts onSpeechEnd). The EOU
//     verdict is produced ASYNC by the smart-turn worker, measured ~270ms warmed
//     (smart-turn.ts → WARMED_EOU_LATENCY_MS below).
//   - `extended()` (the smart-turn veto) is `useSmartTurn && verdict === 'incomplete'`;
//     it only ever LENGTHENS the floor. At a floor SHORTER than the EOU cost, the
//     deadline fires while `verdict` is still null → `extended()` is false → the
//     first evaluation carries `reason: 'floor'` and is answered BLIND.
//   - main.ts feeds the gate `completionProb = completionProbFromTurnEnd(reason)`, and
//     `'floor'` bridges to 1 ("certainly complete"). So on the blind first evaluation
//     the gate's rule 2 (the EOU-incomplete veto) is BYPASSED — a substantive, non-
//     trailing-off transcript escalates to a speaking tier. If the true verdict was
//     `incomplete`, that is a FALSE CUTOFF the veto was meant to prevent but could not.
//   - The late verdict does reach the machine, as EVIDENCE (spec §4b: onEou emits a
//     superseding `evaluate` with `trigger: 'evidence'`), but the gate keys on the
//     evaluation id and REPLAYS the blind decision (main.ts maybeRespond) — so in
//     stage 1 the verdict never overturns the blind commit.
//
// WHY A PURE MEASUREMENT, NOT the su-lou.10.5 browser harness (loop-latency.mjs).
// That harness drives the loop for LATENCY, and its sim substrate bakes each EOU
// verdict at speech-end + ~60ms (simulator.ts DEMO_SCRIPTS) — FASTER than any floor —
// so it structurally cannot reproduce a race that is about the ~270ms EOU cost; and
// the real smart-turn model is unprovisioned in CI, where the heuristic returns
// synchronously. This module instead drives the SAME reducers the app runs
// (`TurnDetector`, `decideTier`, `completionProbFromTurnEnd`) deterministically, with
// the EOU verdict placed at its MEASURED warmed latency — the only way to observe the
// race without a provisioned model, and non-flaky + unit-testable. It reuses the
// su-lou.10.5 floor-sweep ladder (`FLOOR_SWEEP_MS`) and the pure-module + `measure`-CLI
// idiom of its sibling, measurement.ts (scenario 6).
//
// PURE — no DOM, no clock, no I/O, no model. Same discipline as measurement.ts: the
// corpus is passed in (race-corpus.ts), disk/CLI live in measure-race.ts.
//
// WHAT THE RATE MEANS. The structural half is corpus-independent: at a floor below the
// EOU cost EVERY first evaluation is blind (deadline < verdict), and at/above it NONE
// is. The commit/false-cutoff COUNTS are a property of the transcript mix, so they are
// a mechanism demonstration over representative thinking-out-loud pauses, not a field
// rate — matching the bead's own hedge that B1-at-200ms is not strongly evidenced
// either way. The point is to show the race FIRES and to quantify it, not to claim a
// population frequency.

import { TurnDetector, DEFAULT_KNOBS, type InputEvent, type OutputEvent, type Verdict } from './turn-detection.ts';
import { decideTier, completionProbFromTurnEnd, type PriorDecision, type Tier } from './response-hierarchy.ts';
import { gateConfigFromTurnKnobs, FLOOR_SWEEP_MS } from './knobs.ts';

/**
 * The measured warmed EOU verdict latency (ms) in headless Chromium — log-Mel
 * front-end + inference + the worker message round-trip. Sourced from the prose in
 * smart-turn.ts (the DEFAULT_TIMEOUT_MS note: "~270ms a warmed verdict measures … the
 * worker hop is part of the wait"). This is the number the race turns on: a silence
 * floor SHORTER than this fires its first deadline before the verdict can land.
 */
export const WARMED_EOU_LATENCY_MS = 270;

/** One evaluated pause: what the gate sees, and what smart-turn WOULD say for it. */
export interface RacePause {
  /** Stable id for the table + tests. */
  name: string;
  /** One line on what this pause represents and why it is labelled as it is. */
  description: string;
  /**
   * The whole utterance transcribed so far at the pause — what `decideTier` reads as
   * `utteranceTextSoFar`. This is the only thing that decides speaking-vs-silence once
   * the EOU veto is bypassed (rules 1/3/4/5 of the gate).
   */
  textSoFar: string;
  /**
   * smart-turn's TRUE verdict for this pause — what it would report once it lands. A
   * blind commit on an `incomplete` pause is the false cutoff the veto exists to stop.
   */
  trueVerdict: Verdict;
  /** Speech duration before the pause (speech-start → speech-end), ms. Cosmetic to the
   *  race — the deadline (speechEnd+floor) and verdict (speechEnd+latency) share it —
   *  but kept realistic so the driven timeline reads true. */
  speechMs: number;
  /** 1-based utterance index for the gate's ack rotation / cooldown. Default 1. */
  utteranceIndex?: number;
  /** Prior decisions for the gate's history. Default none. Irrelevant to speaking-vs-
   *  silence (only splits reflection/question, both speaking); carried for fidelity. */
  priorDecisions?: PriorDecision[];
}

/** One pause's outcome at one floor. */
export interface RacePauseOutcome {
  name: string;
  /** The deadline-triggered FIRST evaluation fired before the EOU verdict landed. */
  blind: boolean;
  /** The gate committed to a speaking tier (tier !== 'silence') on that first evaluation. */
  committedToSpeaking: boolean;
  /** The tier the blind (or, at floors ≥ cost, verdict-aware) first evaluation produced. */
  tier: Tier;
  /** blind AND committedToSpeaking — the race fired for this pause. */
  raceFired: boolean;
  /** raceFired AND the true verdict was `incomplete` — a false cutoff the veto would have held. */
  falseCutoff: boolean;
}

/** The tally at one floor, across the corpus. */
export interface RaceFloorResult {
  floorMs: number;
  latencyMs: number;
  total: number;
  /** Pauses whose first evaluation was answered blind (before the verdict). */
  blind: number;
  /** Pauses where the blind first evaluation committed to a speaking tier. */
  raceFires: number;
  /** ...of those, the ones that were truly mid-thought (`incomplete`) — the B1 harm. */
  falseCutoffs: number;
  /** How many corpus pauses were truly `incomplete` — the denominator for a conditional
   *  false-cutoff rate (falseCutoffs / incompletePauses). */
  incompletePauses: number;
  outcomes: RacePauseOutcome[];
}

type EvaluateEvent = Extract<OutputEvent, { type: 'evaluate' }>;

/**
 * Score one pause at one floor by DRIVING THE REAL DETECTOR: place the EOU verdict at
 * `latencyMs` after speech-end and read back the first deadline-triggered `evaluate`.
 * Its `reason` ('floor' when the verdict had not landed, 'extended' when an incomplete
 * verdict was already present and lengthened the floor) is exactly what main.ts bridges
 * into the gate's `completionProb`, so applying `decideTier` here reproduces the app's
 * blind-first-evaluation decision without a browser.
 */
export function scorePauseAtFloor(
  pause: RacePause,
  floorMs: number,
  latencyMs: number = WARMED_EOU_LATENCY_MS,
): RacePauseOutcome {
  const det = new TurnDetector({ ...DEFAULT_KNOBS, silenceFloorMs: floorMs, useSmartTurn: true });
  const speechEnd = pause.speechMs;
  const eouT = speechEnd + latencyMs;
  const events: InputEvent[] = [
    { t: 0, type: 'speech-start' },
    { t: speechEnd, type: 'speech-end' },
    { t: eouT, type: 'eou', verdict: pause.trueVerdict },
    // Flush any deadline the verdict pushed out: an incomplete verdict at a floor ≥ the
    // EOU cost extends the window by incompleteExtensionMs, so tick well past that.
    { t: eouT + det.config.incompleteExtensionMs + floorMs + 1, type: 'tick' },
  ];

  let firstDeadline: EvaluateEvent | null = null;
  for (const ev of events) {
    for (const out of det.input(ev)) {
      if (out.type === 'evaluate' && out.trigger === 'deadline' && firstDeadline === null) {
        firstDeadline = out;
      }
    }
  }

  // The tick guarantees the window closes once, so this is defensive only.
  if (firstDeadline === null) {
    return { name: pause.name, blind: false, committedToSpeaking: false, tier: 'silence', raceFired: false, falseCutoff: false };
  }

  const blind = firstDeadline.t < eouT;
  const decision = decideTier(
    {
      utteranceIndex: pause.utteranceIndex ?? 1,
      utteranceTextSoFar: pause.textSoFar,
      // The exact bridge main.ts feeds the gate: the detector's two-valued turn-end
      // reason, not the classifier's score. 'floor' ⇒ 1 (the blind "certainly
      // complete" that bypasses rule 2); 'extended' ⇒ 0 (the veto held).
      completionProb: completionProbFromTurnEnd(firstDeadline.reason),
      msSinceSpeechEnd: firstDeadline.t - speechEnd,
      msSinceWeLastSpoke: Infinity,
      priorDecisions: pause.priorDecisions ?? [],
    },
    // Mirror main.ts: the gate's completion threshold comes from the detector's live
    // knob. Inert here (the bridge feeds a synthetic 0/1), carried for fidelity.
    gateConfigFromTurnKnobs(det.config),
  );

  const committedToSpeaking = decision.tier !== 'silence';
  const raceFired = blind && committedToSpeaking;
  const falseCutoff = raceFired && pause.trueVerdict === 'incomplete';
  return { name: pause.name, blind, committedToSpeaking, tier: decision.tier, raceFired, falseCutoff };
}

/** Tally one floor across the whole corpus. */
export function measureRaceAtFloor(
  corpus: readonly RacePause[],
  floorMs: number,
  latencyMs: number = WARMED_EOU_LATENCY_MS,
): RaceFloorResult {
  const outcomes = corpus.map((p) => scorePauseAtFloor(p, floorMs, latencyMs));
  return {
    floorMs,
    latencyMs,
    total: corpus.length,
    blind: outcomes.filter((o) => o.blind).length,
    raceFires: outcomes.filter((o) => o.raceFired).length,
    falseCutoffs: outcomes.filter((o) => o.falseCutoff).length,
    incompletePauses: corpus.filter((p) => p.trueVerdict === 'incomplete').length,
    outcomes,
  };
}

/** Sweep the su-lou.10.5 floor ladder (most-patient → least) at the measured EOU cost. */
export function measureRace(
  corpus: readonly RacePause[],
  floors: readonly number[] = FLOOR_SWEEP_MS,
  latencyMs: number = WARMED_EOU_LATENCY_MS,
): RaceFloorResult[] {
  return floors.map((f) => measureRaceAtFloor(corpus, f, latencyMs));
}

/** The finding, folded to a boolean: the race fires at least once in the sweep. */
export function raceConfirmed(results: readonly RaceFloorResult[]): boolean {
  return results.some((r) => r.raceFires > 0);
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);

/** Human-readable table (used by the CLI and echoed in test output). */
export function formatRaceTable(results: readonly RaceFloorResult[]): string {
  const lines: string[] = [];
  const latency = results[0]?.latencyMs ?? WARMED_EOU_LATENCY_MS;
  const total = results[0]?.total ?? 0;
  const incomplete = results[0]?.incompletePauses ?? 0;
  const pad = (s: string | number, n: number) => String(s).padEnd(n);

  lines.push('blind-first-evaluation race — deadline-triggered first evaluation vs the EOU verdict (su-lou.10.8)');
  lines.push('');
  lines.push(`  warmed EOU cost: ${latency}ms (smart-turn.ts) · corpus: ${total} pauses (${incomplete} truly mid-thought)`);
  lines.push('  "race fires" = the blind first evaluation commits to a speaking tier BEFORE the verdict lands.');
  lines.push('  "false cut"  = ...on a pause the verdict would have called incomplete — the B1 harm the veto exists to stop.');
  lines.push('');
  lines.push(`  ${pad('floor', 8)}${pad('blind', 12)}${pad('race fires', 16)}${pad('false cut', 16)}`);
  lines.push(`  ${'-'.repeat(50)}`);
  for (const r of results) {
    lines.push(
      `  ${pad(`${r.floorMs}ms`, 8)}` +
        `${pad(`${r.blind}/${r.total} (${pct(r.blind, r.total)})`, 12)}` +
        `${pad(`${r.raceFires}/${r.total} (${pct(r.raceFires, r.total)})`, 16)}` +
        `${pad(`${r.falseCutoffs}/${r.total} (${pct(r.falseCutoffs, r.total)})`, 16)}`,
    );
  }
  lines.push(`  ${'-'.repeat(50)}`);
  lines.push('');

  // The rung the bead is about, spelled out per pause so the count is auditable.
  const belowCost = results.filter((r) => r.floorMs < latency).sort((a, b) => b.floorMs - a.floorMs)[0];
  if (belowCost) {
    lines.push(`  at ${belowCost.floorMs}ms (below the ${latency}ms EOU cost) — every first evaluation is blind:`);
    for (const o of belowCost.outcomes) {
      const verdict = o.falseCutoff ? 'FALSE CUTOFF' : o.raceFired ? 'blind commit (verdict agreed)' : `held (${o.tier})`;
      lines.push(`    ${pad(o.name, 30)} ${pad(o.tier, 12)} ${verdict}`);
    }
    lines.push('');
    lines.push(
      `  verdict: at ${belowCost.floorMs}ms the smart-turn veto is bypassed on ${pct(belowCost.blind, belowCost.total)} ` +
        `of pauses; ${belowCost.raceFires}/${belowCost.total} commit to a speaking tier blind, ` +
        `of which ${belowCost.falseCutoffs} are false cutoffs ` +
        `(${pct(belowCost.falseCutoffs, belowCost.incompletePauses)} of the ${belowCost.incompletePauses} mid-thought pauses). ` +
        `At floors ≥ ${latency}ms the verdict is present at the deadline, so the veto gates and the race does not fire.`,
    );
  }
  return lines.join('\n');
}
