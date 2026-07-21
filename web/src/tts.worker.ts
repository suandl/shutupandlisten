// TTS Web Worker — runs the small on-device text-to-speech model on CPU/WASM
// (WebGPU where a model supports it), off the main thread. Keeping synthesis here
// is why the main thread stays glitch-free while a reply is voiced. It shares the
// CPU/WASM the STT worker uses, which is fine: STT runs while LISTENING and TTS
// while RESPONDING — they never contend for the same compute at the same time, and
// the GPU stays reserved for the U5 listener.
//
// The engine (a transformers.js-compatible module exposing `pipeline` + `env`) and
// the model are loaded at runtime from URLs the main thread passes in `init` — see
// tts.ts's SUBSTITUTION NOTE. Nothing is fetched cross-origin: the engine URL is
// re-verified same-origin here (defense in depth) and env.allowRemoteModels is
// forced false. A missing/failed engine or model reports a clean handshake outcome
// rather than throwing, so the adapter degrades to the placeholder tone instead of
// wedging.
//
// Browser-only (it talks to a real engine + Worker scope), so it is not exercised
// by the node test suite; the testable seams (handshake, per-call fallback, stub
// tone) live in tts.ts.

import { sanitizeEngineUrl } from './engine-url.ts';

// Structural view of the dedicated-worker global — avoids the DOM/WebWorker lib
// clash that referencing `self`'s typed shape would cause under this tsconfig. The
// optional transfer list lets us hand the PCM buffer back without a copy.
const ctx = globalThis as unknown as {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  location?: { href: string };
};

interface InitMessage {
  type: 'init';
  engineUrl?: string;
  model?: string;
}

interface SynthesizeMessage {
  type: 'synthesize';
  id: number;
  text: string;
}

/** transformers.js text-to-speech pipeline call surface (only what we use). */
type TtsOutput = { audio?: unknown; sampling_rate?: unknown };
// One arg only: the engine closure public/tts-engine.js returns is
// `async (text) => …`, so a declared second parameter would be silently dropped.
type TtsPipeline = (text: string) => Promise<TtsOutput>;
type Engine = {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<TtsPipeline>;
  env?: Record<string, unknown>;
};

let synthesizer: TtsPipeline | null = null;

ctx.addEventListener('message', (ev: { data: unknown }) => {
  const msg = ev.data as InitMessage | SynthesizeMessage | undefined;
  if (!msg) return;
  if (msg.type === 'init') void handleInit(msg);
  else if (msg.type === 'synthesize') void handleSynthesize(msg);
});

async function handleInit(msg: InitMessage): Promise<void> {
  if (!msg.engineUrl) {
    ctx.postMessage({ type: 'error', reason: 'no engine url' });
    return;
  }
  if (!msg.model) {
    ctx.postMessage({ type: 'error', reason: 'no model' });
    return;
  }
  // Defense in depth: the main thread already restricts ?ttsEngine= to a
  // same-origin module, but this worker import()s it and runs it as code, so it
  // never loads a URL it hasn't re-verified against its own origin. (su-0hi #1)
  const engineUrl = sanitizeEngineUrl(msg.engineUrl, ctx.location?.href ?? '');
  if (!engineUrl) {
    ctx.postMessage({ type: 'error', reason: 'engine url rejected (not self-hosted)' });
    return;
  }
  let engine: Engine;
  try {
    engine = (await import(/* @vite-ignore */ engineUrl)) as Engine;
  } catch {
    ctx.postMessage({ type: 'error', reason: 'engine import failed' });
    return;
  }

  // Keep inference local. Best-effort: an engine without these env knobs ignores it.
  try {
    if (engine.env) {
      engine.env.allowRemoteModels = false;
      engine.env.allowLocalModels = true;
    }
  } catch {
    /* ignore — non-fatal */
  }

  // CPU/WASM first (the placeholder VITS voice runs there; the GPU is the U5
  // listener's), then a WebGPU attempt for a future model that supports it. The
  // first that loads wins; its device is the reported mode.
  const candidates: Array<{ mode: 'wasm' | 'webgpu'; opts: Record<string, unknown> }> = [
    { mode: 'wasm', opts: { device: 'wasm' } },
    { mode: 'webgpu', opts: { device: 'webgpu' } },
  ];
  const failures: string[] = [];
  for (const c of candidates) {
    try {
      synthesizer = await engine.pipeline('text-to-speech', msg.model, c.opts);
      ctx.postMessage({ type: 'ready', mode: c.mode });
      return;
    } catch (e) {
      // Keep the throw — the next device may still load — but never DROP it: a
      // swallowed construction error is exactly how su-lou.8's root cause (a
      // fatal preprocessor_config.json probe) hid behind a bare 'no model
      // loaded' for weeks. The serialized causes ride the error reason into the
      // adapter's onDiagnostic line, where the works-check (and a human) read them.
      failures.push(`${c.mode}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  ctx.postMessage({ type: 'error', reason: `no model loaded (${failures.join('; ')})` });
}

async function handleSynthesize(msg: SynthesizeMessage): Promise<void> {
  if (!synthesizer) {
    ctx.postMessage({ type: 'result', id: msg.id, error: true });
    return;
  }
  try {
    const out = await synthesizer(msg.text);
    const pcm = extractAudio(out);
    if (!pcm) {
      ctx.postMessage({ type: 'result', id: msg.id, error: true });
      return;
    }
    // Transfer the PCM buffer rather than copy it — the worker keeps no reference.
    ctx.postMessage({ type: 'result', id: msg.id, audio: pcm.audio, sampleRate: pcm.sampleRate }, [pcm.audio.buffer]);
  } catch {
    ctx.postMessage({ type: 'result', id: msg.id, error: true });
  }
}

/**
 * Pull mono PCM + its sample rate out of a transformers.js text-to-speech result.
 * VITS/mms-tts returns `{ audio: Float32Array, sampling_rate: number }`. Defensive
 * against a plain-array `audio` and a missing/zero rate — either yields null, which
 * the caller reports as an error so the adapter plays the placeholder tone.
 */
function extractAudio(out: TtsOutput): { audio: Float32Array; sampleRate: number } | null {
  const rate = typeof out?.sampling_rate === 'number' ? out.sampling_rate : 0;
  let audio: Float32Array | null = null;
  if (out?.audio instanceof Float32Array) audio = out.audio;
  else if (Array.isArray(out?.audio)) audio = Float32Array.from(out.audio as number[]);
  if (!audio || audio.length === 0 || rate <= 0) return null;
  return { audio, sampleRate: rate };
}
