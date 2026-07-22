// Live knobs — the single source of truth the UI renders from.
//
// "Expose the floor and thresholds as live knobs; default biases to keep
//  listening." The turn knobs feed the pure detector (turn-detection.ts); the
// VAD knobs shape the speech-segmentation event stream and are applied to the
// microphone adapter. Both are tunable mid-session so the operator can feel the
// patience change in real time during the feel-test.

import { DEFAULT_KNOBS, type TurnKnobs } from './turn-detection.ts';
import type { GateConfig } from './response-hierarchy.ts';

export interface KnobSpec {
  key: string;
  label: string;
  kind: 'range' | 'toggle';
  default: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  help: string;
}

export const TURN_KNOBS: KnobSpec[] = [
  {
    key: 'silenceFloorMs',
    label: 'Silence floor (patience window)',
    kind: 'range',
    default: DEFAULT_KNOBS.silenceFloorMs,
    min: 200,
    max: 6000,
    // 50, not 100: the value su-lou.10.6 is hunting lives in the 500-750ms band, and
    // a 100ms grid cannot express 750 at all — `(750-200) % 100 ≠ 0`, so a range
    // input snaps it to 700 and the operator rates a rung they did not choose. The
    // sweep ladder is pinned to this grid by a test for exactly that reason.
    step: 50,
    unit: 'ms',
    help: 'Minimum silence before a pause may end the turn. The load-bearing tunable — raise it to wait through longer thinking-pauses.',
  },
  {
    key: 'incompleteExtensionMs',
    label: 'Incomplete extension',
    kind: 'range',
    default: DEFAULT_KNOBS.incompleteExtensionMs,
    min: 0,
    max: 8000,
    step: 100,
    unit: 'ms',
    help: 'Extra patience added when smart-turn reads the pause as "incomplete" (trailing conjunction, rising intonation).',
  },
  {
    key: 'completionThreshold',
    label: 'Completion threshold',
    kind: 'range',
    default: DEFAULT_KNOBS.completionThreshold,
    min: 0,
    max: 1,
    step: 0.05,
    unit: 'P',
    help: 'smart-turn P(complete) at or above this reads as "complete". Higher = more pauses read as incomplete = more patient.',
  },
  {
    key: 'responseDurationMs',
    label: 'Stubbed response length',
    kind: 'range',
    default: DEFAULT_KNOBS.responseDurationMs,
    min: 200,
    max: 4000,
    step: 100,
    unit: 'ms',
    help: 'How long the canned timing-only response "plays". Stands in for STT→LLM→TTS (U4–U6).',
  },
  {
    key: 'useSmartTurn',
    label: 'smart-turn veto',
    kind: 'toggle',
    default: DEFAULT_KNOBS.useSmartTurn,
    help: 'On = floor + asymmetric smart-turn veto. Off = patience-only baseline arm (the scenario-6 control).',
  },
];

/**
 * The FLOOR SWEEP LADDER (su-lou.10.5) — the values su-lou.10.6's feel-test steps
 * through, ordered most-patient → least.
 *
 * The slider alone can already reach any of these, and that is exactly the problem
 * it does not solve: an A/B by feel needs the SAME few values, in a known order,
 * reachable in one click, so two sittings are comparable and the operator is rating
 * the companion rather than hunting a slider. Dragging to "about 700" twice does not
 * produce two readings of one value.
 *
 * Spaced wide at the top and tight at the bottom because that is where the decision
 * lives: everything at/above ~1000ms is known-comfortable (it is the shipped
 * behaviour, minus a little), and the interesting question is where it starts to
 * cut people off. 200ms is deliberately past the point the measured EOU cost can
 * fit inside — the veto CANNOT land in time there, so it is the rung that shows the
 * operator what losing the classifier feels like, not a candidate default.
 */
export const FLOOR_SWEEP_MS: readonly number[] = [1500, 1000, 750, 500, 350, 200];

/** URL query-param name for a turn knob — the key itself (`?silenceFloorMs=750`). */
export function turnKnobParam(key: string): string {
  return key;
}

/**
 * Resolve the live turn knobs from a URL query string, layered over DEFAULT_KNOBS.
 *
 * The sweep's other half: the ladder makes a value reachable mid-session, this makes
 * one reproducible ACROSS sessions. A rung the operator liked is a URL they can
 * re-open, paste into the bead, or hand to the next person — where "I think it was
 * around 700" is not a measurement. It also means su-lou.10.6 can report its
 * preferred value as something re-runnable rather than as a slider position.
 *
 *   ?silenceFloorMs=<200..6000>        the load-bearing one — the patience window
 *   ?incompleteExtensionMs=<0..8000>   extra patience on an `incomplete` verdict
 *   ?completionThreshold=<0..1>        P(complete) boundary (BOTH readers — see
 *                                      gateConfigFromTurnKnobs)
 *   ?responseDurationMs=<200..4000>    stubbed response length
 *   ?useSmartTurn=<on|off>             the asymmetric veto, or the baseline arm
 *
 * Same rules as `resolveVadKnobs`, deliberately: values clamp to the knob's own
 * [min,max], and an absent, blank, non-numeric or non-finite value keeps the
 * default. Clamping rather than rejecting matters here — a fat-fingered
 * `?silenceFloorMs=50000` should give the operator the most patient harness the
 * slider can express, not silently the default they were trying to move away from.
 * Pure: `search` is passed in, so this is testable headlessly.
 */
export function resolveTurnKnobs(search: string): TurnKnobs {
  const q = new URLSearchParams(search);
  const knobs = { ...DEFAULT_KNOBS } as unknown as Record<string, number | boolean>;
  for (const spec of TURN_KNOBS) {
    const raw = q.get(turnKnobParam(spec.key));
    if (raw == null || raw.trim() === '') continue;
    if (spec.kind === 'toggle') {
      const v = parseToggle(raw);
      if (v !== null) knobs[spec.key] = v;
      continue;
    }
    if (spec.min == null || spec.max == null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    knobs[spec.key] = Math.min(spec.max, Math.max(spec.min, n));
  }
  return knobs as unknown as TurnKnobs;
}

/** `on`/`off` (and the usual synonyms) → boolean; anything else → null (keep default). */
function parseToggle(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

/** VAD adapter knobs (Silero via @ricky0123/vad-web). Defaults are vad-web's, tuned slightly toward patience. */
export interface VadKnobs {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  redemptionFrames: number;
  minSpeechFrames: number;
}

export const DEFAULT_VAD_KNOBS: VadKnobs = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionFrames: 12,
  minSpeechFrames: 3,
};

export const VAD_KNOBS: KnobSpec[] = [
  {
    key: 'positiveSpeechThreshold',
    label: 'VAD speech-on threshold',
    kind: 'range',
    default: DEFAULT_VAD_KNOBS.positiveSpeechThreshold,
    min: 0.1,
    max: 0.9,
    step: 0.05,
    unit: 'P',
    help: 'Silero probability above which a frame counts as speech onset.',
  },
  {
    key: 'negativeSpeechThreshold',
    label: 'VAD speech-off threshold',
    kind: 'range',
    default: DEFAULT_VAD_KNOBS.negativeSpeechThreshold,
    min: 0.1,
    max: 0.9,
    step: 0.05,
    unit: 'P',
    help: 'Probability below which speech is considered to have stopped.',
  },
  {
    key: 'redemptionFrames',
    label: 'VAD redemption frames',
    kind: 'range',
    default: DEFAULT_VAD_KNOBS.redemptionFrames,
    min: 1,
    max: 40,
    step: 1,
    unit: 'fr',
    help: 'Frames of sub-threshold audio tolerated before declaring speech-end. Higher = the VAD itself is more patient (~32ms/frame).',
  },
];

export function defaultTurnKnobs(): TurnKnobs {
  return { ...DEFAULT_KNOBS };
}

/**
 * The gate's runtime config, derived from the detector's LIVE turn knobs.
 *
 * The shared default (completion-threshold.ts) stops the two 0.5s drifting in the
 * source. It does nothing about the RUNTIME pair: `TurnDetector.setKnobs()` and
 * `GateConfig` are separately overridable, and the completion-threshold slider moves
 * only the first. That is the mirror that actually gets moved — su-lou.10.6 retunes
 * this threshold from the live UI during the feel-test, not by editing a default —
 * so the live app derives the gate's value from the detector's knob here rather than
 * re-defaulting it. One slider, both readers.
 *
 * A `Partial<GateConfig>`, not a whole one: the gate's other knobs (substantive word
 * count, acks, question cooldown) are not turn-detection's business and keep their
 * own defaults via `decideTier`'s spread.
 *
 * This lives in knobs.ts — the module that already owns "what the UI exposes and how
 * it reaches the engine" — so neither the detector nor the standalone gate has to
 * learn about the other.
 */
export function gateConfigFromTurnKnobs(knobs: TurnKnobs): Partial<GateConfig> {
  return { completionThreshold: knobs.completionThreshold };
}

/** URL query-param name for a VAD knob: `positiveSpeechThreshold` → `vadPositiveSpeechThreshold`. */
export function vadKnobParam(key: string): string {
  return 'vad' + key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Resolve the live VAD knobs from a URL query string, layered over the vad-web
 * defaults. This is the increment-1 café lever: the browser APM
 * (noiseSuppression/echoCancellation/autoGainControl) is ALREADY forced on by
 * @ricky0123/vad-web's getUserMedia (see vad.ts), so the remaining zero-rebuild
 * tuning surface is Silero's speech on/off thresholds + redemption frames —
 * exposed here as `?vad*` knobs so the operator can feel-tune a noisy room live:
 *
 *   ?vadPositiveSpeechThreshold=<0.1..0.9>  Silero P(speech) to OPEN a segment (raise to reject music)
 *   ?vadNegativeSpeechThreshold=<0.1..0.9>  P below which speech is considered stopped
 *   ?vadRedemptionFrames=<1..40>            sub-threshold frames tolerated before speech-end
 *
 * Each value is clamped to its knob's [min,max]; an absent, blank, non-numeric,
 * or non-finite value keeps the default (mirrors the STT/LLM/TTS resolvers'
 * fall-back-to-default rule). Only the three UI-exposed VAD_KNOBS are read —
 * minSpeechFrames is not a UI knob and stays at its default. Pure: `search` is
 * the page's `location.search`, passed in so this is testable headlessly.
 */
export function resolveVadKnobs(search: string): VadKnobs {
  const q = new URLSearchParams(search);
  const knobs = { ...DEFAULT_VAD_KNOBS } as unknown as Record<string, number>;
  for (const spec of VAD_KNOBS) {
    if (spec.kind !== 'range' || spec.min == null || spec.max == null) continue;
    const raw = q.get(vadKnobParam(spec.key));
    if (raw == null || raw.trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    knobs[spec.key] = Math.min(spec.max, Math.max(spec.min, n));
  }
  return knobs as unknown as VadKnobs;
}
