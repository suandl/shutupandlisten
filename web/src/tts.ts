// On-device TTS adapter — U6. Runs a SMALL text-to-speech model in the browser
// (CPU/WASM, WebGPU where a model supports it) to SPEAK the listener's gated reply,
// closing the loop from "it responds on screen" to "it responds aloud". Mirrors
// stt.ts / listener.ts EXACTLY: it ATTEMPTS a real on-device model and, when that is
// unavailable, degrades to a transparent, clearly-labelled STUB so the harness and
// its tests never block on a model download.
//
// One deliberate difference from the listener stub. The listener's stub is labelled
// TEXT ("⟨listener: … not loaded⟩") — legible without a model. TTS has no text to
// fall back to, and a silent loop is not tangible, so the stub synthesizes a short,
// gentle PLACEHOLDER TONE (below): the audible analog of a labelled stub, so the
// warmed loop still "talks back" in CI / an un-provisioned deploy. It is plainly a
// placeholder (a tone, not speech), the result carries `mode: 'stub'`, and the UI
// marks it — exactly the substitute-and-note posture. Real speech replaces it the
// moment a model is provisioned.
//
// SUBSTITUTION NOTE (per "substitute and note", mirroring smart-turn / STT / the U5
// listener): a real neural vocoder + WebGPU/WASM decode is heavy and unvalidatable
// in CI (no headless audio, no bundled weights). Rather than hand-roll one, the
// worker (tts.worker.ts) loads a transformers.js-compatible engine module and the
// model from configurable, same-origin runtime URLs; absent that config the adapter
// is the stub tone. The concrete model is the substitute-and-note placeholder
// Xenova/mms-tts-eng (VITS, no speaker-embed, CPU/WASM) — see tts-config.ts /
// provision-tts.mjs — swapped for a finalised pick behind the same-origin
// `?ttsEngine=` / `?ttsModel=` overrides without a code edit, exactly as STT's
// Moonshine export and the listener's instruct model were.

/** Which source produced a result. A worker timeout/error/empty output degrades to 'stub'. */
export type SpeakerMode = 'webgpu' | 'wasm' | 'stub';

export interface SpeechResult {
  /** Mono PCM samples of the synthesized speech — a placeholder tone in stub mode. */
  audio: Float32Array;
  /** Sample rate of `audio` (Hz). */
  sampleRate: number;
  /** The source of THIS result (a per-call failure degrades to 'stub'). */
  mode: SpeakerMode;
  /** The text that was synthesized (echoed back for the UI / loop metrics). */
  text: string;
}

/** Minimal structural Worker shape so the adapter is unit-testable with a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
}

export interface SpeakerOptions {
  /** transformers.js-compatible engine module URL — same-origin only (see engine-url.ts). */
  engineUrl?: string;
  /** Text-to-speech model id / local path — the on-device voice. */
  model?: string;
  /** Inject a worker (tests / custom hosting). Defaults to the bundled tts.worker. */
  createWorker?: () => WorkerLike;
  /** Per-synthesis ms before degrading to the stub tone (model wedged / slow). */
  timeoutMs?: number;
  /** Ms to wait for the model to LOAD before failing closed to the stub. Model
   *  download + compile is far slower than a per-call synthesis, so it gets its
   *  own, longer budget. */
  initTimeoutMs?: number;
}

export interface Speaker {
  readonly mode: SpeakerMode;
  /** Synthesize speech for `text`. NEVER throws — degrades to the placeholder tone. */
  synthesize(text: string): Promise<SpeechResult>;
  /** Release the worker, if any. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_INIT_TIMEOUT_MS = 120000;

// ── Default self-hosted TTS config — the U6 wiring ──
//
// Points the adapter at an engine + weights served from the app's OWN origin, so
// the harness speaks out-of-the-box once assets are provisioned (`npm run
// provision:tts`, run at build/deploy). No third-party origin is fetched for engine
// or model at runtime and no synthesized audio leaves the page — the su-0hi #1 /
// no-egress posture, identical to STT and the listener. When the assets are ABSENT
// (fresh clone, CI, un-provisioned deploy) the worker's engine import 404s, the
// handshake fails closed, and the adapter degrades to the placeholder tone. See
// web/public/tts-engine.js, web/scripts/provision-tts.mjs, README.
//
// The model id is the substitute-and-note placeholder (see the SUBSTITUTION NOTE
// above): Xenova/mms-tts-eng is a small VITS voice with a transformers.js ONNX
// export and no speaker-embedding step, so a single `synthesize(text)` call runs it
// on CPU/WASM. Swap it via `?ttsModel=` or TTS_MODEL at provision time — no code edit.
export const DEFAULT_TTS_ENGINE_URL = '/tts-engine.js';
export const DEFAULT_TTS_MODEL = 'Xenova/mms-tts-eng';

/** Sample rate of the placeholder tone (the real model reports its own rate). */
export const STUB_SAMPLE_RATE = 16000;

/**
 * A short, gentle placeholder tone standing in for synthesized speech when no TTS
 * model is provisioned — the audible analog of the listener's labelled text stub,
 * so the warmed loop still "talks back" (tangibility) in CI / un-provisioned
 * deploys. Pure + deterministic (no WebAudio) so it is unit-testable; plainly a
 * placeholder, and the UI marks the result `stub`. Length scales gently with the
 * reply so a longer reply sounds a little longer, capped so it never drones. Empty
 * text yields empty audio (nothing to say → nothing to play).
 */
export function speakerStubAudio(text: string): { audio: Float32Array; sampleRate: number } {
  const chars = text.trim().length;
  if (chars === 0) return { audio: new Float32Array(0), sampleRate: STUB_SAMPLE_RATE };
  const durationMs = Math.min(160 + chars * 14, 1200);
  const n = Math.round((STUB_SAMPLE_RATE * durationMs) / 1000);
  const audio = new Float32Array(n);
  const freq = 220; // a low, unobtrusive A3 — a soft "spoken" cue, not a beep
  const fade = Math.min(Math.round(STUB_SAMPLE_RATE * 0.02), Math.floor(n / 2)); // 20ms ramps
  for (let i = 0; i < n; i++) {
    let gain = 0.12;
    if (i < fade) gain *= i / fade;
    else if (i >= n - fade) gain *= (n - i) / fade;
    audio[i] = gain * Math.sin((2 * Math.PI * freq * i) / STUB_SAMPLE_RATE);
  }
  return { audio, sampleRate: STUB_SAMPLE_RATE };
}

function stubResult(text: string): SpeechResult {
  const { audio, sampleRate } = speakerStubAudio(text);
  return { audio, sampleRate, mode: 'stub', text };
}

function makeStub(): Speaker {
  return {
    mode: 'stub',
    async synthesize(text: string): Promise<SpeechResult> {
      return stubResult(text);
    },
    close() {
      /* nothing to release */
    },
  };
}

/**
 * Create a speaker. With a model configured (or an injected worker) it spins up the
 * TTS worker and, only if the worker reports it loaded a model, returns a
 * worker-backed speaker; on any failure — no model, worker spawn error, init
 * timeout, bad handshake — it returns the stub. Resolves without blocking on the
 * (slow) model load beyond initTimeoutMs; the UI reads `.mode` to show what is live.
 */
export async function createSpeaker(opts: SpeakerOptions = {}): Promise<Speaker> {
  const hasModel = Boolean(opts.model);
  if (!opts.createWorker && !hasModel) return makeStub();

  let worker: WorkerLike;
  try {
    worker = opts.createWorker ? opts.createWorker() : defaultWorker();
  } catch {
    return makeStub();
  }

  const initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const mode = await initWorker(worker, opts, initTimeoutMs);
  if (mode === null) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    return makeStub();
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 0;
  // Each pending synthesis stores its timer-clearing settler plus a per-call
  // fallback — the placeholder tone for THIS text — so a worker error or an empty
  // waveform degrades to an audible cue instead of silence.
  const pending = new Map<number, { settle: (r: SpeechResult) => void; fallback: () => SpeechResult }>();
  const onMessage = (ev: { data?: unknown }): void => {
    const msg = ev.data as
      | { type?: string; id?: number; audio?: unknown; sampleRate?: number; error?: boolean }
      | undefined;
    if (!msg || msg.type !== 'result' || typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) {
      entry.settle(entry.fallback());
      return;
    }
    // A missing/empty waveform is not useful audio; surface the placeholder tone.
    const audio = msg.audio instanceof Float32Array ? msg.audio : null;
    const sampleRate = typeof msg.sampleRate === 'number' && msg.sampleRate > 0 ? msg.sampleRate : 0;
    if (audio && audio.length > 0 && sampleRate > 0) {
      entry.settle({ audio, sampleRate, mode, text: entry.fallback().text });
    } else {
      entry.settle(entry.fallback());
    }
  };
  worker.addEventListener('message', onMessage);

  return {
    mode,
    synthesize(text: string): Promise<SpeechResult> {
      return new Promise<SpeechResult>((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve(stubResult(text));
        }, timeoutMs);
        pending.set(id, {
          settle: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          fallback: () => stubResult(text),
        });
        try {
          worker.postMessage({ type: 'synthesize', id, text });
        } catch {
          clearTimeout(timer);
          if (pending.delete(id)) resolve(stubResult(text));
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
 * device mode) or fails closed on `error`, a malformed reply, or timeout.
 */
function initWorker(
  worker: WorkerLike,
  opts: SpeakerOptions,
  timeoutMs: number,
): Promise<SpeakerMode | null> {
  return new Promise<SpeakerMode | null>((resolve) => {
    let settled = false;
    const onMessage = (ev: { data?: unknown }): void => {
      const msg = ev.data as { type?: string; mode?: string } | undefined;
      if (!msg) return;
      if (msg.type === 'ready') done(msg.mode === 'webgpu' || msg.mode === 'wasm' ? msg.mode : null);
      else if (msg.type === 'error') done(null);
    };
    const onError = (): void => done(null);
    const done = (m: SpeakerMode | null): void => {
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
      worker.postMessage({ type: 'init', engineUrl: opts.engineUrl, model: opts.model });
    } catch {
      done(null);
    }
  });
}

/**
 * The bundled TTS worker. Vite recognises this exact `new Worker(new URL(...))`
 * form and bundles tts.worker.ts as an ES worker (vite.config worker.format). Only
 * reached in the browser when a model is configured — never in the node tests,
 * which inject `createWorker` or run the stub.
 */
function defaultWorker(): WorkerLike {
  return new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
