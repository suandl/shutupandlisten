// Tests for the denoise adapter (denoise.ts).
//
// The adapter's whole job is to never block the harness: it ATTEMPTS a real
// same-origin denoise engine and, on any failure, degrades to a transparent
// PASSTHROUGH that returns no stream (the caller then lets the VAD capture the
// raw mic, byte-identical to the pre-denoise path). The real-time AudioWorklet
// engine is browser-only and validated in the feel-test; node has no Web Audio.
// So — exactly like stt.test.ts injects a FakeWorker — these tests inject fake
// Web-Audio seams (getUserMedia / AudioContext / engine loader) and assert the
// mode, the produced stream, the graph wiring, teardown, and every fallback.
//
// The guarantees under test:
//   1. no engine configured        → passthrough, mic never acquired
//   2. ?denoise=off (disabled)     → passthrough, engine never loaded
//   3. engine absent (load → null) → passthrough, mic never acquired
//   4. engine load throws / times out → passthrough
//   5. a malformed / passthrough-mode engine → passthrough
//   6. healthy engine → engine mode + denoised stream + mic→node→dest graph
//   7. mic denied / node build throws → passthrough, with no leaked mic/context

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDenoiser } from './denoise.ts';
import type {
  AudioContextLike,
  AudioNodeLike,
  DenoiseEngineModule,
  MediaStreamDestinationLike,
  MediaStreamLike,
} from './denoise.ts';

// ── fakes ──

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream implements MediaStreamLike {
  readonly tracks: FakeTrack[];
  constructor(n = 1) {
    this.tracks = Array.from({ length: n }, () => new FakeTrack());
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  allStopped(): boolean {
    return this.tracks.every((t) => t.stopped);
  }
}

class FakeNode implements AudioNodeLike {
  readonly connectedTo: AudioNodeLike[] = [];
  connect(destination: AudioNodeLike): AudioNodeLike {
    this.connectedTo.push(destination);
    return destination;
  }
  disconnect(): void {
    /* no-op */
  }
}

class FakeDestination extends FakeNode implements MediaStreamDestinationLike {
  readonly stream = new FakeStream(1);
}

class FakeAudioContext implements AudioContextLike {
  readonly sampleRate?: number;
  readonly sourceNode = new FakeNode();
  readonly dest = new FakeDestination();
  sourcedFrom: MediaStreamLike | null = null;
  closed = false;
  constructor(sampleRate?: number) {
    this.sampleRate = sampleRate;
  }
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike {
    this.sourcedFrom = stream;
    return this.sourceNode;
  }
  createMediaStreamDestination(): MediaStreamDestinationLike {
    return this.dest;
  }
  close(): void {
    this.closed = true;
  }
}

/** A healthy engine whose createNode returns a captured node so tests can assert wiring. */
function fakeEngine(node: FakeNode, sampleRate?: number): DenoiseEngineModule {
  return {
    mode: 'rnnoise',
    sampleRate,
    createNode: async () => node,
  };
}

test('no engine configured → passthrough, mic never acquired', async () => {
  let gum = 0;
  const d = await createDenoiser({
    getUserMedia: async () => {
      gum++;
      return new FakeStream();
    },
  });
  assert.equal(d.mode, 'passthrough');
  assert.equal(d.stream, undefined);
  assert.equal(gum, 0, 'passthrough must not touch the microphone');
  d.close(); // must be safe
});

test('?denoise=off (disabled) → passthrough, engine never loaded', async () => {
  let loaded = 0;
  let gum = 0;
  const d = await createDenoiser({
    disabled: true,
    engineUrl: '/denoise-engine.js',
    loadEngine: async () => {
      loaded++;
      return fakeEngine(new FakeNode());
    },
    getUserMedia: async () => {
      gum++;
      return new FakeStream();
    },
  });
  assert.equal(d.mode, 'passthrough');
  assert.equal(d.stream, undefined);
  assert.equal(loaded, 0, 'disabled must short-circuit before loading the engine');
  assert.equal(gum, 0);
});

test('engine absent (load → null) → passthrough, mic never acquired', async () => {
  let gum = 0;
  const d = await createDenoiser({
    engineUrl: '/denoise-engine.js',
    loadEngine: async () => null,
    getUserMedia: async () => {
      gum++;
      return new FakeStream();
    },
  });
  assert.equal(d.mode, 'passthrough');
  assert.equal(d.stream, undefined);
  assert.equal(gum, 0, 'no engine → never open the mic');
});

test('engine load throws → passthrough', async () => {
  const d = await createDenoiser({
    engineUrl: '/denoise-engine.js',
    loadEngine: async () => {
      throw new Error('import failed');
    },
  });
  assert.equal(d.mode, 'passthrough');
  assert.equal(d.stream, undefined);
});

test('engine load times out → passthrough', async () => {
  const d = await createDenoiser({
    engineUrl: '/denoise-engine.js',
    timeoutMs: 5,
    loadEngine: () => new Promise<DenoiseEngineModule>(() => {}), // never resolves
  });
  assert.equal(d.mode, 'passthrough');
  assert.equal(d.stream, undefined);
});

test('a malformed / passthrough-mode engine → passthrough', async () => {
  const bad = { mode: 'passthrough', createNode: async () => new FakeNode() } as unknown as DenoiseEngineModule;
  const d = await createDenoiser({
    engineUrl: '/denoise-engine.js',
    loadEngine: async () => bad,
  });
  assert.equal(d.mode, 'passthrough');
  assert.equal(d.stream, undefined);
});

test('healthy engine → engine mode + denoised stream + mic→node→dest graph', async () => {
  const denoiseNode = new FakeNode();
  const mic = new FakeStream(2);
  let ctx: FakeAudioContext | null = null;
  const seenSampleRates: Array<number | undefined> = [];

  const d = await createDenoiser({
    engineUrl: '/denoise-engine.js',
    loadEngine: async () => fakeEngine(denoiseNode, 48000),
    getUserMedia: async () => mic,
    createAudioContext: (sr) => {
      seenSampleRates.push(sr);
      ctx = new FakeAudioContext(sr);
      return ctx;
    },
  });

  assert.equal(d.mode, 'rnnoise');
  assert.ok(ctx, 'an AudioContext was created');
  const c = ctx as unknown as FakeAudioContext;
  assert.deepEqual(seenSampleRates, [48000], 'context is created at the engine sample rate');
  assert.equal(d.stream, c.dest.stream, 'the VAD is fed the denoised destination stream');
  assert.equal(c.sourcedFrom, mic, 'the graph source is the raw mic');
  assert.equal(c.sourceNode.connectedTo[0], denoiseNode, 'mic source → denoise node');
  assert.equal(denoiseNode.connectedTo[0], c.dest, 'denoise node → destination');

  // close() releases the mic and the context.
  d.close();
  assert.ok(mic.allStopped(), 'mic tracks stopped on close');
  assert.equal(c.closed, true, 'audio context closed on close');
});

test('mic denied → passthrough, nothing leaked', async () => {
  let ctxCreated = 0;
  const d = await createDenoiser({
    engineUrl: '/denoise-engine.js',
    loadEngine: async () => fakeEngine(new FakeNode()),
    getUserMedia: async () => {
      throw new Error('NotAllowedError');
    },
    createAudioContext: () => {
      ctxCreated++;
      return new FakeAudioContext();
    },
  });
  assert.equal(d.mode, 'passthrough');
  assert.equal(d.stream, undefined);
  assert.equal(ctxCreated, 0, 'mic is acquired before the context, so none is created');
});

test('engine node build throws → passthrough, mic + context torn down', async () => {
  const mic = new FakeStream(1);
  let ctx: FakeAudioContext | null = null;
  const d = await createDenoiser({
    engineUrl: '/denoise-engine.js',
    loadEngine: async () => ({
      mode: 'rnnoise',
      createNode: async () => {
        throw new Error('addModule 404');
      },
    }),
    getUserMedia: async () => mic,
    createAudioContext: () => {
      ctx = new FakeAudioContext();
      return ctx;
    },
  });
  assert.equal(d.mode, 'passthrough');
  assert.equal(d.stream, undefined);
  assert.ok(mic.allStopped(), 'mic released when the graph fails to build');
  assert.equal((ctx as unknown as FakeAudioContext).closed, true, 'context closed when the graph fails to build');
});
