// In-browser speech-to-text adapter — U4. Moonshine (CPU/WASM) primary,
// Whisper-small fallback.
//
// Mirrors smart-turn.ts exactly: it ATTEMPTS a real on-device model and, when
// that is unavailable, degrades to a transparent, clearly-labelled STUB so the
// harness and its tests never block on a model download. The model runs in a Web
// Worker (CPU/WASM, off the GPU the LLM/TTS reserve for U5/U6) and is loaded from
// operator-supplied LOCAL assets — never a network fetch by default (the plan's
// no-egress posture). The transcript ALIGNMENT this feeds (transcript.ts) is
// fully tested regardless of which mode is live; only transcription QUALITY
// depends on the model, validated on real audio during the operator feel-test.
//
// SUBSTITUTION NOTE (per the bead: "substitute and note", mirroring smart-turn):
// the real Moonshine/Whisper export + tokenizer + autoregressive decode are heavy
// and unvalidatable in CI (no headless mic, no bundled weights). Rather than
// hand-roll an ONNX decoder, the worker (stt.worker.ts) loads a transformers.js-
// compatible engine module and the model from configurable runtime URLs; absent
// that config the adapter is the stub. Wiring a specific Moonshine ONNX export is
// the first task of the U4 tuning pass, exactly as smart-turn's was.

import type { TranscriberMode } from './transcript.ts';

export type { TranscriberMode } from './transcript.ts';

export interface TranscriptResult {
  /** Transcribed text (a labelled placeholder in stub mode). */
  text: string;
  /** Which source produced THIS result; a worker timeout/error degrades to 'stub'. */
  mode: TranscriberMode;
}

/** Minimal structural Worker shape so the adapter is unit-testable with a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
}

export interface TranscriberOptions {
  /** transformers.js-compatible engine module URL, loaded at runtime in the worker. */
  engineUrl?: string;
  /** Moonshine model id / local path — the primary, variable-length STT. */
  moonshineModel?: string;
  /** Whisper-small model id / local path — the noisy/disfluent fallback. */
  whisperModel?: string;
  /** Inject a worker (tests / custom hosting). Defaults to the bundled stt.worker. */
  createWorker?: () => WorkerLike;
  /** Per-call ms before degrading to a stub result (model wedged / slow). */
  timeoutMs?: number;
}

export interface Transcriber {
  readonly mode: TranscriberMode;
  /** Transcribe a 16kHz mono speech segment. NEVER throws — degrades to a stub. */
  transcribe(audio: Float32Array, sampleRate: number): Promise<TranscriptResult>;
  /** Release the worker, if any. */
  close(): void;
}

const SAMPLE_RATE = 16000;
const DEFAULT_TIMEOUT_MS = 15000;

// ── Default self-hosted STT config — the U4 tuning-pass wiring ──
//
// These point the adapter at an engine + weights served from the app's OWN
// origin, so the harness transcribes out-of-the-box once the assets are
// provisioned (`npm run provision:stt`, run at build/deploy). No third-party
// origin is fetched for engine or model at runtime and no user audio leaves the
// page — the su-0hi #1 / no-egress posture. When the assets are ABSENT (fresh
// clone, CI, un-provisioned deploy) the worker's engine import 404s, the
// handshake fails closed, and the adapter degrades to the labelled stub exactly
// as before. See web/public/stt-engine.js, web/scripts/provision-stt.mjs, README.
//
// Engine: the committed same-origin wrapper public/stt-engine.js. It pins the
// on-device / no-egress env (ONNX wasmPaths + localModelPath same-origin,
// allowRemoteModels=false) around a provisioned transformers.js v3 (3.8.1) ESM
// bundle, and defaults inference to CPU/WASM + quantized weights. Model ids
// resolve under env.localModelPath (= same-origin /models/<id>/).
//
// Models — concrete, transformers.js-v3-compatible, quantized (q8) for CPU/WASM:
//   primary  — onnx-community/moonshine-base-ONNX  (variable-length, proportional compute)
//   fallback — onnx-community/whisper-small        (noisy / disfluent speech)
export const DEFAULT_STT_ENGINE_URL = '/stt-engine.js';
export const DEFAULT_MOONSHINE_MODEL = 'onnx-community/moonshine-base-ONNX';
export const DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-small';

/** A labelled placeholder so the alignment UI stays legible without a model. */
export function stubText(durationMs: number): string {
  return `⟨speech ${(durationMs / 1000).toFixed(1)}s — STT model not loaded⟩`;
}

function stubResult(audio: Float32Array, sampleRate: number): TranscriptResult {
  const durationMs = (audio.length / (sampleRate || SAMPLE_RATE)) * 1000;
  return { text: stubText(durationMs), mode: 'stub' };
}

function makeStub(): Transcriber {
  return {
    mode: 'stub',
    async transcribe(audio: Float32Array, sampleRate: number): Promise<TranscriptResult> {
      return stubResult(audio, sampleRate);
    },
    close() {
      /* nothing to release */
    },
  };
}

/**
 * Create a transcriber. With a model configured (or an injected worker) it spins
 * up the STT worker and, only if the worker reports it loaded a model, returns a
 * worker-backed transcriber; on any failure — no model, worker spawn error, init
 * timeout, bad handshake — it returns the stub. Resolves quickly: the harness
 * never blocks on a model download, and the UI reads `.mode` to show what's live.
 */
export async function createTranscriber(opts: TranscriberOptions = {}): Promise<Transcriber> {
  const hasModel = Boolean(opts.moonshineModel || opts.whisperModel);
  if (!opts.createWorker && !hasModel) return makeStub();

  let worker: WorkerLike;
  try {
    worker = opts.createWorker ? opts.createWorker() : defaultWorker();
  } catch {
    return makeStub();
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mode = await initWorker(worker, opts, timeoutMs);
  if (mode === null) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    return makeStub();
  }

  let nextId = 0;
  // Each pending request stores its timer-clearing settler plus a per-request
  // fallback — the labelled stub for THIS segment — so a worker error reply
  // degrades to the stub text instead of an empty string the transcript would
  // render as ∅. (su-0hi #2)
  const pending = new Map<number, { settle: (r: TranscriptResult) => void; fallback: () => TranscriptResult }>();
  const onMessage = (ev: { data?: unknown }): void => {
    const msg = ev.data as { type?: string; id?: number; text?: string; error?: boolean } | undefined;
    if (!msg || msg.type !== 'result' || typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    entry.settle(msg.error ? entry.fallback() : { text: typeof msg.text === 'string' ? msg.text : '', mode });
  };
  worker.addEventListener('message', onMessage);

  return {
    mode,
    transcribe(audio: Float32Array, sampleRate: number): Promise<TranscriptResult> {
      return new Promise<TranscriptResult>((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve(stubResult(audio, sampleRate));
        }, timeoutMs);
        pending.set(id, {
          settle: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          fallback: () => stubResult(audio, sampleRate),
        });
        try {
          // No transfer list: structured-clone the samples so the caller's
          // smart-turn path keeps an intact copy of the same segment.
          worker.postMessage({ type: 'transcribe', id, audio, sampleRate });
        } catch {
          clearTimeout(timer);
          if (pending.delete(id)) resolve(stubResult(audio, sampleRate));
        }
      });
    },
    close() {
      try {
        worker.removeEventListener('message', onMessage);
        worker.terminate();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Run the worker's init handshake. Posts an `init` and waits for `ready` (with a
 * loaded model mode) or fails closed on `error`, a malformed reply, or timeout.
 */
function initWorker(
  worker: WorkerLike,
  opts: TranscriberOptions,
  timeoutMs: number,
): Promise<TranscriberMode | null> {
  return new Promise<TranscriberMode | null>((resolve) => {
    let settled = false;
    // The worker reports outcomes as `message` posts (`ready` / `error`); a
    // failed model load must fail the handshake at once, not hang the timeout.
    // The `error` EVENT is the separate worker-crash signal.
    const onMessage = (ev: { data?: unknown }): void => {
      const msg = ev.data as { type?: string; mode?: string } | undefined;
      if (!msg) return;
      if (msg.type === 'ready') done(msg.mode === 'moonshine' || msg.mode === 'whisper' ? msg.mode : null);
      else if (msg.type === 'error') done(null);
    };
    const onError = (): void => done(null);
    const done = (m: TranscriberMode | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve(m);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage({
        type: 'init',
        engineUrl: opts.engineUrl,
        moonshineModel: opts.moonshineModel,
        whisperModel: opts.whisperModel,
      });
    } catch {
      done(null);
    }
  });
}

/**
 * The bundled STT worker. Vite recognises this exact `new Worker(new URL(...))`
 * form and bundles stt.worker.ts as an ES worker (vite.config worker.format).
 * Only reached in the browser when a model is configured — never in the node
 * tests, which inject `createWorker` or run the stub.
 */
function defaultWorker(): WorkerLike {
  return new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
