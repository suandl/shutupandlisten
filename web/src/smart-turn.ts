// smart-turn v3 end-of-utterance adapter (CPU/WASM).
//
// Pipecat smart-turn v3 is an ~8M-param audio classifier (~8MB int8, ~12ms on
// CPU) that answers "is this utterance complete?" — fed here as the asymmetric
// veto in turn-detection.ts. It runs via onnxruntime-web on CPU/WASM, off the
// GPU (which the plan reserves for the LLM + TTS in U5/U6).
//
// SUBSTITUTION NOTE (per the bead: "if a pick is unavailable, substitute and
// NOTE it"): the real ONNX model + its exact mel front-end are validated in the
// browser during the operator feel-test, not in CI (there is no headless mic
// here). So this adapter is defensive: it tries to load the model from a
// configurable URL and, if that is unavailable, falls back to a transparent,
// clearly-labelled DURATION HEURISTIC (short trailing segments — "and", "so",
// "but" — read as incomplete). The asymmetric-veto LOGIC it feeds is fully unit
// tested in turn-detection.ts regardless of which verdict source is live; the
// model only changes verdict QUALITY, which is a U3 tuning concern surfaced in
// the feel-test. The UI shows which mode is active.

export type SmartTurnMode = 'model' | 'heuristic';

export interface SmartTurnResult {
  /** P(complete) in [0,1]; higher = more likely a finished thought. */
  completionProb: number;
  mode: SmartTurnMode;
}

export interface SmartTurnOptions {
  /** URL of the smart-turn v3 ONNX model. When omitted/unreachable → heuristic. */
  modelUrl?: string;
  /** Trailing segments shorter than this read as "incomplete" in heuristic mode. */
  heuristicShortSegmentMs?: number;
}

export interface SmartTurn {
  readonly mode: SmartTurnMode;
  /** Classify a 16kHz mono speech segment. Never throws — degrades to heuristic. */
  predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnResult>;
}

const SAMPLE_RATE = 16000;

/**
 * Load smart-turn. Attempts the real ONNX model when a URL is given; otherwise
 * (or on any failure) returns a heuristic implementation. Resolves quickly so
 * the harness never blocks on a model download.
 */
export async function createSmartTurn(opts: SmartTurnOptions = {}): Promise<SmartTurn> {
  const shortMs = opts.heuristicShortSegmentMs ?? 700;

  const heuristic: SmartTurn = {
    mode: 'heuristic',
    async predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnResult> {
      const durationMs = (audio.length / (sampleRate || SAMPLE_RATE)) * 1000;
      // Short trailing utterances are more likely mid-thought ("and", "so",
      // "but"); a long final clause is more likely complete. Map duration to a
      // smooth P(complete) around the short-segment knee so the threshold knob
      // still bites.
      const completionProb = clamp01(0.2 + 0.6 * (durationMs / (shortMs * 2)));
      return { completionProb, mode: 'heuristic' };
    },
  };

  if (!opts.modelUrl) return heuristic;

  try {
    const ort = await import('onnxruntime-web');
    const session = await ort.InferenceSession.create(opts.modelUrl, {
      executionProviders: ['wasm'],
    });
    return {
      mode: 'model',
      async predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnResult> {
        try {
          const features = toModelInput(audio, sampleRate);
          const input = new ort.Tensor('float32', features, [1, features.length]);
          // smart-turn v3 exposes a single audio input and a completion logit;
          // tensor names vary by export, so bind by position.
          const feeds: Record<string, unknown> = {};
          feeds[session.inputNames[0]] = input;
          const out = await session.run(feeds as never);
          const logits = out[session.outputNames[0]].data as Float32Array;
          const completionProb = logits.length === 1 ? sigmoid(logits[0]) : softmaxComplete(logits);
          return { completionProb: clamp01(completionProb), mode: 'model' };
        } catch {
          return heuristic.predict(audio, sampleRate);
        }
      },
    };
  } catch {
    return heuristic;
  }
}

/** Resample to 16kHz mono (nearest-neighbour — adequate for a coarse classifier front-end). */
function toModelInput(audio: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === SAMPLE_RATE) return audio;
  const ratio = sampleRate / SAMPLE_RATE;
  const outLen = Math.floor(audio.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = audio[Math.floor(i * ratio)] ?? 0;
  return out;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function softmaxComplete(logits: Float32Array): number {
  // Convention: index 1 = "complete".
  const max = Math.max(logits[0], logits[1]);
  const a = Math.exp(logits[0] - max);
  const b = Math.exp(logits[1] - max);
  return b / (a + b);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
