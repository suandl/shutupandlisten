// On-device listener LLM adapter — U5. Runs a SMALL instruct model in the browser
// on WebGPU (WASM fallback) to produce the substantive tiers of the response
// hierarchy (reflection / brief question); silence and acknowledgment never reach
// here — the gate answers those from rules (see response-hierarchy.ts).
//
// Mirrors stt.ts EXACTLY, one deliberate difference: the STT worker runs on
// CPU/WASM and this one runs on the GPU — the bead's "off the CPU/WASM the STT
// uses". Like STT (and smart-turn), it ATTEMPTS a real on-device model and, when
// that is unavailable, degrades to a transparent, clearly-labelled STUB so the
// harness and its tests never block on a model download. The transcript alignment
// and the gate that feed it are fully tested regardless of which mode is live;
// only the *wording* of a reflection/question depends on the model, validated on
// real audio during the operator feel-test.
//
// SUBSTITUTION NOTE (per "substitute and note", mirroring smart-turn / STT): the
// small instruct model + WebGPU decode are heavy and unvalidatable in CI (no
// headless GPU, no bundled weights). Rather than hand-roll a decoder, the worker
// (listener.worker.ts) loads a transformers.js-compatible engine module and the
// model from configurable, same-origin runtime URLs; absent that config the
// adapter is the stub. The validation plan names WebLLM (MLC) as the browser
// runtime and U2 (docs/findings/on-device-text-quality.md) lists the candidate
// class (Llama-3.2-3B / Qwen2.5-3B / Phi-3.5-mini / Gemma-2-2B at q4f16, with
// Llama-3.2-1B as the VRAM drop-target) but finalises none — the score tables are
// pending real GPU. So the concrete engine (transformers.js ONNX vs a WebLLM/MLC
// wrapper) and model id are the FIRST task of the U5 tuning pass, swapped behind
// the same-origin `?llmEngine=` / `?llmModel=` overrides without a code edit —
// exactly as STT's Moonshine export was for U4.

import type { ListenerRequest, Tier } from './response-hierarchy.ts';

export type { ListenerRequest } from './response-hierarchy.ts';

/** Which source produced a result. A worker timeout/error degrades to 'stub'. */
export type ListenerMode = 'webgpu' | 'wasm' | 'stub';

export interface ListenerResult {
  /** The reply text (a labelled placeholder in stub mode). */
  text: string;
  /** The source of THIS result. */
  mode: ListenerMode;
  /** The hierarchy tier this reply answers (echoed back for the UI). */
  tier: Tier;
}

/** Minimal structural Worker shape so the adapter is unit-testable with a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
}

export interface ListenerOptions {
  /** transformers.js-compatible engine module URL — same-origin only (see engine-url.ts). */
  engineUrl?: string;
  /** Small instruct model id / local path — the on-device listener LLM. */
  model?: string;
  /** Inject a worker (tests / custom hosting). Defaults to the bundled listener.worker. */
  createWorker?: () => WorkerLike;
  /** Per-generation ms before degrading to a stub reply (model wedged / slow). */
  timeoutMs?: number;
  /** Ms to wait for the model to LOAD before failing closed to the stub. Model
   *  download + compile is far slower than a per-call generation, so it gets its
   *  own, longer budget. */
  initTimeoutMs?: number;
}

export interface Listener {
  readonly mode: ListenerMode;
  /** Produce a reflection/question for a substantive turn. NEVER throws — degrades to a labelled stub. */
  respond(req: ListenerRequest): Promise<ListenerResult>;
  /** Release the worker, if any. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_INIT_TIMEOUT_MS = 120000;

// ── Default self-hosted listener config — the U5 wiring ──
//
// Points the adapter at an engine + weights served from the app's OWN origin, so
// the harness responds out-of-the-box once assets are provisioned (`npm run
// provision:llm`, run at build/deploy). No third-party origin is fetched for
// engine or model at runtime and no transcript leaves the page — the su-0hi #1 /
// no-egress posture, identical to STT. When the assets are ABSENT (fresh clone,
// CI, un-provisioned deploy) the worker's engine import 404s, the handshake fails
// closed, and the adapter degrades to the labelled stub. See web/public/llm-engine.js,
// web/scripts/provision-llm.mjs, README.
//
// The model id is the substitute-and-note placeholder (see the SUBSTITUTION NOTE
// above): Llama-3.2-1B-Instruct is U2's VRAM drop-target and has a transformers.js
// ONNX export; provisioning fetches its quantized weights under the shared
// same-origin /models/ tree. Swap it for U2's finalised pick via `?llmModel=` or
// STT_*-style env at provision time — no code edit.
export const DEFAULT_LLM_ENGINE_URL = '/llm-engine.js';
export const DEFAULT_LLM_MODEL = 'onnx-community/Llama-3.2-1B-Instruct';

/** A labelled placeholder so the harness stays legible without a model — names the tier the gate chose. */
export function listenerStubText(tier: Tier): string {
  return `⟨listener: ${tier} — LLM not loaded⟩`;
}

function stubResult(tier: Tier): ListenerResult {
  return { text: listenerStubText(tier), mode: 'stub', tier };
}

function makeStub(): Listener {
  return {
    mode: 'stub',
    async respond(req: ListenerRequest): Promise<ListenerResult> {
      return stubResult(req.tier);
    },
    close() {
      /* nothing to release */
    },
  };
}

/**
 * Create a listener. With a model configured (or an injected worker) it spins up
 * the listener worker and, only if the worker reports it loaded a model, returns a
 * worker-backed listener; on any failure — no model, worker spawn error, init
 * timeout, bad handshake — it returns the stub. Resolves without blocking on the
 * (slow) model load beyond initTimeoutMs; the UI reads `.mode` to show what is live.
 */
export async function createListener(opts: ListenerOptions = {}): Promise<Listener> {
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
  // Each pending request stores its timer-clearing settler plus a per-request
  // fallback — the labelled stub for THIS tier — so a worker error reply degrades
  // to legible placeholder text instead of an empty string.
  const pending = new Map<number, { settle: (r: ListenerResult) => void; fallback: () => ListenerResult }>();
  const onMessage = (ev: { data?: unknown }): void => {
    const msg = ev.data as { type?: string; id?: number; text?: string; error?: boolean } | undefined;
    if (!msg || msg.type !== 'result' || typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) {
      entry.settle(entry.fallback());
      return;
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    // An empty generation is not useful text; surface the labelled stub instead of ∅.
    entry.settle(text ? { text, mode, tier: entry.fallback().tier } : entry.fallback());
  };
  worker.addEventListener('message', onMessage);

  return {
    mode,
    respond(req: ListenerRequest): Promise<ListenerResult> {
      return new Promise<ListenerResult>((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve(stubResult(req.tier));
        }, timeoutMs);
        pending.set(id, {
          settle: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          fallback: () => stubResult(req.tier),
        });
        try {
          worker.postMessage({ type: 'generate', id, messages: req.messages, maxNewTokens: req.maxNewTokens });
        } catch {
          clearTimeout(timer);
          if (pending.delete(id)) resolve(stubResult(req.tier));
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
  opts: ListenerOptions,
  timeoutMs: number,
): Promise<ListenerMode | null> {
  return new Promise<ListenerMode | null>((resolve) => {
    let settled = false;
    const onMessage = (ev: { data?: unknown }): void => {
      const msg = ev.data as { type?: string; mode?: string } | undefined;
      if (!msg) return;
      if (msg.type === 'ready') done(msg.mode === 'webgpu' || msg.mode === 'wasm' ? msg.mode : null);
      else if (msg.type === 'error') done(null);
    };
    const onError = (): void => done(null);
    const done = (m: ListenerMode | null): void => {
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
 * The bundled listener worker. Vite recognises this exact `new Worker(new URL(...))`
 * form and bundles listener.worker.ts as an ES worker (vite.config worker.format).
 * Only reached in the browser when a model is configured — never in the node
 * tests, which inject `createWorker` or run the stub.
 */
function defaultWorker(): WorkerLike {
  return new Worker(new URL('./listener.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
