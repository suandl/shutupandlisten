// Tests for the listener adapter's load-or-degrade behaviour (listener.ts).
//
// The real model runs in a browser Web Worker on WebGPU, so here we drive a FAKE
// worker to exercise every fallback edge headlessly: no model → stub, init failure
// → stub, a healthy handshake → worker text, a per-call error/timeout → the
// labelled stub for that tier. The contract under test — the same defensive
// promise STT makes — is "createListener NEVER throws and respond always resolves
// a result".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createListener, listenerStubText } from './listener.ts';
import type { WorkerLike, ListenerRequest } from './listener.ts';

class FakeWorker implements WorkerLike {
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;
  onInit?: (msg: Record<string, unknown>) => void;
  onGenerate?: (msg: Record<string, unknown>) => void;
  private readonly listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};

  postMessage(message: unknown): void {
    const m = message as Record<string, unknown>;
    this.posted.push(m);
    if (m.type === 'init') this.onInit?.(m);
    else if (m.type === 'generate') this.onGenerate?.(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const arr = this.listeners[type];
    if (!arr) return;
    const i = arr.indexOf(listener);
    if (i >= 0) arr.splice(i, 1);
  }
  emit(type: string, data: unknown): void {
    for (const l of (this.listeners[type] ?? []).slice()) l({ data });
  }
}

function req(tier: ListenerRequest['tier'] = 'reflection'): ListenerRequest {
  return {
    messages: [
      { role: 'system', content: 'be quiet' },
      { role: 'user', content: 'so the idea is a patience window' },
    ],
    tier,
    maxNewTokens: 64,
  };
}

test('no model and no worker → stub mode, labelled placeholder naming the tier, never throws', async () => {
  const l = await createListener({});
  assert.equal(l.mode, 'stub');
  const r = await l.respond(req('reflection'));
  assert.equal(r.mode, 'stub');
  assert.equal(r.tier, 'reflection');
  assert.ok(r.text.includes('reflection'), `expected tier in "${r.text}"`);
  assert.ok(r.text.includes('not loaded'));
  l.close();
});

test('listenerStubText names the tier', () => {
  assert.equal(listenerStubText('question'), '⟨listener: question — LLM not loaded⟩');
});

test('healthy handshake → worker-backed mode and generated text', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'webgpu' }));
  w.onGenerate = (m) => queueMicrotask(() => w.emit('message', { type: 'result', id: m.id, text: '  say more about the floor  ' }));

  const l = await createListener({ createWorker: () => w, model: 'llama-1b' });
  assert.equal(l.mode, 'webgpu');
  const r = await l.respond(req('question'));
  assert.equal(r.text, 'say more about the floor'); // trimmed
  assert.equal(r.mode, 'webgpu');
  assert.equal(r.tier, 'question');
});

test('wasm handshake mode is accepted', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'wasm' }));
  const l = await createListener({ createWorker: () => w, model: 'x' });
  assert.equal(l.mode, 'wasm');
});

test('init error → degrade to stub and terminate the worker', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'error', reason: 'no model loaded' }));

  const l = await createListener({ createWorker: () => w, model: 'x' });
  assert.equal(l.mode, 'stub');
  assert.equal(w.terminated, true);
  const r = await l.respond(req('reflection'));
  assert.equal(r.mode, 'stub');
});

test('a per-call worker error degrades just that reply to the labelled stub', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'webgpu' }));
  w.onGenerate = (m) => queueMicrotask(() => w.emit('message', { type: 'result', id: m.id, text: '', error: true }));

  const l = await createListener({ createWorker: () => w, model: 'x' });
  assert.equal(l.mode, 'webgpu');
  const r = await l.respond(req('question'));
  assert.equal(r.mode, 'stub');
  assert.ok(r.text.includes('question'), `expected labelled stub, got "${r.text}"`);
});

test('an empty generation surfaces the labelled stub, not ∅', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'webgpu' }));
  w.onGenerate = (m) => queueMicrotask(() => w.emit('message', { type: 'result', id: m.id, text: '   ' }));

  const l = await createListener({ createWorker: () => w, model: 'x' });
  const r = await l.respond(req('reflection'));
  assert.equal(r.mode, 'stub');
  assert.ok(r.text.includes('not loaded'));
});

test('a silent worker times out per call → stub result', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'webgpu' }));
  // onGenerate intentionally unset: the worker never answers.

  const l = await createListener({ createWorker: () => w, model: 'x', timeoutMs: 30 });
  assert.equal(l.mode, 'webgpu');
  const r = await l.respond(req('reflection'));
  assert.equal(r.mode, 'stub');
  assert.ok(r.text.includes('not loaded'));
});

test('init timeout → stub (model load never reports ready)', async () => {
  const w = new FakeWorker();
  // onInit intentionally unset: no ready/error ever arrives.
  const l = await createListener({ createWorker: () => w, model: 'x', initTimeoutMs: 30 });
  assert.equal(l.mode, 'stub');
});

test('a worker factory that throws → stub', async () => {
  const l = await createListener({
    createWorker: () => {
      throw new Error('spawn failed');
    },
    model: 'x',
  });
  assert.equal(l.mode, 'stub');
});

// ── diagnosability (su-lou.9) ──
//
// The listener used to degrade in total silence: the worker posts a `reason` for a
// failed load and the adapter dropped it, so "no WebGPU adapter", "the weights
// 404ed" and "nobody provisioned anything" all surfaced as the same stub text. That
// is how this bug reached an operator feel-test with no evidence to debug — and why
// the root cause filed against it (an fp32 model.onnx 404) turned out to be wrong.
// TTS learned the same lesson as su-lou.7; these lock it in on this side.

test('a failed load reports the worker reason instead of stubbing silently', async () => {
  const seen: string[] = [];
  const w = new FakeWorker();
  const reason = "no model loaded (webgpu/q4f16: skipped — no WebGPU adapter with 'shader-f16'; wasm/q4: OOM)";
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'error', reason }));

  const l = await createListener({ createWorker: () => w, model: 'x', onDiagnostic: (m) => seen.push(m) });
  assert.equal(l.mode, 'stub');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\[listener\] /);
  assert.match(seen[0], /shader-f16/); // the rung-by-rung causes survive the trip
  assert.match(seen[0], /labelled stub/);
});

test('an init timeout names itself', async () => {
  const seen: string[] = [];
  const w = new FakeWorker(); // never answers
  const l = await createListener({ createWorker: () => w, model: 'x', initTimeoutMs: 20, onDiagnostic: (m) => seen.push(m) });
  assert.equal(l.mode, 'stub');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /timed out after 20ms/);
});

test('an unusable handshake mode is reported, not silently accepted', async () => {
  const seen: string[] = [];
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'quantum' }));
  const l = await createListener({ createWorker: () => w, model: 'x', onDiagnostic: (m) => seen.push(m) });
  assert.equal(l.mode, 'stub');
  assert.match(seen[0], /unusable device mode \(quantum\)/);
});

test('a healthy load exposes its dtype and reports the rungs it skipped', async () => {
  const seen: string[] = [];
  const w = new FakeWorker();
  w.onInit = () =>
    queueMicrotask(() =>
      w.emit('message', {
        type: 'ready',
        mode: 'wasm',
        dtype: 'q4',
        notes: ["webgpu/q4f16: skipped — no WebGPU adapter with 'shader-f16'"],
      }),
    );

  const l = await createListener({ createWorker: () => w, model: 'x', onDiagnostic: (m) => seen.push(m) });
  assert.equal(l.mode, 'wasm');
  // Two rungs both report mode 'wasm'/'webgpu'; only the dtype says WHICH weights.
  assert.equal(l.dtype, 'q4');
  // Reported even though the load SUCCEEDED — landing on the slow rung is news.
  assert.equal(seen.length, 1);
  assert.match(seen[0], /loaded wasm\/q4 after skipping/);
  assert.match(seen[0], /shader-f16/);
});

test('a clean load on the top rung stays quiet', async () => {
  const seen: string[] = [];
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'webgpu', dtype: 'q4f16', notes: [] }));
  const l = await createListener({ createWorker: () => w, model: 'x', onDiagnostic: (m) => seen.push(m) });
  assert.equal(l.mode, 'webgpu');
  assert.equal(l.dtype, 'q4f16');
  assert.deepEqual(seen, []);
});
