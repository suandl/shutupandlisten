// smart-turn v3 end-of-utterance adapter (CPU/WASM, in a worker).
//
// Pipecat smart-turn v3 is an ~8M-param audio classifier (~8MB int8, ~12ms on CPU)
// that answers "is this utterance complete?" — fed here as the asymmetric veto in
// turn-detection.ts. It runs via onnxruntime-web on CPU/WASM, off the GPU (which the
// plan reserves for the LLM + TTS in U5/U6).
//
// IT HAD NEVER RUN (su-lou.10.1). Until that unit there was no provisioner for the
// model, so `if (!opts.modelUrl) return heuristic` took every call and the live
// harness has always been the duration heuristic below. That is why the 2000ms
// silence floor carried ALL the patience alone — with no real end-of-utterance
// signal, the timer WAS the decision. Dropping the floor to ~500-750ms (su-lou.10.6)
// only makes sense once this stage is real, so `npm run provision:smart-turn` +
// this adapter are a prerequisite for that unit, not a nicety.
//
// AND THEN IT FROZE THE PAGE (su-viz2). Once it was real, it was also the only heavy
// stage without a worker: `predict()` ran the log-Mel front-end and the ORT session on
// the CALLING thread, and measurement (su-lou.10.5) found it held that thread for 100%
// of every verdict — 691ms verdict → 691ms blocked, three for three, with zero
// heartbeat ticks delivered. The await yielded no thread because there was no other
// thread. Worse, the freeze also stalled main.ts's 90ms tick loop, which is what fires
// the patience deadline, so the block ADDED to the latency rather than merely
// accompanying it. This file is now the MAIN-THREAD HALF only — lifecycle, fallback
// policy, timeouts — and everything from PCM to probability runs in
// smart-turn.worker.ts. Per verdict the main thread does one postMessage.
//
// The heuristic REMAINS, on purpose: an un-provisioned deploy, a fresh clone or CI
// has no model to load, and the harness must still run. What is NOT acceptable is
// claiming `model` while running the heuristic — the UI, the probe and the
// works-check all read `.mode`, and su-lou.7/.8/.9 were each a stage silently
// degrading behind a mode nobody checked. Every degrade here is reported through
// `onDiagnostic` and reflected in `.mode`.
//
// The input contract is NOT raw audio: v3 is a Whisper-tiny encoder, so it takes the
// Whisper log-Mel spectrogram of the last 8 seconds ([1, 80, 800]). That front-end
// lives in whisper-mel.ts and is applied inside the worker, conformance-tested
// against the canonical implementation.

export type SmartTurnMode = 'model' | 'heuristic';

export interface SmartTurnResult {
  /** P(complete) in [0,1]; higher = more likely a finished thought. */
  completionProb: number;
  mode: SmartTurnMode;
}

/** Minimal structural Worker shape so the adapter is unit-testable with a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
}

export interface SmartTurnOptions {
  /** URL of the smart-turn v3 ONNX model. When omitted/unreachable → heuristic. */
  modelUrl?: string;
  /**
   * Explicit URL of the ONNX Runtime wasm binary. Defaults to the asset the bundler
   * emitted from this app's own onnxruntime-web — same-origin and version-coherent
   * by construction — so this is only for a host that serves it from elsewhere.
   */
  wasmPath?: string;
  /** Trailing segments shorter than this read as "incomplete" in heuristic mode. */
  heuristicShortSegmentMs?: number;
  /** Per-call ms before a wedged session degrades THIS verdict to the heuristic. */
  timeoutMs?: number;
  /** Budget for the worker's load-time warmup run. Separate from `timeoutMs`: the
   *  first inference compiles and specializes the graph, so it is far slower than a
   *  steady-state call (~1s vs ~60ms in headless Chromium). */
  initTimeoutMs?: number;
  /** Ms before a worker that never answers the init handshake is given up on. See
   *  DEFAULT_LOAD_TIMEOUT_MS for why this is generous and why it exists at all. */
  loadTimeoutMs?: number;
  /** Where a degrade is reported. Defaults to `console.warn`; injectable for tests. */
  onDiagnostic?: (message: string) => void;
  /** Inject a worker (tests / custom hosting). Defaults to the bundled smart-turn.worker. */
  createWorker?: () => WorkerLike;
}

export interface SmartTurn {
  readonly mode: SmartTurnMode;
  /** Classify a 16kHz mono speech segment. Never throws — degrades to heuristic. */
  predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnResult>;
  /** Release the worker, if any. */
  close(): void;
}

const SAMPLE_RATE = 16000;

/**
 * A verdict that lands after the turn was already decided is worthless, so a wedged
 * session degrades this call rather than hanging the promise chain. Roughly 7x the
 * ~270ms a warmed verdict measures in headless Chromium (front-end + inference; the
 * model card's ~12ms is a native-CPU figure, not a wasm one), so this catches a
 * stall, not a slow machine. Now measured off the message round-trip, which is the
 * number that actually matters to the caller: the worker hop is part of the wait.
 */
const DEFAULT_TIMEOUT_MS = 2000;

/** Budget for the worker's warmup — a cold first inference, not a steady-state one. */
const DEFAULT_INIT_TIMEOUT_MS = 30000;

/**
 * Backstop for a worker that never answers `init` at all.
 *
 * The worker reports every failure it can OBSERVE as an `error` reply, so this only
 * fires when it is stuck somewhere it cannot report from — a module that never
 * finishes loading, an ORT session create that never settles. Without it,
 * `createSmartTurn()` would hang, and it is awaited inside `MicAudioSource.start()`,
 * so the microphone would never open and the UI would never say why. (The pre-worker
 * code had the same hazard and no backstop: the model download was unbounded.)
 *
 * Generous on purpose — it spans a ~21MB model + runtime download plus the warmup, and
 * a slow link must read as slow, not as a broken stage.
 */
const DEFAULT_LOAD_TIMEOUT_MS = 60000;

// ── Default self-hosted smart-turn config (`npm run provision:smart-turn`) ──
//
// Same shape as STT/LLM/TTS/denoise: the model is served from the app's OWN origin,
// so a provisioned deploy classifies out-of-the-box and an un-provisioned one
// degrades to the labelled heuristic. Nothing is fetched cross-origin and no mic
// audio leaves the page. Unlike the other stages this one needs no engine wrapper —
// the model is a bare ONNX graph, and its runtime (onnxruntime-web) is bundled with
// the app rather than provisioned, so only the weights are a deploy-time step.
export const DEFAULT_SMART_TURN_MODEL_URL = '/smart-turn/smart-turn-v3.onnx';

/** Report a degrade, so a stage that falls back names itself (su-lou.7's lesson). */
function diag(opts: SmartTurnOptions, reason: string): void {
  (opts.onDiagnostic ?? ((m: string) => console.warn(m)))(`[smart-turn] ${reason} — using the duration heuristic`);
}

/**
 * Load smart-turn. Spins up the EOU worker when a model URL is given (or a worker is
 * injected) and, only if the worker reports it loaded AND warmed a graph that can
 * score, returns a worker-backed classifier; on any failure it returns the labelled
 * duration heuristic. Resolves quickly so the harness never blocks on a model download.
 */
export async function createSmartTurn(opts: SmartTurnOptions = {}): Promise<SmartTurn> {
  const shortMs = opts.heuristicShortSegmentMs ?? 700;

  const heuristic: SmartTurn = {
    mode: 'heuristic',
    async predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnResult> {
      const durationMs = (audio.length / (sampleRate || SAMPLE_RATE)) * 1000;
      // Short trailing utterances are more likely mid-thought ("and", "so",
      // "but"); a long final clause is more likely complete. Map duration to a
      // smooth P(complete) around the short-segment knee so the threshold knob
      // still bites.
      const completionProb = clamp01(0.2 + 0.6 * (durationMs / (shortMs * 2)));
      return { completionProb, mode: 'heuristic' };
    },
    close() {
      /* nothing to release */
    },
  };

  if (!opts.createWorker && !opts.modelUrl) return heuristic;

  let worker: WorkerLike;
  try {
    worker = opts.createWorker ? opts.createWorker() : defaultWorker();
  } catch (err) {
    diag(opts, `the EOU worker failed to start (${errText(err)})`);
    return heuristic;
  }

  // The handshake carries the load-time assertion across the worker boundary: the
  // worker answers `ready` ONLY after it has warmed the graph and mapped a real score
  // out of it, so `model` below is an assertion and not a hope. A graph that loads but
  // cannot score comes back as an `error` with its reason, exactly as it did when this
  // ran in-process (su-lou.10.1) — the false-green su-lou.7/.8/.9 each turned out to
  // be must not sneak back in through the hop off-thread (su-viz2).
  const failure = await initWorker(worker, opts);
  if (failure !== null) {
    terminateQuietly(worker);
    diag(opts, failure);
    return heuristic;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A wedged session does not degrade ONE call — it degrades every call after it. The
  // stalled WASM run keeps the worker's thread, so later inferences queue behind it and
  // time out too; the load-time warmup by construction cannot catch a session that
  // dies mid-flight. Reporting only the first failure and still swearing `model`
  // while every verdict silently comes from the heuristic is precisely the false-green
  // su-lou.7/.8/.9 each turned out to be — a stage dead behind a mode nobody rechecked.
  //
  // So count CONSECUTIVE failures and, once the session has plainly stopped
  // recovering, ABANDON it: terminate the worker, say so once, and route every later
  // call straight to the heuristic. Terminating is strictly stronger than the
  // `session.release()` this used to do on the main thread — it actually kills the
  // wedged wasm run and reclaims its heap, instead of leaving it holding a thread. A
  // single clean verdict resets the count: one slow call is not a dead session, and
  // only a run of them is.
  const MAX_CONSECUTIVE_FAILURES = 3;

  let degraded = false; // report a per-call degrade once, not once per utterance
  let abandoned = false; // the session was given up on — every verdict is the heuristic now
  let consecutiveFailures = 0;
  let nextId = 0;

  const pending = new Map<number, { settle: (err: Error | null, prob: number) => void }>();

  const onMessage = (ev: { data?: unknown }): void => {
    const msg = ev.data as { type?: string; id?: number; completionProb?: number; error?: string } | undefined;
    if (!msg || msg.type !== 'result' || typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return; // a reply for a verdict we already timed out on — drop it
    pending.delete(msg.id);
    if (typeof msg.error === 'string') entry.settle(new Error(msg.error), 0);
    // Finite-checked at the boundary, not just inside the worker. The worker maps its
    // output through completionProbFrom, which throws on a non-finite score, so this
    // should be unreachable — but a NaN that DID slip through would reach the detector
    // as a silent, permanent "incomplete" veto (`NaN >= completionThreshold` is false)
    // and hold every turn open. Cheap to check; invisible if it ever failed.
    else if (typeof msg.completionProb === 'number' && Number.isFinite(msg.completionProb)) {
      entry.settle(null, msg.completionProb);
    } else entry.settle(new Error('the worker returned no usable probability'), 0);
  };
  worker.addEventListener('message', onMessage);

  /** Tear the worker down and fail every verdict still in flight — none of them can
   *  land now, and a promise nobody settles would hang `classify()` forever. */
  const teardown = (): void => {
    const inFlight = [...pending.values()];
    pending.clear();
    for (const entry of inFlight) entry.settle(new Error('the EOU worker was shut down'), 0);
    try {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onCrash);
      worker.terminate();
    } catch {
      /* already gone */
    }
  };

  // A worker that dies MID-SESSION is a different failure from one that never loads:
  // initWorker owns the load-time crash and drops its own `error` listener the instant
  // the handshake settles, so past `ready` nothing is watching the worker at all. Left
  // to the failure counter alone a steady-state crash is caught only slowly — the dead
  // worker just stops answering, so every verdict burns the full timeoutMs and it takes
  // MAX_CONSECUTIVE_FAILURES of them (~6s of degraded turn-taking) before abandonment
  // finally trips. So watch for the crash directly and give up at once: the same
  // terminal state the counter would reach, minus the wait. The `abandoned` guard makes
  // this idempotent with close() and with itself — a crash that arrives after a
  // deliberate shutdown, or a second `error` event, is nothing new and is not re-reported.
  const onCrash = (ev: { data?: unknown }): void => {
    if (abandoned) return;
    abandoned = true;
    // The crash IS the report. The verdicts teardown() is about to strand each land in
    // predict()'s catch, so claim the once-only per-call degrade here too or they would
    // add a second, redundant line for a failure already named.
    degraded = true;
    teardown();
    // An `error` event is an ErrorEvent, whose `message` names the fault; the structural
    // WorkerLike type only promises `data`, so read the name off the side.
    const message = (ev as unknown as { message?: string }).message;
    diag(opts, `the EOU worker crashed (${message || 'no message'})`);
  };
  worker.addEventListener('error', onCrash);

  const classifyInWorker = (audio: Float32Array): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        settle: (err, prob) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(prob);
        },
      });
      try {
        // No transfer list: structured-clone the samples. vad.ts hands the SAME
        // Float32Array to the STT worker on the next line, so transferring it here
        // would detach the buffer out from under transcription. The copy is a
        // sub-millisecond memcpy of ≤512KB against a verdict measured in hundreds of
        // ms — the wrong thing to optimize, and the right thing not to break.
        worker.postMessage({ type: 'classify', id, audio });
      } catch (err) {
        if (pending.delete(id)) {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });

  return {
    // `mode` must track reality, not the load-time hope: after abandonment every
    // verdict is the heuristic's, so a consumer that reads it (probe.ts, the
    // works-check) sees the truth. vad.ts reads it once at mic start and keeps the
    // honest load-time value — acceptable, because the per-result mode below still
    // tells the truth on every single call.
    get mode(): SmartTurnMode {
      return abandoned ? 'heuristic' : 'model';
    },
    async predict(audio: Float32Array, sampleRate: number): Promise<SmartTurnResult> {
      if (abandoned) return heuristic.predict(audio, sampleRate);
      try {
        if (sampleRate !== SAMPLE_RATE) {
          // The VAD hands segments over at exactly 16kHz; resampling silently here
          // would change verdict quality without anyone knowing. Checked BEFORE the
          // postMessage so nothing crosses to the model at the wrong rate.
          throw new Error(`expected ${SAMPLE_RATE}Hz audio, got ${sampleRate}Hz`);
        }
        const completionProb = await classifyInWorker(audio);
        consecutiveFailures = 0; // a clean verdict clears the run — the session lives
        return { completionProb, mode: 'model' };
      } catch (err) {
        if (!degraded) {
          degraded = true;
          diag(opts, `classification failed (${errText(err)})`);
        }
        // Guarded on `abandoned`: teardown fails every in-flight verdict, and those
        // rejections land right here. Without the guard they would re-escalate and
        // report the abandonment once per stranded call.
        if (!abandoned && ++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          abandoned = true;
          teardown();
          diag(opts, `${MAX_CONSECUTIVE_FAILURES} consecutive failures — abandoning the model for this session`);
        }
        return heuristic.predict(audio, sampleRate);
      }
    },
    close() {
      // Mark the session abandoned BEFORE teardown, not merely release the worker.
      // teardown() rejects every in-flight verdict, and those rejections land in
      // predict()'s catch — where, with `abandoned` still false, three-plus stranded
      // verdicts at close time would trip the failure counter and log an "abandoning"
      // escalation for a shutdown that was deliberate. Setting the flag first lets the
      // catch's `!abandoned` guard swallow it. Still guarded so close() stays idempotent
      // and an already-abandoned adapter does not double-terminate.
      if (!abandoned) {
        abandoned = true;
        teardown();
      }
    },
  };
}

/**
 * Run the worker's init handshake. Posts an `init` and waits for `ready` or fails
 * closed on `error`, a worker crash, a malformed reply, or timeout.
 *
 * Returns `null` when the worker is live, or the reason it is not — relayed verbatim
 * from the worker where there is one, so `model loaded but could not score (...)`
 * still reaches the operator's console across the thread boundary.
 */
function initWorker(worker: WorkerLike, opts: SmartTurnOptions): Promise<string | null> {
  const loadTimeoutMs = opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    // The worker reports outcomes as `message` posts (`ready` / `error`); a failed
    // model load must fail the handshake at once, not hang the timeout. The `error`
    // EVENT is the separate worker-crash signal.
    const onMessage = (ev: { data?: unknown }): void => {
      const msg = ev.data as { type?: string; reason?: string } | undefined;
      if (!msg) return;
      if (msg.type === 'ready') done(null);
      else if (msg.type === 'error') done(msg.reason || 'the EOU worker reported a failed load');
    };
    const onError = (): void => done('the EOU worker crashed while loading');
    const done = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      resolve(reason);
    };
    const timer = setTimeout(() => done(`the EOU worker did not load within ${loadTimeoutMs}ms`), loadTimeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    try {
      worker.postMessage({
        type: 'init',
        modelUrl: opts.modelUrl,
        wasmPath: opts.wasmPath,
        initTimeoutMs: opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
      });
    } catch (err) {
      done(`the EOU worker rejected its init message (${errText(err)})`);
    }
  });
}

/**
 * The bundled smart-turn worker. Vite recognises this exact `new Worker(new URL(...))`
 * form and bundles smart-turn.worker.ts as an ES worker (vite.config worker.format).
 * Only reached in the browser when a model is configured — never in the node tests,
 * which inject `createWorker` or run the heuristic.
 */
function defaultWorker(): WorkerLike {
  return new Worker(new URL('./smart-turn.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

function terminateQuietly(worker: WorkerLike): void {
  try {
    worker.terminate();
  } catch {
    /* already gone */
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
