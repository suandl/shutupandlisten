// The smart-turn classifier itself: log-Mel front-end → ONNX inference → P(complete),
// plus the load-time assertion that ties the two together. Everything from a 16kHz
// segment to a probability lives here. The POLICY around it — heuristic fallback,
// per-call timeout, abandonment of a wedged session — stays in smart-turn.ts.
//
// WHY IT IS ITS OWN MODULE (su-viz2). Both halves of the verdict had to leave the main
// thread. Measured (su-lou.10.5, headless Chromium, the real provisioned model):
//
//   691ms verdict → 691ms blocked · 1007ms → 1007ms · 956ms → 956ms
//
// 100%, every time, with zero heartbeat ticks delivered — the page was frozen for the
// whole verdict, on every single pause. And because that freeze also stalled main.ts's
// 90ms tick loop, which is what fires the patience deadline, the block did not merely
// accompany the latency, it ADDED to it.
//
// `ort.env.wasm.proxy = true` would have been the one-line version, and it is not
// enough: it moves the INFERENCE and leaves the pure-JS log-Mel front-end —
// `whisperFeatures()`, an FFT over 8 seconds of audio — on the calling thread. So the
// whole path moved into smart-turn.worker.ts, and this module is what that worker runs.
//
// It is a LEAF on purpose: the worker must not import smart-turn.ts, because that
// module SPAWNS the worker (`new Worker(new URL('./smart-turn.worker.ts', ...))`) and
// importing it from inside would bundle that spawn into the worker itself. Same reason
// stt.worker.ts imports engine-url.ts rather than stt.ts.
//
// It is also deliberately DOM-free and Worker-free: every line here runs under
// `node --test` (smart-turn-classifier.test.ts). That is what keeps the load-time
// assertion below — the thing that stops a dead graph from reporting `model` — under
// test after the hop off the main thread, rather than letting it vanish into a
// browser-only file nothing exercises.

import { N_FRAMES, N_MELS, whisperFeatures } from './whisper-mel.ts';

/**
 * Structural view of the ONNX session the classifier needs — one feature tensor in,
 * one score out. Injectable so the model path is unit-testable without ORT, a
 * browser, or the 8MB provisioned asset.
 */
export interface FeatureClassifier {
  /** Run the classifier on `[1, N_MELS, N_FRAMES]` feature data. */
  run(features: Float32Array): Promise<ArrayLike<number>>;
  /** Release the session. */
  close(): void;
}

export interface SmartTurnClassifier {
  /** Score a 16kHz mono segment → P(complete). THROWS on any failure — the caller
   *  (the worker) relays the reason, and smart-turn.ts turns it into a degrade. */
  score(audio: Float32Array): Promise<number>;
  /** Release the underlying session. */
  close(): void;
}

export interface SmartTurnClassifierOptions {
  /** Produce the session. Defaults to nothing — the caller injects ORT or a fake. */
  createClassifier: () => Promise<FeatureClassifier>;
  /** Budget for the load-time warmup run. Far larger than a steady-state call: the
   *  first inference compiles and specializes the graph (~1s in headless Chromium
   *  against ~60ms warm), so this catches a wedged load, not a slow one. */
  initTimeoutMs?: number;
}

/** Budget for the load-time warmup — a cold first inference, not a steady-state one. */
export const DEFAULT_INIT_TIMEOUT_MS = 30000;

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
  if (!Number.isFinite(prob)) {
    // Name the WHOLE raw output, not `data[0]`: a 2-class output like [1, Infinity]
    // softmaxes to NaN, but `data[0]` is an innocent 1 — reporting "(1)" hides the
    // Infinity that actually broke the score. The caller relays this reason verbatim.
    throw new Error(`classifier returned a non-finite score from output [${Array.from(data).join(', ')}]`);
  }
  return clamp01(prob);
}

/**
 * Load the classifier and PROVE it can score before handing it back.
 *
 * Warms the graph once, here, before any speech. Two reasons, both load-bearing:
 *
 *   1. ORT compiles and specializes on the FIRST run — ~1s in headless Chromium
 *      against ~60ms warm. This runs inside the worker's init handshake, which
 *      smart-turn.ts awaits at mic start, so that cost belongs here and not inside
 *      the silence floor of the user's first utterance, where it would be the very
 *      lag su-lou.10.1 existed to remove.
 *   2. It makes the adapter's `mode` an assertion rather than a hope. A graph that
 *      cannot produce a usable score — wrong input shape, corrupt weights, an export
 *      whose output this module can't map — THROWS here, so the worker reports a
 *      failed load and the adapter honestly says `heuristic`. It never reports
 *      `model` for something that would degrade on every call. That false-green is
 *      exactly what su-lou.7/.8/.9 each turned out to be, three separate times, and
 *      moving the work into a worker (su-viz2) must not quietly reintroduce it —
 *      which is why this assertion lives in a module `node --test` can reach.
 */
export async function createSmartTurnClassifier(opts: SmartTurnClassifierOptions): Promise<SmartTurnClassifier> {
  let classifier: FeatureClassifier;
  try {
    classifier = await opts.createClassifier();
  } catch (err) {
    throw new Error(`model failed to load (${errText(err)})`);
  }

  try {
    completionProbFrom(
      await withTimeout(classifier.run(new Float32Array(N_MELS * N_FRAMES)), opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS),
    );
  } catch (err) {
    closeQuietly(classifier);
    throw new Error(`model loaded but could not score (${errText(err)})`);
  }

  return {
    async score(audio: Float32Array): Promise<number> {
      // Both halves of the verdict, together, on whichever thread this runs on —
      // which is the whole point of su-viz2. `completionProbFrom` throws rather than
      // returning a plausible-looking number, so a bad output degrades this call
      // instead of reaching the detector as a silent veto.
      return completionProbFrom(await classifier.run(whisperFeatures(audio)));
    },
    close() {
      closeQuietly(classifier);
    },
  };
}

export interface OrtClassifierOptions {
  /** URL of the smart-turn v3 ONNX model. Already same-origin-checked by the caller. */
  modelUrl: string;
  /**
   * Explicit URL of the ONNX Runtime wasm binary. Defaults to the asset the bundler
   * emitted from this app's own onnxruntime-web — same-origin and version-coherent
   * by construction — so this is only for a host that serves it from elsewhere.
   */
  wasmPath?: string;
}

/**
 * The real backend: onnxruntime-web, CPU/WASM only.
 *
 * The `/wasm` entrypoint is deliberate — the default bundle also carries the WebGPU
 * (jsep) backend, whose wasm binary is twice the size (26.8MB vs 13.5MB in dist/)
 * and would contend with the LLM/TTS for the GPU this stage promises not to touch.
 *
 * ORT is imported LAZILY, inside this function, so that importing this module costs
 * nothing under `node --test` — which is what lets the rest of the file be tested.
 */
export async function ortClassifier(opts: OrtClassifierOptions): Promise<FeatureClassifier> {
  const ort = await import('onnxruntime-web/wasm');

  // Pin the runtime binary to the one the BUNDLER emitted from the very
  // onnxruntime-web this module imports. Same-origin by construction (so first
  // speech never triggers a cross-origin fetch — onnxruntime-web's own fallback is
  // a jsdelivr CDN, which would break the no-egress posture silently), and
  // version-coherent by construction (the binary and the JS come from one install,
  // so they cannot drift). It is also the asset Vite emits anyway, so pointing at
  // it costs nothing: provisioning a second copy would just add ~13MB of bytes
  // that are downloaded and never used.
  //
  // `?url` is Vite-only, so it is resolved HERE — inside the lazily-imported real
  // backend — and never at module scope, where it would break `node --test`. If a
  // non-Vite bundler leaves it unresolved, `wasmPaths` stays unset and ORT falls
  // back to its own resolution rather than failing.
  const wasmUrl = opts.wasmPath ?? (await bundledWasmUrl());
  if (wasmUrl) ort.env.wasm.wasmPaths = { wasm: wasmUrl };

  const session = await ort.InferenceSession.create(opts.modelUrl, { executionProviders: ['wasm'] });
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

/**
 * URL of the ONNX Runtime wasm binary as emitted by the bundler, or undefined when
 * the `?url` form is unavailable (a non-Vite bundler, a bare-module runtime) — in
 * which case the caller leaves ORT to resolve the binary itself.
 */
async function bundledWasmUrl(): Promise<string | undefined> {
  try {
    return (await import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url')).default;
  } catch {
    return undefined;
  }
}

/** Reject after `ms` so a wedged warmup cannot hold the init handshake open. */
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

function closeQuietly(classifier: FeatureClassifier): void {
  try {
    classifier.close();
  } catch {
    /* already gone */
  }
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
