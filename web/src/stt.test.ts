// Tests for the STT adapter's load-or-degrade behaviour (stt.ts).
//
// The real model runs in a browser Web Worker, so here we drive a FAKE worker to
// exercise every fallback edge headlessly: no model → stub, init failure → stub,
// a healthy handshake → worker text, a per-segment error/timeout → stub for that
// segment. The contract under test is "createTranscriber NEVER throws and always
// resolves a result" — the same defensive promise smart-turn makes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTranscriber, stubText } from './stt.ts';
import type { WorkerLike } from './stt.ts';

class FakeWorker implements WorkerLike {
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;
  onInit?: (msg: Record<string, unknown>) => void;
  onTranscribe?: (msg: Record<string, unknown>) => void;
  private readonly listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};

  postMessage(message: unknown): void {
    const m = message as Record<string, unknown>;
    this.posted.push(m);
    if (m.type === 'init') this.onInit?.(m);
    else if (m.type === 'transcribe') this.onTranscribe?.(m);
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

test('no model and no worker → stub mode, labelled placeholder, never throws', async () => {
  const t = await createTranscriber({});
  assert.equal(t.mode, 'stub');
  const r = await t.transcribe(new Float32Array(16000), 16000); // 1.0s @ 16kHz
  assert.equal(r.mode, 'stub');
  assert.ok(r.text.includes('1.0s'), `expected duration in "${r.text}"`);
  assert.ok(r.text.includes('not loaded'));
  t.close();
});

test('stubText reports segment duration', () => {
  assert.equal(stubText(2500), '⟨speech 2.5s — STT model not loaded⟩');
});

test('healthy handshake → worker-backed mode and text', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'moonshine' }));
  w.onTranscribe = (m) => queueMicrotask(() => w.emit('message', { type: 'result', id: m.id, text: 'hello world' }));

  const t = await createTranscriber({ createWorker: () => w, moonshineModel: 'moonshine-tiny' });
  assert.equal(t.mode, 'moonshine');
  const r = await t.transcribe(new Float32Array(8000), 16000);
  assert.equal(r.text, 'hello world');
  assert.equal(r.mode, 'moonshine');
});

test('init error → degrade to stub and terminate the worker', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'error', reason: 'no model loaded' }));

  const t = await createTranscriber({ createWorker: () => w, moonshineModel: 'x' });
  assert.equal(t.mode, 'stub');
  assert.equal(w.terminated, true);
  const r = await t.transcribe(new Float32Array(16000), 16000);
  assert.equal(r.mode, 'stub'); // the stub still transcribes
});

test('a per-segment worker error degrades just that segment to stub', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'whisper' }));
  w.onTranscribe = (m) => queueMicrotask(() => w.emit('message', { type: 'result', id: m.id, text: '', error: true }));

  const t = await createTranscriber({ createWorker: () => w, whisperModel: 'whisper-small' });
  assert.equal(t.mode, 'whisper');
  const r = await t.transcribe(new Float32Array(16000), 16000);
  assert.equal(r.mode, 'stub');
  assert.equal(r.text, '');
});

test('a silent worker times out per segment → stub result', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'moonshine' }));
  // onTranscribe intentionally unset: the worker never answers.

  const t = await createTranscriber({ createWorker: () => w, moonshineModel: 'x', timeoutMs: 30 });
  assert.equal(t.mode, 'moonshine');
  const r = await t.transcribe(new Float32Array(16000), 16000);
  assert.equal(r.mode, 'stub');
  assert.ok(r.text.includes('not loaded'));
});

test('a worker factory that throws → stub', async () => {
  const t = await createTranscriber({
    createWorker: () => {
      throw new Error('spawn failed');
    },
    moonshineModel: 'x',
  });
  assert.equal(t.mode, 'stub');
});
