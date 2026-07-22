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
// A rung of the device ladder that loses — because the adapter cannot run its
// weights, or because the engine threw building the session — is never dropped on
// the floor: its reason rides the handshake back to listener.ts, which reports it
// (su-lou.9). A degrade that cannot say why is a degrade nobody can fix.
//
// Browser-only (it talks to a real engine + Worker scope), so it is not exercised
// by the node test suite; the testable seams (handshake, per-call fallback, stub)
// live in listener.ts, and the ladder itself in listener-backends.ts.

import { sanitizeEngineUrl } from './engine-url.ts';
import { LISTENER_CANDIDATES, listenerCandidateLabel as label } from './listener-backends.ts';

// Structural view of the dedicated-worker global — avoids the DOM/WebWorker lib
// clash that referencing `self`'s typed shape would cause under this tsconfig.
const ctx = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  location?: { href: string };
  navigator?: {
    gpu?: {
      requestAdapter(options?: { powerPreference?: string }): Promise<{ features: { has(f: string): boolean } } | null>;
    };
  };
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

/** transformers.js text-generation pipeline call surface (only what we use). The
 *  pipeline is a callable OBJECT — `tokenizer` is the handle a streamer needs. */
type TextGenOutput = Array<{ generated_text?: unknown }> | { generated_text?: unknown };
type TextGenPipeline = ((input: ChatMessage[], opts?: Record<string, unknown>) => Promise<TextGenOutput>) & {
  tokenizer?: unknown;
};
/** transformers.js TextStreamer: decodes tokens as they are produced and hands
 *  each newly-decoded piece to `callback_function`. Optional — see makeStreamer. */
type StreamerCtor = new (tokenizer: unknown, opts: Record<string, unknown>) => unknown;
type Engine = {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<TextGenPipeline>;
  env?: Record<string, unknown>;
  TextStreamer?: StreamerCtor;
};

let generator: TextGenPipeline | null = null;
// Kept past init so handleGenerate can reach the engine's TextStreamer, if it has one.
let engineRef: Engine | null = null;

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
  engineRef = engine;

  // Keep inference local. Best-effort: an engine without these env knobs ignores it.
  try {
    if (engine.env) {
      engine.env.allowRemoteModels = false;
      engine.env.allowLocalModels = true;
    }
  } catch {
    /* ignore — non-fatal */
  }

  // Walk the device/weight ladder (listener-backends.ts owns its shape and the
  // measurements behind it): GPU first — the point of U5 — then the WASM floor for a
  // machine with no usable GPU rung. The first rung that loads wins and its device is
  // the reported mode. Every rung that LOSES records why, so a listener that ends up
  // on the slow rung — or on no rung at all — can say what happened.
  const failures: string[] = [];
  for (const c of LISTENER_CANDIDATES) {
    // A rung whose weights need a WebGPU feature this adapter lacks must be SKIPPED,
    // not attempted: on an adapter without `shader-f16` the q4f16 session builds and
    // generates without ever throwing — it just emits invalid f16 compute pipelines
    // and returns garbage tokens ("!!!!!!!!!!!!" in the su-lou.9 repro). A rung that
    // fails LOUDLY falls through to the next one; a rung that "succeeds" wrongly
    // ends the ladder and ships nonsense as the companion's reply. transformers.js
    // gates plain fp16 on this feature but not q4f16, so the check lives here.
    if (c.requiresFeature) {
      const supported = await hasWebGpuFeature(c.requiresFeature);
      if (!supported) {
        failures.push(`${label(c)}: skipped — no WebGPU adapter with '${c.requiresFeature}'`);
        continue;
      }
    }
    try {
      generator = await engine.pipeline('text-generation', msg.model, { device: c.device, dtype: c.dtype });
      // `notes` carries the rungs this load skipped past. A successful load is not
      // automatically the FAST one — webgpu/q4f16 and wasm/q4 differ by ~10x — so
      // the adapter surfaces which rung is really live (su-lou.9).
      ctx.postMessage({ type: 'ready', mode: c.device, dtype: c.dtype, notes: failures });
      return;
    } catch (e) {
      // Keep the throw — the next device may still load — but never DROP it: a
      // swallowed construction error is exactly how su-lou.9's real cause stayed
      // invisible through an operator feel-test, leaving nothing to debug but
      // "LLM not loaded". The serialized causes ride the error reason into the
      // adapter's onDiagnostic line, where the works-check (and a human) read them.
      failures.push(`${label(c)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  ctx.postMessage({ type: 'error', reason: `no model loaded (${failures.join('; ')})` });
}

/**
 * Does this worker's WebGPU adapter expose `feature`? Answers false for "no WebGPU
 * at all", "no adapter", and "requestAdapter threw" alike — every one of those means
 * the rung cannot run here, and the caller only needs the one bit.
 *
 * `navigator.gpu` IS available in a dedicated worker, so the ladder can check its own
 * precondition without help from the main thread. Memoized: adapter capabilities do
 * not change within a worker's life, and requestAdapter is not free.
 */
let webGpuFeatures: Promise<{ has(f: string): boolean } | null> | null = null;
async function hasWebGpuFeature(feature: string): Promise<boolean> {
  webGpuFeatures ??= (async () => {
    const gpu = ctx.navigator?.gpu;
    if (!gpu) return null;
    try {
      // Request with the same options the real session will use: transformers.js
      // 3.8.1 pins ORT's env.webgpu.powerPreference to 'high-performance', and ORT
      // passes that to its own requestAdapter call. On multi-adapter hardware a bare
      // requestAdapter() can return a DIFFERENT adapter (e.g. the integrated one)
      // than ORT gets, and the feature check would guard the wrong device. Adapter
      // identity still isn't spec-guaranteed for identical options, but this is the
      // best available proxy: ORT's adapter instance is created inside the engine
      // and unreachable from here.
      return (await gpu.requestAdapter({ powerPreference: 'high-performance' }))?.features ?? null;
    } catch {
      return null;
    }
  })();
  try {
    return (await webGpuFeatures)?.has(feature) ?? false;
  } catch {
    return false;
  }
}

async function handleGenerate(msg: GenerateMessage): Promise<void> {
  if (!generator) {
    ctx.postMessage({ type: 'result', id: msg.id, text: '', error: true });
    return;
  }
  try {
    const streamer = makeStreamer(msg.id);
    const out = await generator(msg.messages, {
      max_new_tokens: msg.maxNewTokens ?? 64,
      do_sample: false, // greedy → deterministic, restrained; the prompt carries the register
      return_full_text: false,
      ...(streamer ? { streamer } : {}),
    });
    ctx.postMessage({ type: 'result', id: msg.id, text: extractReply(out) });
  } catch {
    ctx.postMessage({ type: 'result', id: msg.id, text: '', error: true });
  }
}

/**
 * A streamer that posts the reply-so-far as it decodes, or null when this engine
 * cannot stream.
 *
 * Why this exists (su-lou.11): the warmed loop was fully serial — await the whole
 * generation, then the whole synthesis, then play — so perceived latency was the
 * SUM of two slow on-device stages, and "the delay until actually spoken is huge"
 * was the operator's verdict. With partials, the main thread can synthesize and
 * speak the first finished sentence while the rest is still decoding.
 *
 * Strictly BEST-EFFORT, and deliberately so. An engine build without TextStreamer,
 * a pipeline without a reachable tokenizer, or a constructor that throws all take
 * the same exit: return null, and generation runs exactly as it did before with
 * the final result as the only output. The failure mode is "no speedup", never a
 * broken reply — this path cannot be exercised in CI (no GPU, no weights), so it
 * must not be able to take the listener down with it.
 *
 * The ACCUMULATED text is posted, not the delta: idempotent for the reader, so a
 * dropped or doubled message cannot corrupt what gets spoken.
 */
function makeStreamer(id: number): unknown {
  const Streamer = engineRef?.TextStreamer;
  const tokenizer = generator?.tokenizer;
  if (!Streamer || !tokenizer) return null;
  let acc = '';
  try {
    return new Streamer(tokenizer, {
      skip_prompt: true, // the prompt is not the reply
      skip_special_tokens: true,
      callback_function: (delta: unknown): void => {
        if (typeof delta !== 'string' || !delta) return;
        acc += delta;
        ctx.postMessage({ type: 'partial', id, text: acc });
      },
    });
  } catch {
    return null;
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
