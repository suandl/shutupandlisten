// Tests for the TTS adapter's load-or-degrade behaviour (tts.ts).
//
// The real model runs in a browser Web Worker on CPU/WASM, so here we drive a FAKE
// worker to exercise every fallback edge headlessly: no model → stub tone, init
// failure → stub, a healthy handshake → worker PCM, a per-call error/empty/timeout
// → the placeholder tone. The contract under test — the same defensive promise STT
// and the listener make — is "createSpeaker NEVER throws and synthesize always
// resolves a result" (here, always with playable-or-empty audio, never a rejection).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpeaker, speakerStubAudio, STUB_SAMPLE_RATE } from './tts.ts';
import type { WorkerLike } from './tts.ts';

class FakeWorker implements WorkerLike {
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;
  onInit?: (msg: Record<string, unknown>) => void;
  onSynthesize?: (msg: Record<string, unknown>) => void;
  private readonly listeners: Record<string, Array<(ev: { data?: unknown }) => void>> = {};

  postMessage(message: unknown): void {
    const m = message as Record<string, unknown>;
    this.posted.push(m);
    if (m.type === 'init') this.onInit?.(m);
    else if (m.type === 'synthesize') this.onSynthesize?.(m);
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

const pcm = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => Math.sin(i));

test('speakerStubAudio: non-empty text → a deterministic tone at the stub rate', () => {
  const a = speakerStubAudio('mm');
  const b = speakerStubAudio('mm');
  assert.equal(a.sampleRate, STUB_SAMPLE_RATE);
  assert.ok(a.audio.length > 0, 'a non-empty reply produces audible audio');
  assert.deepEqual([...a.audio], [...b.audio], 'the stub tone is deterministic (pure)');
  for (const s of a.audio) assert.ok(s >= -0.2 && s <= 0.2, 'the tone stays quiet');
});

test('speakerStubAudio: longer text → longer (but capped) audio', () => {
  const short = speakerStubAudio('mm').audio.length;
  const long = speakerStubAudio('a much longer reflection that keeps going').audio.length;
  const capped = speakerStubAudio('x'.repeat(500)).audio.length;
  assert.ok(long > short, 'a longer reply sounds a little longer');
  assert.ok(capped <= STUB_SAMPLE_RATE * 1.2, 'length is capped so it never drones');
});

test('speakerStubAudio: empty text → empty audio (nothing to say)', () => {
  assert.equal(speakerStubAudio('').audio.length, 0);
  assert.equal(speakerStubAudio('   ').audio.length, 0);
});

test('no model and no worker → stub mode, synthesize returns the placeholder tone, never throws', async () => {
  const s = await createSpeaker({});
  assert.equal(s.mode, 'stub');
  const r = await s.synthesize('yeah');
  assert.equal(r.mode, 'stub');
  assert.equal(r.text, 'yeah');
  assert.equal(r.sampleRate, STUB_SAMPLE_RATE);
  assert.ok(r.audio.length > 0);
  s.close();
});

test('healthy handshake → worker-backed mode and the worker PCM', async () => {
  const w = new FakeWorker();
  const audio = pcm(1600);
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'wasm' }));
  w.onSynthesize = (m) =>
    queueMicrotask(() => w.emit('message', { type: 'result', id: m.id, audio, sampleRate: 24000 }));

  const s = await createSpeaker({ createWorker: () => w, model: 'mms-tts' });
  assert.equal(s.mode, 'wasm');
  const r = await s.synthesize('say the reflection aloud');
  assert.equal(r.mode, 'wasm');
  assert.equal(r.sampleRate, 24000);
  assert.equal(r.audio.length, 1600);
  assert.equal(r.text, 'say the reflection aloud');
});

test('webgpu handshake mode is accepted', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'webgpu' }));
  const s = await createSpeaker({ createWorker: () => w, model: 'x' });
  assert.equal(s.mode, 'webgpu');
});

test('init error → degrade to stub, terminate the worker, and SURFACE the reason (su-lou.7)', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'error', reason: 'no model loaded' }));
  const diagnostics: string[] = [];

  const s = await createSpeaker({ createWorker: () => w, model: 'x', onDiagnostic: (m) => diagnostics.push(m) });
  assert.equal(s.mode, 'stub');
  assert.equal(w.terminated, true);
  // The worker's reason used to be swallowed (silent degrade → mystery tone); it must
  // now reach the diagnostic sink so a 404ing model asset names itself.
  assert.ok(
    diagnostics.some((m) => m.includes('no model loaded')),
    `the worker reason must be surfaced; got ${JSON.stringify(diagnostics)}`,
  );
  const r = await s.synthesize('reflection');
  assert.equal(r.mode, 'stub');
  assert.ok(r.audio.length > 0);
});

test('a healthy handshake reports NO diagnostic (only failures are surfaced)', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'wasm' }));
  const diagnostics: string[] = [];
  const s = await createSpeaker({ createWorker: () => w, model: 'x', onDiagnostic: (m) => diagnostics.push(m) });
  assert.equal(s.mode, 'wasm');
  assert.deepEqual(diagnostics, [], 'a successful load must stay quiet');
});

test('a per-call worker error degrades just that reply to the placeholder tone', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'wasm' }));
  w.onSynthesize = (m) => queueMicrotask(() => w.emit('message', { type: 'result', id: m.id, error: true }));

  const s = await createSpeaker({ createWorker: () => w, model: 'x' });
  assert.equal(s.mode, 'wasm');
  const r = await s.synthesize('mm');
  assert.equal(r.mode, 'stub');
  assert.ok(r.audio.length > 0, 'a failed synthesis still yields an audible cue');
});

test('an empty / rateless waveform surfaces the placeholder tone, not silence', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'wasm' }));
  // A zero-length buffer, and a valid buffer with no sample rate — both are unusable.
  w.onSynthesize = (m) =>
    queueMicrotask(() => w.emit('message', { type: 'result', id: m.id, audio: pcm(0), sampleRate: 24000 }));

  const s = await createSpeaker({ createWorker: () => w, model: 'x' });
  const r = await s.synthesize('right');
  assert.equal(r.mode, 'stub');
  assert.ok(r.audio.length > 0);
});

test('a silent worker times out per call → stub tone', async () => {
  const w = new FakeWorker();
  w.onInit = () => queueMicrotask(() => w.emit('message', { type: 'ready', mode: 'wasm' }));
  // onSynthesize intentionally unset: the worker never answers.

  const s = await createSpeaker({ createWorker: () => w, model: 'x', timeoutMs: 30 });
  assert.equal(s.mode, 'wasm');
  const r = await s.synthesize('mhm');
  assert.equal(r.mode, 'stub');
  assert.ok(r.audio.length > 0);
});

test('init timeout → stub, and the timeout names itself', async () => {
  const w = new FakeWorker();
  // onInit intentionally unset: no ready/error ever arrives.
  const diagnostics: string[] = [];
  const s = await createSpeaker({ createWorker: () => w, model: 'x', initTimeoutMs: 30, onDiagnostic: (m) => diagnostics.push(m) });
  assert.equal(s.mode, 'stub');
  assert.ok(diagnostics.some((m) => /timed out/.test(m)), `a load timeout must name itself; got ${JSON.stringify(diagnostics)}`);
});

test('a worker factory that throws → stub, naming the spawn failure', async () => {
  const diagnostics: string[] = [];
  const s = await createSpeaker({
    createWorker: () => {
      throw new Error('spawn failed');
    },
    model: 'x',
    onDiagnostic: (m) => diagnostics.push(m),
  });
  assert.equal(s.mode, 'stub');
  assert.ok(diagnostics.some((m) => /failed to start/.test(m)), `a spawn failure must name itself; got ${JSON.stringify(diagnostics)}`);
});
