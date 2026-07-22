// smart-turn EOU Web Worker — runs the WHOLE end-of-utterance verdict off the main
// thread: the log-Mel front-end AND the onnxruntime-web inference.
//
// WHY BOTH HALVES (su-viz2). The verdict used to run on the calling thread, and it
// held it for 100% of its duration — 691ms verdict → 691ms blocked, three times out of
// three, zero heartbeat ticks delivered (measured in su-lou.10.5 against the real
// provisioned model). Moving only the inference — `ort.env.wasm.proxy = true` — would
// have left `whisperFeatures()`, an FFT over 8 seconds of audio, on the thread the UI
// paints from. So the entire path from PCM to probability lives behind this worker, and
// the main thread's only per-verdict work is a postMessage.
//
// This is the same shape the other three heavy stages already use (stt.worker.ts,
// listener.worker.ts, tts.worker.ts). The EOU classifier was the one that never got a
// worker.
//
// Everything is guarded: a missing/rejected model URL, a failed load, and a graph that
// loads but cannot score all report a clean handshake outcome rather than throwing, so
// the adapter degrades to the labelled duration heuristic instead of wedging. The
// load-time warmup — the assertion that stops a dead graph from reporting `model` —
// runs inside `createSmartTurnClassifier`, before this worker ever answers `ready`.
//
// This file is unavoidably browser-only (it talks to a real Worker scope and ORT), so
// it is not exercised by the node test suite. That is exactly why it is THIN: the
// classifier logic it drives lives in smart-turn-classifier.ts and the fallback policy
// lives in smart-turn.ts, both fully covered by `node --test`.

import { sanitizeEngineUrl } from './engine-url.ts';
import { createSmartTurnClassifier, ortClassifier, type SmartTurnClassifier } from './smart-turn-classifier.ts';

// Structural view of the dedicated-worker global — avoids the DOM/WebWorker lib
// clash that referencing `self`'s typed shape would cause under this tsconfig.
const ctx = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  location?: { href: string };
};

interface InitMessage {
  type: 'init';
  modelUrl?: string;
  wasmPath?: string;
  initTimeoutMs?: number;
}

interface ClassifyMessage {
  type: 'classify';
  id: number;
  audio: Float32Array;
}

let classifier: SmartTurnClassifier | null = null;
// Latches while a load is in flight so a concurrent second init cannot start a competing
// session; released again if that load fails so a fresh init can retry.
let initStarted = false;

ctx.addEventListener('message', (ev: { data: unknown }) => {
  const msg = ev.data as InitMessage | ClassifyMessage | undefined;
  if (!msg) return;
  if (msg.type === 'init') void handleInit(msg);
  else if (msg.type === 'classify') void handleClassify(msg);
});

async function handleInit(msg: InitMessage): Promise<void> {
  // The handshake is single-shot: the adapter sends exactly one 'init'. But a second
  // one must never reload — `createSmartTurnClassifier` would build a fresh ONNX session
  // and orphan the live one, leaking its wasm heap with no owner left to close it. So a
  // repeated init (or one racing an in-flight load) is answered as an idempotent no-op:
  // re-send `ready` if we already hold a classifier, and refuse to start a second load
  // while the first is still running.
  if (classifier) {
    ctx.postMessage({ type: 'ready' });
    return;
  }
  if (initStarted) return;

  if (!msg.modelUrl) {
    ctx.postMessage({ type: 'error', reason: 'no model url' });
    return;
  }
  // Defense in depth: smart-turn-config.ts already restricts ?smartTurnModel= to a
  // same-origin asset, but this worker is handed real microphone audio and then
  // fetches + executes a graph on it, so it never loads a URL it has not re-verified
  // against its own origin. Same rule, same reason, as stt.worker.ts (su-0hi #1).
  const modelUrl = sanitizeEngineUrl(msg.modelUrl, ctx.location?.href ?? '');
  if (!modelUrl) {
    ctx.postMessage({ type: 'error', reason: 'model url rejected (not self-hosted)' });
    return;
  }

  // Latch now — right before the first await — so a second init that arrives while this
  // load is in flight sees the guard and bows out instead of starting a rival session.
  initStarted = true;
  try {
    classifier = await createSmartTurnClassifier({
      createClassifier: () => ortClassifier({ modelUrl, wasmPath: msg.wasmPath }),
      initTimeoutMs: msg.initTimeoutMs,
    });
  } catch (err) {
    // The thrown message IS the diagnostic — `model failed to load (...)` or
    // `model loaded but could not score (...)`. The adapter prints it verbatim, so a
    // degrade still names itself (su-lou.7's lesson) across the worker boundary.
    // Nothing was retained — no session to leak — so release the latch to leave a fresh
    // init free to try again.
    initStarted = false;
    ctx.postMessage({ type: 'error', reason: errText(err) });
    return;
  }
  ctx.postMessage({ type: 'ready' });
}

async function handleClassify(msg: ClassifyMessage): Promise<void> {
  if (!classifier) {
    ctx.postMessage({ type: 'result', id: msg.id, error: 'classifier not initialised' });
    return;
  }
  try {
    ctx.postMessage({ type: 'result', id: msg.id, completionProb: await classifier.score(msg.audio) });
  } catch (err) {
    // Per-call failures are reported, never swallowed: the adapter counts them, names
    // the first one, and abandons the session after a run of them.
    ctx.postMessage({ type: 'result', id: msg.id, error: errText(err) });
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
