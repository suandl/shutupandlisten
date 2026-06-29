// STT Web Worker — runs Moonshine / Whisper-small on CPU/WASM, off the main
// thread and off the GPU (reserved for the LLM/TTS). Keeping inference here is
// why the main thread stays glitch-free while a segment transcribes.
//
// The engine (a transformers.js-compatible module exposing `pipeline` + `env`)
// and the model are loaded at runtime from URLs the main thread passes in `init`
// — see stt.ts's SUBSTITUTION NOTE. Nothing is fetched from the network unless
// the operator points these at remote URLs; the default is no engine → the main
// adapter never spawns this worker and uses the stub. Everything is guarded: a
// missing/failed engine or model reports a clean handshake outcome rather than
// throwing, so the adapter degrades to the stub instead of wedging.
//
// This file is unavoidably browser-only (it talks to a real engine + Worker
// scope), so it is not exercised by the node test suite; the testable seams
// (handshake, per-segment fallback, stub) live in stt.ts.

// Structural view of the dedicated-worker global — avoids the DOM/WebWorker lib
// clash that referencing `self`'s typed shape would cause under this tsconfig.
const ctx = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
};

interface InitMessage {
  type: 'init';
  engineUrl?: string;
  moonshineModel?: string;
  whisperModel?: string;
}

interface TranscribeMessage {
  type: 'transcribe';
  id: number;
  audio: Float32Array;
  sampleRate: number;
}

/** transformers.js pipeline call surface (only what we use). */
type AsrPipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string } | string>;
type Engine = {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<AsrPipeline>;
  env?: Record<string, unknown>;
};

let asr: AsrPipeline | null = null;

ctx.addEventListener('message', (ev: { data: unknown }) => {
  const msg = ev.data as InitMessage | TranscribeMessage | undefined;
  if (!msg) return;
  if (msg.type === 'init') void handleInit(msg);
  else if (msg.type === 'transcribe') void handleTranscribe(msg);
});

async function handleInit(msg: InitMessage): Promise<void> {
  if (!msg.engineUrl) {
    ctx.postMessage({ type: 'error', reason: 'no engine url' });
    return;
  }
  let engine: Engine;
  try {
    engine = (await import(/* @vite-ignore */ msg.engineUrl)) as Engine;
  } catch {
    ctx.postMessage({ type: 'error', reason: 'engine import failed' });
    return;
  }

  // Keep inference local + on CPU/WASM. Best-effort: an engine without these
  // env knobs just ignores the assignment.
  try {
    if (engine.env) {
      engine.env.allowRemoteModels = false;
      engine.env.allowLocalModels = true;
    }
  } catch {
    /* ignore — non-fatal */
  }

  // Moonshine first (variable-length, proportional compute), Whisper-small as the
  // noisy/disfluent fallback. The first that loads wins.
  const candidates: Array<{ mode: 'moonshine' | 'whisper'; model: string }> = [];
  if (msg.moonshineModel) candidates.push({ mode: 'moonshine', model: msg.moonshineModel });
  if (msg.whisperModel) candidates.push({ mode: 'whisper', model: msg.whisperModel });

  for (const c of candidates) {
    try {
      asr = await engine.pipeline('automatic-speech-recognition', c.model, { device: 'wasm' });
      ctx.postMessage({ type: 'ready', mode: c.mode });
      return;
    } catch {
      // try the next candidate
    }
  }
  ctx.postMessage({ type: 'error', reason: 'no model loaded' });
}

async function handleTranscribe(msg: TranscribeMessage): Promise<void> {
  if (!asr) {
    ctx.postMessage({ type: 'result', id: msg.id, text: '', error: true });
    return;
  }
  try {
    const out = await asr(msg.audio, { sampling_rate: msg.sampleRate });
    const text = typeof out === 'string' ? out : (out.text ?? '');
    ctx.postMessage({ type: 'result', id: msg.id, text: text.trim() });
  } catch {
    ctx.postMessage({ type: 'result', id: msg.id, text: '', error: true });
  }
}
