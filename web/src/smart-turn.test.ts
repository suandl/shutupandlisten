// Tests for the smart-turn EOU adapter (smart-turn.ts) — the MAIN-THREAD half.
//
// Since su-viz2 this file owns lifecycle and fallback policy only; the log-Mel
// front-end, the inference and the load-time warmup run in smart-turn.worker.ts and
// are tested through smart-turn-classifier.ts. So the seam here is a fake WORKER, and
// the thing these tests assert about the model path is that the main thread does
// nothing per verdict except post a message — which is the fix.
//
// The guarantees under test:
//   1. no model configured → the labelled duration heuristic, unchanged (an
//      un-provisioned deploy / CI must still run)
//   2. THE MAIN THREAD DOES NO VERDICT WORK: the raw segment crosses to the worker
//      untouched, and it is not detached out from under the STT path
//   3. a worker that reports `ready` — which it does only after warming a graph that
//      can score — makes the adapter report `model`; anything else is an honest
//      `heuristic`. Claiming `model` while running the heuristic is the exact bug
//      class su-lou.10.1 exists to close (cf. su-lou.7/.8/.9)
//   4. every degrade is REPORTED and reflected in the per-call result mode — a load
//      failure, a worker crash, a per-call error, a wedged worker, a wrong sample rate
//   5. predict never throws, whatever the worker does

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSmartTurn, type WorkerLike } from './smart-turn.ts';

const SR = 16000;
/** A speech-shaped segment of `ms` milliseconds (content is irrelevant here). */
const segment = (ms: number): Float32Array =>
  Float32Array.from({ length: Math.round((SR * ms) / 1000) }, (_, i) => Math.sin(i / 11) * 0.4);

interface ClassifyPost {
  type: string;
  id: number;
  audio: Float32Array;
}

/**
 * A stand-in for smart-turn.worker.ts, speaking the same message protocol.
 *
 * `init` decides the handshake: `'ready'`, an error reason, or `'silent'` for a worker
 * that never answers. `classify` decides each verdict: a number is a probability, an
 * Error is a per-call failure reply, `'silent'` is a wedged call that never comes back.
 */
function fakeWorker(
  behaviour: {
    init?: 'ready' | 'silent' | { error: string };
    classify?: (audio: Float32Array, callIndex: number) => number | Error | 'silent';
    onTerminate?: () => void;
  } = {},
) {
  const listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();
  const classifyPosts: ClassifyPost[] = [];
  const initPosts: Array<Record<string, unknown>> = [];
  let terminated = 0;

  const emit = (data: unknown): void => {
    for (const listener of [...(listeners.get('message') ?? [])]) listener({ data });
  };

  // A worker crash is an `error` EVENT, not a `message` post, so it needs its own
  // firing path: the adapter's steady-state crash listener registers under 'error', and
  // emit() above only ever reaches 'message' listeners.
  const emitError = (event: { message?: string } = {}): void => {
    for (const listener of [...(listeners.get('error') ?? [])]) listener(event as { data?: unknown });
  };

  const worker: WorkerLike = {
    postMessage(message: unknown) {
      const msg = message as { type?: string; id?: number; audio?: Float32Array };
      if (msg.type === 'init') {
        initPosts.push(message as Record<string, unknown>);
        const init = behaviour.init ?? 'ready';
        if (init === 'silent') return;
        queueMicrotask(() => emit(init === 'ready' ? { type: 'ready' } : { type: 'error', reason: init.error }));
        return;
      }
      if (msg.type !== 'classify') return;
      const index = classifyPosts.length;
      classifyPosts.push(message as ClassifyPost);
      const out = behaviour.classify ? behaviour.classify(msg.audio!, index) : 0.87;
      if (out === 'silent') return;
      queueMicrotask(() =>
        emit(
          out instanceof Error
            ? { type: 'result', id: msg.id, error: out.message }
            : { type: 'result', id: msg.id, completionProb: out },
        ),
      );
    },
    terminate() {
      terminated++;
      behaviour.onTerminate?.();
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    worker,
    classifyPosts,
    initPosts,
    classifyCalls: () => classifyPosts.length,
    terminatedCount: () => terminated,
    /** Push a message the adapter did not ask for — a late reply, a stray shape. */
    emit,
    /** Fire an `error` event — a worker that crashed out from under the session. */
    emitError,
  };
}

/** The adapter with a live fake worker behind it, which is the common setup. */
const withWorker = (fake: ReturnType<typeof fakeWorker>, opts: Record<string, unknown> = {}) =>
  createSmartTurn({ modelUrl: '/smart-turn/smart-turn-v3.onnx', createWorker: () => fake.worker, ...opts });

// ── the heuristic fallback ─────────────────────────────────────────────────────

test('no model configured → the labelled duration heuristic', async () => {
  const st = await createSmartTurn();
  assert.equal(st.mode, 'heuristic');
  const short = await st.predict(segment(200), SR);
  const long = await st.predict(segment(1600), SR);
  assert.equal(short.mode, 'heuristic');
  assert.ok(short.completionProb < 0.5, `a 200ms trailing segment should read incomplete, got ${short.completionProb}`);
  assert.ok(long.completionProb > 0.5, `a 1.6s trailing segment should read complete, got ${long.completionProb}`);
  st.close();
});

test('the heuristic knee is tunable and stays in [0,1]', async () => {
  // 300ms reads incomplete against the default 700ms knee and complete against a
  // 200ms one — the knob still bites.
  const tight = await createSmartTurn({ heuristicShortSegmentMs: 200 });
  const loose = await createSmartTurn();
  assert.ok((await tight.predict(segment(300), SR)).completionProb > 0.5);
  assert.ok((await loose.predict(segment(300), SR)).completionProb < 0.5);
  const huge = await tight.predict(segment(30000), SR);
  assert.ok(huge.completionProb <= 1, 'the probability stays clamped for a very long segment');
  tight.close();
  loose.close();
});

// ── the model path: off the main thread ────────────────────────────────────────

test('a ready worker reports `model` and its verdict is the adapter’s verdict', async () => {
  const fake = fakeWorker({ classify: () => 0.87 });
  const st = await withWorker(fake);
  assert.equal(st.mode, 'model');
  assert.equal(fake.classifyCalls(), 0, 'the graph is warmed in the worker at load, before any speech');

  const r = await st.predict(segment(1200), SR);
  assert.equal(r.mode, 'model');
  assert.equal(r.completionProb, 0.87);
  assert.equal(fake.classifyCalls(), 1);

  st.close();
  assert.equal(fake.terminatedCount(), 1, 'close() must release the worker');
});

test('THE FIX: the raw segment crosses to the worker — the main thread runs no front-end', async () => {
  // su-viz2. The verdict used to run the log-Mel front-end AND the inference on the
  // calling thread, freezing the page for 100% of every verdict's duration. The
  // structural guarantee that it cannot come back: the only per-verdict work on this
  // thread is a postMessage, so what leaves it is still PCM — not an [80, 800]
  // feature tensor, which would mean whisperFeatures() ran here again.
  const fake = fakeWorker();
  const st = await withWorker(fake);
  const audio = segment(1200);
  await st.predict(audio, SR);

  const posted = fake.classifyPosts[0];
  assert.equal(posted.audio.length, audio.length, 'the untouched segment is what crosses the boundary');
  assert.equal(posted.audio[0], audio[0]);
  st.close();
});

test('the segment is NOT transferred — the STT path still sees its samples', async () => {
  // vad.ts hands the SAME Float32Array to this adapter and then to the STT worker. A
  // transfer list here would detach the buffer out from under transcription; the copy
  // is a sub-ms memcpy against a verdict measured in hundreds of ms.
  const fake = fakeWorker();
  const st = await withWorker(fake);
  const audio = segment(1200);
  await st.predict(audio, SR);
  assert.equal(audio.length, 19200, 'a detached buffer would report length 0');
  assert.ok(Number.isFinite(audio[100]));
  st.close();
});

test('the init handshake carries the model config the worker needs', async () => {
  const fake = fakeWorker();
  const st = await withWorker(fake, { wasmPath: '/ort/ort-wasm.wasm', initTimeoutMs: 1234 });
  assert.equal(fake.initPosts.length, 1);
  assert.deepEqual(fake.initPosts[0], {
    type: 'init',
    modelUrl: '/smart-turn/smart-turn-v3.onnx',
    wasmPath: '/ort/ort-wasm.wasm',
    initTimeoutMs: 1234,
  });
  st.close();
});

// ── degrades: reported, and visible in the per-call mode ───────────────────────

test('a worker that reports a failed load degrades to the heuristic and says why', async () => {
  // The worker answers `ready` only after warming a graph that produced a real score,
  // so this covers BOTH "the model 404ed" and "it loaded but could not score" — the
  // load-time assertion (su-lou.10.1) reaching the main thread across the hop.
  for (const reason of ['model failed to load (404 fetching the model)', 'model loaded but could not score (no output)']) {
    const diagnostics: string[] = [];
    const fake = fakeWorker({ init: { error: reason } });
    const st = await withWorker(fake, { onDiagnostic: (m: string) => diagnostics.push(m) });
    assert.equal(st.mode, 'heuristic');
    assert.equal(diagnostics.length, 1);
    assert.ok(diagnostics[0].includes(reason), `the worker's reason must reach the console verbatim: ${diagnostics[0]}`);
    assert.match(diagnostics[0], /heuristic/);
    assert.equal(fake.terminatedCount(), 1, 'a worker that will never classify is not left running');
    st.close();
  }
});

test('a worker that never answers init is given up on rather than hanging mic start', async () => {
  // createSmartTurn() is awaited inside MicAudioSource.start(), so a handshake that
  // never settles means the microphone never opens and the UI never says why.
  const diagnostics: string[] = [];
  const fake = fakeWorker({ init: 'silent' });
  const st = await withWorker(fake, { loadTimeoutMs: 20, onDiagnostic: (m: string) => diagnostics.push(m) });
  assert.equal(st.mode, 'heuristic');
  assert.match(diagnostics[0], /did not load within 20ms/);
  st.close();
});

test('a worker that fails to spawn degrades instead of breaking the page', async () => {
  const diagnostics: string[] = [];
  const st = await createSmartTurn({
    modelUrl: '/smart-turn/smart-turn-v3.onnx',
    createWorker: () => {
      throw new Error('Worker constructor blocked');
    },
    onDiagnostic: (m) => diagnostics.push(m),
  });
  assert.equal(st.mode, 'heuristic');
  assert.match(diagnostics[0], /Worker constructor blocked/);
  st.close();
});

test('a per-call failure degrades THAT verdict, and the result says heuristic', async () => {
  const diagnostics: string[] = [];
  const fake = fakeWorker({ classify: () => new Error('shape mismatch') });
  const st = await withWorker(fake, { onDiagnostic: (m: string) => diagnostics.push(m) });
  assert.equal(st.mode, 'model');
  const r = await st.predict(segment(1200), SR);
  // The adapter still holds a worker, but THIS verdict came from the heuristic —
  // which is what the works-check reads to catch a false-green load.
  assert.equal(r.mode, 'heuristic');
  assert.ok(r.completionProb > 0 && r.completionProb <= 1);
  assert.match(diagnostics[0], /shape mismatch/);
  await st.predict(segment(1200), SR);
  assert.equal(diagnostics.length, 1, 'a repeated per-call failure must not spam the console');
  st.close();
});

test('a reply with no probability is a failure, not a verdict of undefined', async () => {
  const diagnostics: string[] = [];
  const fake = fakeWorker({ classify: () => 'silent' });
  const st = await withWorker(fake, { timeoutMs: 500, onDiagnostic: (m: string) => diagnostics.push(m) });
  const pending = st.predict(segment(1200), SR);
  fake.emit({ type: 'result', id: 0 }); // malformed: no completionProb, no error
  const r = await pending;
  assert.equal(r.mode, 'heuristic');
  assert.ok(Number.isFinite(r.completionProb));
  assert.match(diagnostics[0], /no usable probability/);
  st.close();
});

test('a wedged worker times out instead of holding the turn open', async () => {
  const diagnostics: string[] = [];
  const fake = fakeWorker({ classify: () => 'silent' });
  const st = await withWorker(fake, { timeoutMs: 20, onDiagnostic: (m: string) => diagnostics.push(m) });
  assert.equal(st.mode, 'model');
  const r = await st.predict(segment(1200), SR);
  assert.equal(r.mode, 'heuristic');
  assert.match(diagnostics[0], /timed out/);
  st.close();
});

test('a reply that arrives after its verdict timed out is ignored', async () => {
  // The wedged run keeps going in the worker; its answer must not resolve a promise
  // that already settled, nor be mistaken for the NEXT verdict.
  const fake = fakeWorker({ classify: (_audio, i) => (i === 0 ? 'silent' : 0.42) });
  const st = await withWorker(fake, { timeoutMs: 20 });
  const first = await st.predict(segment(1200), SR);
  assert.equal(first.mode, 'heuristic');
  fake.emit({ type: 'result', id: 0, completionProb: 0.99 }); // the late answer
  const second = await st.predict(segment(1200), SR);
  assert.equal(second.completionProb, 0.42, 'the late reply must not be adopted as the next verdict');
  st.close();
});

test('a worker that keeps failing is ABANDONED, not degraded forever behind a `model` mode', async () => {
  // The bug this closes: a wedged session degrades EVERY call after the first (the
  // stalled run holds the worker's thread, so later calls queue and fail too), yet the
  // old adapter reported one warn line and kept claiming `model` while every verdict
  // came from the heuristic — a stage dead behind a mode nobody rechecked
  // (su-lou.7/.8/.9). Terminating the worker is strictly stronger than the
  // session.release() this used to do: it reclaims the wasm heap and kills the queue.
  const diagnostics: string[] = [];
  const fake = fakeWorker({ classify: () => new Error('shape mismatch') });
  const st = await withWorker(fake, { onDiagnostic: (m: string) => diagnostics.push(m) });
  assert.equal(st.mode, 'model');

  // Three consecutive failures (the escalation threshold) is enough to give up.
  for (let i = 0; i < 3; i++) assert.equal((await st.predict(segment(1200), SR)).mode, 'heuristic');

  assert.equal(st.mode, 'heuristic', 'after abandonment `mode` tells the truth: the heuristic is running');
  assert.equal(fake.terminatedCount(), 1, 'the abandoned worker is terminated, not left wedged');
  assert.equal(diagnostics.filter((m) => /abandoning/.test(m)).length, 1, 'the abandonment is named, once');

  // A later call must not touch the dead worker again — that is what stops piling
  // fresh calls onto a wedged session.
  const before = fake.classifyCalls();
  const r = await st.predict(segment(1200), SR);
  assert.equal(r.mode, 'heuristic');
  assert.equal(fake.classifyCalls(), before, 'no further calls reach the abandoned worker');
  assert.equal(diagnostics.filter((m) => /abandoning/.test(m)).length, 1, 'escalation is reported once, ever');
  st.close();
  assert.equal(fake.terminatedCount(), 1, 'close() on an already-abandoned adapter does not double-terminate');
});

test('abandonment settles the verdicts still in flight instead of stranding them', async () => {
  // Teardown terminates the worker, so anything queued behind the wedge can never be
  // answered. Those promises must reject into the heuristic, not hang classify()
  // forever — and they must not each re-report the abandonment.
  const diagnostics: string[] = [];
  const fake = fakeWorker({ classify: (_audio, i) => (i === 0 ? 'silent' : new Error('shape mismatch')) });
  const st = await withWorker(fake, { timeoutMs: 5000, onDiagnostic: (m: string) => diagnostics.push(m) });
  const stranded = st.predict(segment(1200), SR); // posted first, never answered
  // Drive three failures past it; the third abandons and tears the worker down.
  for (let i = 0; i < 3; i++) await st.predict(segment(1200), SR);
  const r = await stranded;
  assert.equal(r.mode, 'heuristic');
  assert.equal(diagnostics.filter((m) => /abandoning/.test(m)).length, 1);
  st.close();
});

test('a clean verdict resets the failure run, so scattered failures never escalate', async () => {
  // Escalation keys on CONSECUTIVE failures, not a lifetime tally: a lone slow call
  // between healthy ones is not a dead session, so four total failures that never run
  // three-in-a-row must leave the model live.
  const diagnostics: string[] = [];
  const fails = new Set([0, 1, 3, 4]); // call 2 is a healthy verdict that resets the run
  const fake = fakeWorker({ classify: (_audio, i) => (fails.has(i) ? new Error('transient stall') : 0.8) });
  const st = await withWorker(fake, { onDiagnostic: (m: string) => diagnostics.push(m) });

  for (let i = 0; i < 5; i++) await st.predict(segment(1200), SR); // fail, fail, success, fail, fail

  assert.equal(st.mode, 'model', 'the worker was never three-in-a-row down, so it is not abandoned');
  assert.equal(fake.terminatedCount(), 0, 'a live worker is not terminated mid-run');
  assert.equal(diagnostics.filter((m) => /abandoning/.test(m)).length, 0, 'no escalation without a consecutive run');
  st.close();
});

test('a worker that crashes mid-session is abandoned at once, not after three slow timeouts', async () => {
  // initWorker() drops its load-time `error` listener the moment the handshake settles,
  // so past `ready` a steady-state crash has nobody watching. Left to the failure counter
  // the dead worker would simply stop answering — every verdict burning the full
  // timeoutMs, three of them (~6s of degraded turn-taking) before abandonment finally
  // trips. The persistent crash listener collapses that to a single event: the session
  // flips to the heuristic the instant the worker dies. timeoutMs is deliberately long
  // here so a test that passes proves the crash — not a timeout — did the abandoning.
  const diagnostics: string[] = [];
  const fake = fakeWorker({ classify: () => 'silent' }); // a verdict is in flight when the crash lands
  const st = await withWorker(fake, { timeoutMs: 5000, onDiagnostic: (m: string) => diagnostics.push(m) });
  assert.equal(st.mode, 'model');

  const inFlight = st.predict(segment(1200), SR); // posted, and will never be answered
  fake.emitError({ message: 'RuntimeError: memory access out of bounds' }); // the worker dies

  const r = await inFlight;
  assert.equal(r.mode, 'heuristic', 'the stranded verdict settles to the heuristic instead of hanging the turn');
  assert.equal(st.mode, 'heuristic', 'a dead worker cannot be `model` — mode tells the truth at once');
  assert.equal(fake.terminatedCount(), 1, 'the crashed worker is torn down, not left to time out call after call');
  assert.equal(diagnostics.length, 1, 'the crash is named exactly once — not once per stranded verdict too');
  assert.match(diagnostics[0], /crashed/);
  assert.match(diagnostics[0], /memory access out of bounds/, 'the crash names itself so the console says why');

  // Every later verdict is the heuristic and never reaches the dead worker again — the
  // same guarantee abandonment-by-counter gives, arrived at without the wait.
  const before = fake.classifyCalls();
  const later = await st.predict(segment(1200), SR);
  assert.equal(later.mode, 'heuristic');
  assert.equal(fake.classifyCalls(), before, 'no later verdict is piled onto the crashed worker');
  st.close();
  assert.equal(fake.terminatedCount(), 1, 'close() after a crash does not double-terminate');
});

test('a second crash after abandonment does not double-report', async () => {
  // A worker can emit more than one `error`, and a crash can arrive after close() has
  // already given up on the session. Either way the terminal state was reached once, so
  // a repeat event must be a no-op: no second diagnostic, no second terminate.
  const diagnostics: string[] = [];
  const fake = fakeWorker();
  const st = await withWorker(fake, { onDiagnostic: (m: string) => diagnostics.push(m) });
  fake.emitError({ message: 'first crash' });
  fake.emitError({ message: 'second crash' });
  assert.equal(diagnostics.length, 1, 'only the first crash is reported');
  assert.equal(fake.terminatedCount(), 1, 'the worker is terminated once, not once per event');
  st.close();
  assert.equal(fake.terminatedCount(), 1, 'close() after a crash is still a no-op');
});

test('close() with verdicts in flight settles them to the heuristic without a spurious abandonment', async () => {
  // A deliberate shutdown must not read as a dead session. close() rejects every in-flight
  // verdict via teardown(), and those rejections land in predict()'s catch; before the fix
  // they arrived with `abandoned` still false, so three-plus of them tripped the failure
  // counter and logged "abandoning the model" AFTER a clean close. close() now marks the
  // session abandoned first, so the catch's `!abandoned` guard swallows the escalation.
  const diagnostics: string[] = [];
  const fake = fakeWorker({ classify: () => 'silent' }); // nothing answers; all three sit in flight
  const st = await withWorker(fake, { timeoutMs: 5000, onDiagnostic: (m: string) => diagnostics.push(m) });
  const inFlight = [
    st.predict(segment(1200), SR),
    st.predict(segment(1200), SR),
    st.predict(segment(1200), SR),
  ]; // three stranded verdicts — the count at which the old bug escalated
  st.close(); // a deliberate shutdown, not a failing session

  const results = await Promise.all(inFlight);
  for (const r of results) assert.equal(r.mode, 'heuristic', 'a stranded verdict settles to the heuristic, not a hang');
  assert.equal(diagnostics.filter((m) => /abandoning/.test(m)).length, 0, 'a deliberate close is not an abandonment');
  st.close();
  assert.equal(fake.terminatedCount(), 1, 'the idempotent close terminates exactly once');
});

test('audio at the wrong rate degrades loudly rather than being silently resampled', async () => {
  const diagnostics: string[] = [];
  const fake = fakeWorker();
  const st = await withWorker(fake, { onDiagnostic: (m: string) => diagnostics.push(m) });
  const r = await st.predict(segment(1200), 48000);
  assert.equal(r.mode, 'heuristic');
  assert.equal(fake.classifyCalls(), 0, 'nothing should reach the model at the wrong rate');
  assert.match(diagnostics[0], /16000Hz/);
  st.close();
});

test('predict never throws, whatever the worker does', async () => {
  // Including a NaN the worker should be incapable of sending: completionProbFrom
  // throws on a non-finite score, so this is the boundary refusing to trust it anyway.
  const behaviours: Array<[string, number | Error | 'silent']> = [
    ['an error reply', new Error('shape mismatch')],
    ['a NaN probability', NaN],
    ['no reply at all', 'silent'],
  ];
  for (const [label, reply] of behaviours) {
    const fake = fakeWorker({ classify: () => reply });
    const st = await withWorker(fake, { timeoutMs: 20, onDiagnostic: () => {} });
    const r = await st.predict(segment(900), SR);
    assert.ok(Number.isFinite(r.completionProb), `${label} produced ${r.completionProb}`);
    assert.ok(r.completionProb >= 0 && r.completionProb <= 1);
    st.close();
  }
});

test('close() on a heuristic adapter is safe, and a throwing terminate is swallowed', async () => {
  const heuristic = await createSmartTurn();
  heuristic.close();
  const fake = fakeWorker({
    onTerminate: () => {
      throw new Error('terminate failed');
    },
  });
  const st = await withWorker(fake);
  assert.equal(st.mode, 'model');
  st.close(); // must not propagate — stop() runs this during teardown
});
