// Live knobs — the single source of truth the UI renders from.
//
// "Expose the floor and thresholds as live knobs; default biases to keep
//  listening." The turn knobs feed the pure detector (turn-detection.ts); the
// VAD knobs shape the speech-segmentation event stream and are applied to the
// microphone adapter. Both are tunable mid-session so the operator can feel the
// patience change in real time during the feel-test.

import { DEFAULT_KNOBS, type TurnKnobs } from './turn-detection.ts';

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
    step: 100,
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
