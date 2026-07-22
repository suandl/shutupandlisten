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
  /** Where a load/handshake outcome is reported — a FAILURE before degrading to the
   *  labelled stub, and the rungs a SUCCESSFUL load skipped on its way down the
   *  ladder. Defaults to `console.warn`. The degrade used to be silent: the worker
   *  posts a `reason` and the adapter dropped it, so a listener that never loaded
   *  looked identical to one that was never provisioned — which is how su-lou.9
   *  reached an operator feel-test with no evidence beyond "LLM not loaded" (and a
   *  root-cause guess that turned out to be wrong). The TTS stage learned this in
   *  su-lou.7; this is the same fix for the listener. Injectable so tests can assert
   *  it and stay quiet. */
  onDiagnostic?: (message: string) => void;
}

/**
 * Called as a reply is generated, with the text produced SO FAR (accumulated, not
 * a delta). Purely an optimization hook: it lets the caller start speaking the
 * first finished sentence while the rest is still decoding (su-lou.11), and a
 * backend that cannot stream simply never calls it, leaving the final result the
 * only thing the caller sees. Never assume it fires.
 */
export type PartialListener = (textSoFar: string) => void;

export interface Listener {
  readonly mode: ListenerMode;
  /** Weight variant the live rung loaded ('q4f16' | 'q4'); undefined in stub mode.
   *  Two rungs report mode 'webgpu' and they are NOT interchangeable — q4f16 is fp16
   *  compute and q4 is fp32 — so "which backend is live" is only half-answered by
   *  `mode`. The works-check and the Stage readout print both. */
  readonly dtype?: string;
  /** Produce a reflection/question for a substantive turn. NEVER throws — degrades
   *  to a labelled stub. `onPartial` is best-effort progress; see PartialListener. */
  respond(req: ListenerRequest, onPartial?: PartialListener): Promise<ListenerResult>;
  /** Release the worker, if any. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 30000;
/**
 * Ms to wait for the model to LOAD. 120s used to be the budget, and on the WASM rung
 * that guaranteed a stub: measured 228s to load `model_q4.onnx` (1.69G) in the
 * su-lou.9 works-check run — because the page is NOT cross-origin isolated
 * (`vite preview` sends no COOP/COEP, so `SharedArrayBuffer` is unavailable) and ORT
 * therefore runs the WASM backend SINGLE-THREADED on an 8-core host. The same model
 * loads in ~52s when served with those headers. So the old budget was not "the model
 * is wedged", it was "we hung up before it finished" — and the caller saw the same
 * labelled stub either way. Cross-origin isolation is the real fix and it is not a
 * drive-by: `@ricky0123/vad-web` fetches its worklet and Silero weights from a CDN,
 * and COEP `require-corp` would break the mic path outright (see vite.config.ts).
 * Until those are self-hosted, wait long enough for the slow rung to actually land.
 */
const DEFAULT_INIT_TIMEOUT_MS = 300000;

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
 * Report a load/handshake outcome. Routed to `opts.onDiagnostic` when provided, else
 * `console.warn`, so a listener that fails to load names the reason instead of
 * silently stubbing (su-lou.9, the listener half of su-lou.7's TTS fix).
 */
function listenerDiag(opts: ListenerOptions, message: string): void {
  (opts.onDiagnostic ?? ((m: string) => console.warn(m)))(`[listener] ${message}`);
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
    listenerDiag(opts, 'listener worker failed to start — using the labelled stub');
    return makeStub();
  }

  const initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const loaded = await initWorker(worker, opts, initTimeoutMs);
  if (loaded === null) {
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    return makeStub();
  }
  const { mode, dtype } = loaded;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 0;
  // Each pending request stores its timer-clearing settler plus a per-request
  // fallback — the labelled stub for THIS tier — so a worker error reply degrades
  // to legible placeholder text instead of an empty string. `onPartial` rides
  // along so streamed progress reaches the caller that asked for it.
  const pending = new Map<
    number,
    { settle: (r: ListenerResult) => void; fallback: () => ListenerResult; onPartial?: PartialListener }
  >();
  const onMessage = (ev: { data?: unknown }): void => {
    const msg = ev.data as { type?: string; id?: number; text?: string; error?: boolean } | undefined;
    if (!msg || typeof msg.id !== 'number') return;
    // Progress, not a result: the reply so far, while the model keeps decoding.
    // The request stays pending — this never settles it and never clears its
    // timeout, so a stream that stalls still degrades on schedule.
    if (msg.type === 'partial') {
      const entry = pending.get(msg.id);
      if (entry?.onPartial && typeof msg.text === 'string' && msg.text) entry.onPartial(msg.text);
      return;
    }
    if (msg.type !== 'result') return;
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
    dtype,
    respond(req: ListenerRequest, onPartial?: PartialListener): Promise<ListenerResult> {
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
          onPartial,
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

/** What a successful handshake yields: the live device rung and its weight variant. */
interface LoadedBackend {
  mode: 'webgpu' | 'wasm';
  dtype?: string;
}

/**
 * Run the worker's init handshake. Posts an `init` and waits for `ready` (with a
 * device mode) or fails closed on `error`, a malformed reply, or timeout. Every
 * outcome — including a SUCCESSFUL load that had to skip a rung — is reported
 * through `listenerDiag`, so the live backend is never a mystery.
 */
function initWorker(
  worker: WorkerLike,
  opts: ListenerOptions,
  timeoutMs: number,
): Promise<LoadedBackend | null> {
  return new Promise<LoadedBackend | null>((resolve) => {
    let settled = false;
    const onMessage = (ev: { data?: unknown }): void => {
      const msg = ev.data as { type?: string; mode?: string; dtype?: string; reason?: string; notes?: unknown } | undefined;
      if (!msg) return;
      if (msg.type === 'ready') {
        const mode = msg.mode === 'webgpu' || msg.mode === 'wasm' ? msg.mode : null;
        if (!mode) {
          done(null, `listener reported an unusable device mode (${String(msg.mode)}) — using the labelled stub`);
          return;
        }
        // A load that succeeded on a LOWER rung still carries news: the rungs above
        // it lost, and why. Reported even on success — "webgpu" alone hides whether
        // the fast fp16 variant or the fp32 fallback is live (su-lou.9).
        const notes = Array.isArray(msg.notes) ? msg.notes.filter((n): n is string => typeof n === 'string') : [];
        if (notes.length > 0) {
          listenerDiag(opts, `loaded ${mode}${msg.dtype ? `/${msg.dtype}` : ''} after skipping: ${notes.join('; ')}`);
        }
        done({ mode, dtype: typeof msg.dtype === 'string' ? msg.dtype : undefined });
      } else if (msg.type === 'error') {
        // The worker DOES post a reason ('no model loaded (webgpu/q4f16: …)',
        // 'engine import failed', …); surfacing it is the whole diagnosability fix.
        done(null, `listener unavailable: ${typeof msg.reason === 'string' ? msg.reason : 'unknown reason'} — using the labelled stub`);
      }
    };
    const onError = (): void => done(null, 'listener worker errored during init — using the labelled stub');
    // A degrade (b === null) names itself exactly once; the `settled` guard means
    // only the first outcome reports.
    const done = (b: LoadedBackend | null, reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (b === null && reason) listenerDiag(opts, reason);
      resolve(b);
    };
    const timer = setTimeout(
      () => done(null, `listener load timed out after ${timeoutMs}ms — using the labelled stub`),
      timeoutMs,
    );
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage({ type: 'init', engineUrl: opts.engineUrl, model: opts.model });
    } catch {
      done(null, 'listener worker did not accept init — using the labelled stub');
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
