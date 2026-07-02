// Listener Web Worker — runs the small on-device instruct model on WebGPU (WASM
// fallback), off the main thread AND off the CPU/WASM the STT worker uses. Keeping
// generation here is why the main thread stays glitch-free while a reply decodes,
// and why the two on-device models (STT on CPU/WASM, listener on GPU) stay off
// each other's compute — the bead's constraint.
//
// The engine (a transformers.js-compatible module exposing `pipeline` + `env`) and
// the model are loaded at runtime from URLs the main thread passes in `init` — see
// listener.ts's SUBSTITUTION NOTE. Nothing is fetched cross-origin: the engine URL
// is re-verified same-origin here (defense in depth) and env.allowRemoteModels is
// forced false. A missing/failed engine or model reports a clean handshake outcome
// rather than throwing, so the adapter degrades to the stub instead of wedging.
//
// Browser-only (it talks to a real engine + Worker scope), so it is not exercised
// by the node test suite; the testable seams (handshake, per-call fallback, stub)
// live in listener.ts.

import { sanitizeEngineUrl } from './engine-url.ts';

// Structural view of the dedicated-worker global — avoids the DOM/WebWorker lib
// clash that referencing `self`'s typed shape would cause under this tsconfig.
const ctx = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  location?: { href: string };
};

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface InitMessage {
  type: 'init';
  engineUrl?: string;
  model?: string;
}

interface GenerateMessage {
  type: 'generate';
  id: number;
  messages: ChatMessage[];
  maxNewTokens?: number;
}

/** transformers.js text-generation pipeline call surface (only what we use). */
type TextGenOutput = Array<{ generated_text?: unknown }> | { generated_text?: unknown };
type TextGenPipeline = (input: ChatMessage[], opts?: Record<string, unknown>) => Promise<TextGenOutput>;
type Engine = {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<TextGenPipeline>;
  env?: Record<string, unknown>;
};

let generator: TextGenPipeline | null = null;

ctx.addEventListener('message', (ev: { data: unknown }) => {
  const msg = ev.data as InitMessage | GenerateMessage | undefined;
  if (!msg) return;
  if (msg.type === 'init') void handleInit(msg);
  else if (msg.type === 'generate') void handleGenerate(msg);
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
  // Defense in depth: the main thread already restricts ?llmEngine= to a
  // same-origin module, but this worker generates on user speech-derived text, so
  // it never import()s a URL it hasn't re-verified against its own origin. (su-0hi #1)
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

  // GPU first (the point of U5), then a WASM fallback for a machine with no
  // WebGPU adapter. The first that loads wins; its device is the reported mode.
  const candidates: Array<{ mode: 'webgpu' | 'wasm'; opts: Record<string, unknown> }> = [
    { mode: 'webgpu', opts: { device: 'webgpu' } },
    { mode: 'wasm', opts: { device: 'wasm', dtype: 'q4' } },
  ];
  for (const c of candidates) {
    try {
      generator = await engine.pipeline('text-generation', msg.model, c.opts);
      ctx.postMessage({ type: 'ready', mode: c.mode });
      return;
    } catch {
      // try the next device
    }
  }
  ctx.postMessage({ type: 'error', reason: 'no model loaded' });
}

async function handleGenerate(msg: GenerateMessage): Promise<void> {
  if (!generator) {
    ctx.postMessage({ type: 'result', id: msg.id, text: '', error: true });
    return;
  }
  try {
    const out = await generator(msg.messages, {
      max_new_tokens: msg.maxNewTokens ?? 64,
      do_sample: false, // greedy → deterministic, restrained; the prompt carries the register
      return_full_text: false,
    });
    ctx.postMessage({ type: 'result', id: msg.id, text: extractReply(out) });
  } catch {
    ctx.postMessage({ type: 'result', id: msg.id, text: '', error: true });
  }
}

/**
 * Pull the assistant's reply out of a transformers.js text-generation result. For
 * a chat (messages) input the engine returns `generated_text` as the full message
 * array with the new assistant turn appended — take that turn's content. Older /
 * string-mode engines return a plain string. Defensive against both.
 */
function extractReply(out: TextGenOutput): string {
  const first = Array.isArray(out) ? out[0] : out;
  const gen = first?.generated_text;
  if (Array.isArray(gen)) {
    const last = gen[gen.length - 1] as { content?: unknown } | undefined;
    return typeof last?.content === 'string' ? last.content.trim() : '';
  }
  return typeof gen === 'string' ? gen.trim() : '';
}
