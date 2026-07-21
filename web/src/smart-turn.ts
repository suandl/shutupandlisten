// smart-turn v3 end-of-utterance adapter (CPU/WASM).
//
// Pipecat smart-turn v3 is an ~8M-param audio classifier (~8MB int8, ~12ms on CPU)
// that answers "is this utterance complete?" — fed here as the asymmetric veto in
// turn-detection.ts. It runs via onnxruntime-web on CPU/WASM, off the GPU (which the
// plan reserves for the LLM + TTS in U5/U6).
//
// IT HAD NEVER RUN (su-lou.10.1). Until this unit there was no provisioner for the
// model, so `if (!opts.modelUrl) return heuristic` took every call and the live
// harness has always been the duration heuristic below. That is why the 2000ms
// silence floor carried ALL the patience alone — with no real end-of-utterance
// signal, the timer WAS the decision. Dropping the floor to ~500-750ms (su-lou.10.5)
// only makes sense once this stage is real, so `npm run provision:smart-turn` +
// this adapter are a prerequisite for that unit, not a nicety.
//
// The heuristic REMAINS, on purpose: an un-provisioned deploy, a fresh clone or CI
// has no model to load, and the harness must still run. What is NOT acceptable is
// claiming `model` while running the heuristic — the UI, the probe and the
// works-check all read `.mode`, and su-lou.7/.8/.9 were each a stage silently
// degrading behind a mode nobody checked. Every degrade here is reported through
// `onDiagnostic` and reflected in `.mode`.
//
// The input contract is NOT raw audio: v3 is a Whisper-tiny encoder, so it takes the
// Whisper log-Mel spectrogram of the last 8 seconds ([1, 80, 800]). That front-end
// lives in whisper-mel.ts, conformance-tested against the canonical implementation.

import { N_FRAMES, N_MELS, whisperFeatures } from './whisper-mel.ts';

export type SmartTurnMode = 'model' | 'heuristic';

export interface SmartTurnResult {
  /** P(complete) in [0,1]; higher = more likely a finished thought. */
  completionProb: number;
  mode: SmartTurnMode;
}

/**
 * Structural view of the ONNX session the adapter needs — one feature tensor in,
 * one score out. Injectable so the model path is unit-testable without ORT, a
 * browser, or the 8MB provisioned asset.
 */
export interface FeatureClassifier {
  /** Run the classifier on `[1, N_MELS, N_FRAMES]` feature data. */
  run(features: Float32Array): Promise<ArrayLike<number>>;
  /** Release the session. */
  close(): void;
}

export interface SmartTurnOptions {
  /** URL of the smart-turn v3 ONNX model. When omitted/unreachable → heuristic. */
  modelUrl?: string;
  /**
   * Directory holding the ONNX Runtime wasm binaries, served SAME-ORIGIN. Without
   * it onnxruntime-web falls back to fetching them from a CDN, which would break
   * the no-egress posture the rest of the harness holds (see stt.ts / tts.ts).
   */
  wasmPath?: string;
  /** Trailing segments shorter than this read as "incomplete" in heuristic mode. */
  heuristicShortSegmentMs?: number;
  /** Per-call ms before a wedged session degrades THIS verdict to the heuristic. */
  timeoutMs?: number;
  /** Where a degrade is reported. Defaults to `console.warn`; injectable for tests. */
  onDiagnostic?: (message: string) => void;
  /** Inject the classifier (tests / custom hosting). Defaults to onnxruntime-web. */
  createClassifier?: () => Promise<FeatureClassifier>;
}

export interface SmartTurn {
  readonly mode: SmartTurnMode;
  /** Classify a 16kHz mono speech segment. Never throws — degrades to heuristic. */
  predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnResult>;
  /** Release the ONNX session, if any. */
  close(): void;
}

const SAMPLE_RATE = 16000;

/**
 * A verdict that lands after the turn was already decided is worthless, so a wedged
 * session degrades this call rather than hanging the promise chain. Generous next to
 * the ~12ms the model actually takes: this catches a stall, not a slow machine.
 */
const DEFAULT_TIMEOUT_MS = 2000;

// ── Default self-hosted smart-turn config (`npm run provision:smart-turn`) ──
//
// Same shape as STT/LLM/TTS/denoise: assets served from the app's OWN origin, so a
// provisioned deploy classifies out-of-the-box and an un-provisioned one degrades to
// the labelled heuristic. Nothing is fetched cross-origin and no mic audio leaves
// the page. The model is a bare ONNX graph (not a transformers.js pipeline), so
// unlike the other stages it needs no engine wrapper — just onnxruntime-web, whose
// wasm binaries are provisioned alongside it.
export const DEFAULT_SMART_TURN_MODEL_URL = '/smart-turn/smart-turn-v3.onnx';
export const DEFAULT_SMART_TURN_WASM_PATH = '/smart-turn/ort/';

/** Report a degrade, so a stage that falls back names itself (su-lou.7's lesson). */
function diag(opts: SmartTurnOptions, reason: string): void {
  (opts.onDiagnostic ?? ((m: string) => console.warn(m)))(`[smart-turn] ${reason} — using the duration heuristic`);
}

/**
 * Map the model's raw output to P(complete).
 *
 * smart-turn v3 ends in a Sigmoid, so its single `logits` output is ALREADY a
 * probability — applying sigmoid again would squash every verdict into [0.5, 0.73]
 * and quietly destroy the threshold knob. A value outside [0,1] therefore means the
 * export is a raw-logit variant, and only then is sigmoid correct. A two-value
 * output is a 2-class head (index 1 = complete).
 */
export function completionProbFrom(data: ArrayLike<number>): number {
  if (data.length === 0) throw new Error('classifier returned no output');
  let prob: number;
  if (data.length === 1) {
    const raw = data[0];
    prob = raw >= 0 && raw <= 1 ? raw : sigmoid(raw);
  } else {
    prob = softmaxComplete(data);
  }
  // A NaN score must NOT be clamped into a plausible-looking verdict: clamp01(NaN)
  // is NaN, and `NaN >= completionThreshold` is false, so it would reach the
  // detector as a silent, permanent "incomplete" veto. Throw instead — the caller
  // degrades to the heuristic and reports why.
  if (!Number.isFinite(prob)) throw new Error(`classifier returned a non-finite score (${data[0]})`);
  return clamp01(prob);
}

/**
 * Load smart-turn. Attempts the real ONNX model when a URL is given; otherwise (or
 * on any failure) returns a heuristic implementation. Resolves quickly so the
 * harness never blocks on a model download.
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
    close() {
      /* nothing to release */
    },
  };

  if (!opts.createClassifier && !opts.modelUrl) return heuristic;

  let classifier: FeatureClassifier;
  try {
    classifier = await (opts.createClassifier ?? (() => ortClassifier(opts)))();
  } catch (err) {
    diag(opts, `model failed to load (${errText(err)})`);
    return heuristic;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let degraded = false; // report a per-call degrade once, not once per utterance

  return {
    mode: 'model',
    async predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnResult> {
      try {
        if (sampleRate !== SAMPLE_RATE) {
          // The VAD hands segments over at exactly 16kHz; resampling silently here
          // would change verdict quality without anyone knowing.
          throw new Error(`expected ${SAMPLE_RATE}Hz audio, got ${sampleRate}Hz`);
        }
        const features = whisperFeatures(audio);
        const data = await withTimeout(classifier.run(features), timeoutMs);
        return { completionProb: completionProbFrom(data), mode: 'model' };
      } catch (err) {
        if (!degraded) {
          degraded = true;
          diag(opts, `classification failed (${errText(err)})`);
        }
        return heuristic.predict(audio, sampleRate);
      }
    },
    close() {
      try {
        classifier.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * The real backend: onnxruntime-web, CPU/WASM only.
 *
 * The `/wasm` entrypoint is deliberate — the default bundle also carries the WebGPU
 * (jsep) backend, whose wasm binary is twice the size and would contend with the
 * LLM/TTS for the GPU this stage promises not to touch.
 */
async function ortClassifier(opts: SmartTurnOptions): Promise<FeatureClassifier> {
  const ort = await import('onnxruntime-web/wasm');
  // Self-hosted wasm: without this, onnxruntime-web resolves its binaries against a
  // CDN, and an on-device harness would start fetching cross-origin at first speech.
  const wasmPath = opts.wasmPath ?? DEFAULT_SMART_TURN_WASM_PATH;
  if (wasmPath) ort.env.wasm.wasmPaths = wasmPath;

  const session = await ort.InferenceSession.create(opts.modelUrl!, { executionProviders: ['wasm'] });
  // v3 names its input `input_features`; bind by name when present and fall back to
  // position, because export tensor names have varied across the v3.x line.
  const inputName = session.inputNames.includes('input_features') ? 'input_features' : session.inputNames[0];
  const outputName = session.outputNames[0];

  return {
    async run(features: Float32Array): Promise<ArrayLike<number>> {
      const tensor = new ort.Tensor('float32', features, [1, N_MELS, N_FRAMES]);
      const out = await session.run({ [inputName]: tensor });
      return out[outputName].data as Float32Array;
    },
    close() {
      void session.release?.();
    },
  };
}

/** Reject after `ms` so one wedged call cannot hold a turn open. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function softmaxComplete(logits: ArrayLike<number>): number {
  // Convention: index 1 = "complete".
  const max = Math.max(logits[0], logits[1]);
  const a = Math.exp(logits[0] - max);
  const b = Math.exp(logits[1] - max);
  return b / (a + b);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
