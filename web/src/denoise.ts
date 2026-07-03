// In-browser noise-suppression adapter — background-noise robustness increment 2.
//
// An on-device denoise stage that sits AHEAD of the Silero VAD. The live mic is
// routed mic → denoise AudioWorkletNode → MediaStreamDestination, and the
// resulting DENOISED MediaStream is what the VAD captures. Cleaner audio → the
// VAD stops triggering on background music → the silence gap reappears → turns
// end. That is the coffee-shop repro: light music no longer fills the silence
// gap or reads as false speech. On-device / no-egress: the engine module and its
// weights are served SAME-ORIGIN (`npm run provision:denoise`); nothing is
// fetched cross-origin and no microphone audio leaves the page.
//
// Mirrors stt.ts's posture exactly. It ATTEMPTS a real same-origin engine and,
// when that is unavailable — no engine configured, `?denoise=off`, an
// un-provisioned deploy (the worklet/wasm 404), or a mic-permission / Web-Audio
// failure — it degrades to a transparent PASSTHROUGH. Passthrough returns NO
// stream: the caller lets the VAD capture the mic itself, byte-identical to the
// pre-denoise path, so the tested turn-detection state machine is provably
// unchanged whenever denoise is off. `createDenoiser` NEVER throws; the UI reads
// `.mode` to show what is live.
//
// SUBSTITUTION NOTE (mirroring stt.ts): the concrete real-time worklet is the
// adopted RNNoise engine (public/denoise-engine.js + the assets provisioned by
// scripts/provision-denoise.mjs). Its audio-graph behaviour is validated in a
// real browser during the operator feel-test — headless CI has no Web Audio, so
// it cannot exercise an AudioWorklet — exactly as the specific STT model export
// is validated there. The CI-tested surface is THIS adapter's passthrough /
// fallback contract (denoise.test.ts) plus the config resolver
// (denoise-config.ts / denoise-config.test.ts).

/** Live denoise mode surfaced in the Stage. 'passthrough' = the no-op fallback. */
export type DenoiseMode = 'passthrough' | 'rnnoise' | 'dtln';

// ── Minimal structural Web-Audio shapes so the adapter is unit-testable with
//    fakes (node has no Web Audio), mirroring stt.ts's `WorkerLike`. The real
//    DOM types are structurally compatible; vad.ts casts at the browser edge. ──

export interface AudioNodeLike {
  /** Web Audio's `connect` returns the destination node, so calls chain. */
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect?(): void;
}

export interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>;
}

export interface MediaStreamDestinationLike extends AudioNodeLike {
  readonly stream: MediaStreamLike;
}

export interface AudioContextLike {
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike;
  createMediaStreamDestination(): MediaStreamDestinationLike;
  close(): Promise<void> | void;
}

/**
 * The contract a denoise engine module (public/denoise-engine.js, or a
 * `?denoiseEngine=` override) must satisfy. Keeping the audio-graph specifics
 * behind this interface is what makes the stage engine-agnostic: RNNoise today,
 * a DTLN/ONNX module tomorrow, selected purely by which same-origin module URL
 * the adapter loads.
 */
export interface DenoiseEngineModule {
  /** Live mode label for the Stage (e.g. 'rnnoise'). Never 'passthrough'. */
  readonly mode: DenoiseMode;
  /**
   * AudioContext sample rate the engine requires, if any. RNNoise assumes 48kHz;
   * the adapter creates the context at this rate so the caller stays
   * engine-agnostic. Omit to accept the hardware default.
   */
  readonly sampleRate?: number;
  /** Build the denoise node in `ctx`, wired to provisioned same-origin assets. */
  createNode(ctx: AudioContextLike): Promise<AudioNodeLike>;
}

export interface DenoiserOptions {
  /** Same-origin engine module URL (default /denoise-engine.js). Blank → passthrough. */
  engineUrl?: string;
  /** Force passthrough — the `?denoise=off` kill switch. */
  disabled?: boolean;
  /** ms before engine load falls back to passthrough (engine wedged / slow). */
  timeoutMs?: number;
  // ── injectable seams for headless unit tests (node has no Web Audio) ──
  /** Acquire the mic. Default: navigator.mediaDevices.getUserMedia. */
  getUserMedia?: (constraints: unknown) => Promise<MediaStreamLike>;
  /** Create the AudioContext hosting the denoise node. Default: new AudioContext. */
  createAudioContext?: (sampleRate?: number) => AudioContextLike;
  /** Load the engine module. Default: dynamic import(engineUrl). */
  loadEngine?: (engineUrl: string) => Promise<DenoiseEngineModule | null>;
}

export interface Denoiser {
  readonly mode: DenoiseMode;
  /**
   * The MediaStream to feed the VAD, or `undefined` for passthrough (the caller
   * lets the VAD capture the mic itself — unchanged). NEVER throws.
   */
  readonly stream: MediaStreamLike | undefined;
  /** Release the mic + AudioContext, if any. Safe to call more than once. */
  close(): void;
}

// Default self-hosted engine — the committed same-origin wrapper. An override
// (`?denoiseEngine=`) must ALSO be same-origin (it runs as code on mic audio);
// the guard lives in denoise-config.ts, reusing engine-url.ts. Absent assets
// (fresh clone, CI, un-provisioned deploy) → the wrapper's import 404s → the
// adapter degrades to passthrough. See web/public/denoise-engine.js, README.
export const DEFAULT_DENOISE_ENGINE_URL = '/denoise-engine.js';

const DEFAULT_TIMEOUT_MS = 15000;

function makePassthrough(): Denoiser {
  return {
    mode: 'passthrough',
    stream: undefined,
    close() {
      /* nothing acquired */
    },
  };
}

/**
 * Create the denoise stage. With an engine configured (and loadable) it acquires
 * the mic, builds mic → denoise → destination, and returns a Denoiser whose
 * `stream` is the denoised output. On ANY failure — disabled, no engine, load
 * error / timeout, a malformed engine, mic denied, a Web-Audio error — it
 * returns passthrough (no stream). NEVER throws: the harness must not be blocked
 * by a missing or wedged denoise engine.
 */
export async function createDenoiser(opts: DenoiserOptions = {}): Promise<Denoiser> {
  if (opts.disabled || !opts.engineUrl) return makePassthrough();

  const load = opts.loadEngine ?? defaultLoadEngine;
  let engine: DenoiseEngineModule | null;
  try {
    engine = await withTimeout(load(opts.engineUrl), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch {
    return makePassthrough();
  }
  if (!isUsableEngine(engine)) return makePassthrough();

  const getUserMedia = opts.getUserMedia ?? defaultGetUserMedia;
  const createAudioContext = opts.createAudioContext ?? defaultCreateAudioContext;

  let mic: MediaStreamLike | undefined;
  let ctx: AudioContextLike | undefined;
  try {
    mic = await getUserMedia({ audio: true });
    ctx = createAudioContext(engine.sampleRate);
    const node = await engine.createNode(ctx);
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(mic).connect(node).connect(dest);
    const micStream = mic;
    const audioCtx = ctx;
    return {
      mode: engine.mode,
      stream: dest.stream,
      close() {
        stopTracks(micStream);
        void closeQuietly(audioCtx);
      },
    };
  } catch {
    // Best-effort teardown of anything we acquired, then degrade to passthrough
    // so start() still succeeds with the raw mic path.
    stopTracks(mic);
    void closeQuietly(ctx);
    return makePassthrough();
  }
}

/** A usable engine has a real `createNode` and a non-passthrough string mode. */
function isUsableEngine(e: DenoiseEngineModule | null): e is DenoiseEngineModule {
  return (
    !!e &&
    typeof e.createNode === 'function' &&
    typeof e.mode === 'string' &&
    e.mode !== 'passthrough'
  );
}

function stopTracks(stream: MediaStreamLike | undefined): void {
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
}

async function closeQuietly(ctx: AudioContextLike | undefined): Promise<void> {
  try {
    await ctx?.close();
  } catch {
    /* ignore */
  }
}

/** Reject if `p` does not settle within `ms` — a slow engine must not hang start(). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('denoise engine load timeout')), ms);
    p.then(
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

/**
 * Dynamic-import the same-origin engine module. Vite leaves the runtime URL
 * alone (`@vite-ignore`); the module is served from public/ (self-hosted), the
 * same shape stt.worker.ts uses. Returns null for a module that does not satisfy
 * the engine contract so the caller degrades to passthrough.
 */
async function defaultLoadEngine(engineUrl: string): Promise<DenoiseEngineModule | null> {
  const mod = (await import(/* @vite-ignore */ engineUrl)) as Partial<DenoiseEngineModule> | null;
  if (!mod || typeof mod.createNode !== 'function' || typeof mod.mode !== 'string') return null;
  return mod as DenoiseEngineModule;
}

function defaultGetUserMedia(constraints: unknown): Promise<MediaStreamLike> {
  return navigator.mediaDevices.getUserMedia(
    constraints as MediaStreamConstraints,
  ) as unknown as Promise<MediaStreamLike>;
}

function defaultCreateAudioContext(sampleRate?: number): AudioContextLike {
  const ctx = sampleRate ? new AudioContext({ sampleRate }) : new AudioContext();
  return ctx as unknown as AudioContextLike;
}
