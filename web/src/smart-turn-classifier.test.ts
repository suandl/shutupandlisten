// Tests for the smart-turn classifier core (smart-turn-classifier.ts) — the half that
// runs inside smart-turn.worker.ts.
//
// These tests exist BECAUSE of the hop off the main thread (su-viz2). The worker file
// itself is browser-only and untestable under `node --test`, so if the load-time
// assertion and the feature contract had moved into it with the inference, they would
// have stopped being checked at exactly the moment they got harder to reason about.
// They live here instead, in a DOM-free leaf the worker imports.
//
// The guarantees under test:
//   1. the model is fed the [1, 80, 800] Whisper features — not raw audio, and not a
//      window that varies with the segment length
//   2. v3's output is ALREADY a probability (its graph ends in Sigmoid); applying
//      sigmoid again would squash every verdict into [0.5, 0.73] and silently kill
//      the completionThreshold knob. Raw-logit and 2-class exports still map right.
//   3. THE LOAD-TIME ASSERTION: a graph that loads but cannot produce a usable score
//      is a FAILED LOAD, not a live classifier that degrades on every call. That
//      false-green is what su-lou.7/.8/.9 each turned out to be, three separate
//      times, and it is constraint #1 on su-viz2.
//   4. a per-call failure surfaces as a throw with a reason the worker can relay,
//      never as a fabricated verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  completionProbFrom,
  createSmartTurnClassifier,
  type FeatureClassifier,
} from './smart-turn-classifier.ts';
import { N_FRAMES, N_MELS } from './whisper-mel.ts';

const SR = 16000;
/** A speech-shaped segment of `ms` milliseconds (content is irrelevant here). */
const segment = (ms: number): Float32Array =>
  Float32Array.from({ length: Math.round((SR * ms) / 1000) }, (_, i) => Math.sin(i / 11) * 0.4);

/**
 * Records what the classifier feeds the model. The FIRST run is
 * createSmartTurnClassifier's load-time warmup, so `output` applies from the second
 * call on and `warmup` (a healthy score by default) stands in for it.
 */
function fakeClassifier(output: number[] | (() => Promise<number[]>), warmup: number[] = [0.5]) {
  const seen: Float32Array[] = [];
  let closed = 0;
  const classifier: FeatureClassifier = {
    async run(features: Float32Array) {
      seen.push(features);
      if (seen.length === 1) return warmup;
      return typeof output === 'function' ? await output() : output;
    },
    close() {
      closed++;
    },
  };
  return { classifier, seen, scoreCalls: () => seen.length - 1, closedCount: () => closed };
}

// ── output mapping ─────────────────────────────────────────────────────────────

test('a single output already in [0,1] is used AS the probability, not sigmoid-ed again', () => {
  // The regression this locks: sigmoid(0.99) = 0.729, so a double-sigmoid would
  // compress every real verdict into [0.5, 0.73] and no threshold could separate
  // "complete" from "incomplete" again.
  for (const p of [0, 0.0292, 0.5, 0.7434, 0.987, 1]) {
    assert.equal(completionProbFrom([p]), p);
  }
});

test('a single output outside [0,1] is treated as a raw logit', () => {
  assert.ok(Math.abs(completionProbFrom([0]) - 0) < 1e-12); // in-range: passthrough
  assert.ok(Math.abs(completionProbFrom([2]) - 0.8807970779778823) < 1e-9);
  assert.ok(Math.abs(completionProbFrom([-2]) - 0.11920292202211755) < 1e-9);
});

test('a two-value output is a 2-class head with index 1 = complete', () => {
  assert.ok(completionProbFrom([0, 5]) > 0.99);
  assert.ok(completionProbFrom([5, 0]) < 0.01);
  assert.ok(Math.abs(completionProbFrom([1, 1]) - 0.5) < 1e-12);
});

test('an empty output is an error, never a fabricated verdict', () => {
  assert.throws(() => completionProbFrom([]), /no output/);
});

test('a non-finite score is an error, not a clamped-looking verdict', () => {
  // clamp01(NaN) is NaN, and `NaN >= completionThreshold` is false — a NaN would
  // reach the detector as a silent, permanent "incomplete" veto that holds the turn
  // open forever. It must surface as a degrade instead.
  assert.throws(() => completionProbFrom([NaN]), /non-finite/);
  assert.throws(() => completionProbFrom([Infinity, 1]), /non-finite/);
});

// ── the feature contract ───────────────────────────────────────────────────────

test('the model is fed [1, 80, 800] Whisper features, not raw audio', async () => {
  const fake = fakeClassifier([0.87]);
  const classifier = await createSmartTurnClassifier({ createClassifier: async () => fake.classifier });
  assert.equal(fake.seen.length, 1, 'the graph is warmed once at load, before any speech');

  assert.equal(await classifier.score(segment(1200)), 0.87);
  assert.equal(fake.scoreCalls(), 1);
  for (const features of fake.seen) {
    assert.equal(features.length, N_MELS * N_FRAMES, 'the model must get log-Mel features, not raw audio');
  }

  classifier.close();
  assert.equal(fake.closedCount(), 1, 'close() must release the session');
});

test('the feature window is fixed-size however long the segment is', async () => {
  const fake = fakeClassifier([0.5]);
  const classifier = await createSmartTurnClassifier({ createClassifier: async () => fake.classifier });
  for (const ms of [80, 2400, 30000]) await classifier.score(segment(ms));
  assert.equal(fake.scoreCalls(), 3);
  for (const features of fake.seen) assert.equal(features.length, N_MELS * N_FRAMES);
  classifier.close();
});

// ── the load-time assertion (su-viz2 constraint #1) ────────────────────────────

test('a model that loads but cannot score is a FAILED LOAD, not a live classifier', async () => {
  // The false-green su-lou.7/.8/.9 each turned out to be: the stage reports its real
  // backend at load, then falls back on every single call. Warming the graph at load
  // turns that into an honest failure BEFORE the worker answers `ready`, so the
  // adapter says `heuristic` before the first utterance.
  for (const badWarmup of [[], [NaN]]) {
    const fake = fakeClassifier([0.9], badWarmup);
    await assert.rejects(
      () => createSmartTurnClassifier({ createClassifier: async () => fake.classifier }),
      /could not score/,
      `warmup output ${JSON.stringify(badWarmup)} must fail the load`,
    );
    assert.equal(fake.closedCount(), 1, 'a session that cannot score must be released');
  }
});

test('a session that fails to load names why, so the worker can relay it', async () => {
  await assert.rejects(
    () =>
      createSmartTurnClassifier({
        createClassifier: async () => {
          throw new Error('404 fetching the model');
        },
      }),
    /model failed to load \(404 fetching the model\)/,
  );
});

test('a warmup that never settles is bounded, not waited on forever', async () => {
  let closed = 0;
  await assert.rejects(
    () =>
      createSmartTurnClassifier({
        initTimeoutMs: 20,
        createClassifier: async () => ({
          run: () => new Promise<number[]>(() => {}),
          close() {
            closed++;
          },
        }),
      }),
    /timed out after 20ms/,
  );
  assert.equal(closed, 1, 'the wedged session is released rather than left holding the thread');
});

// ── per-call failures ──────────────────────────────────────────────────────────

test('a per-call failure throws with a reason rather than fabricating a verdict', async () => {
  const fake = fakeClassifier(async () => {
    throw new Error('shape mismatch');
  });
  const classifier = await createSmartTurnClassifier({ createClassifier: async () => fake.classifier });
  await assert.rejects(() => classifier.score(segment(1200)), /shape mismatch/);
  classifier.close();
});

test('an unmappable output throws instead of reaching the detector as a silent veto', async () => {
  for (const out of [[], [NaN], [Infinity, 1]]) {
    const fake = fakeClassifier(out);
    const classifier = await createSmartTurnClassifier({ createClassifier: async () => fake.classifier });
    await assert.rejects(() => classifier.score(segment(900)), /no output|non-finite/);
    classifier.close();
  }
});

test('a throwing close is swallowed — teardown must not propagate', async () => {
  const classifier = await createSmartTurnClassifier({
    createClassifier: async () => ({
      async run() {
        return [0.5];
      },
      close() {
        throw new Error('release failed');
      },
    }),
  });
  classifier.close(); // must not throw — stop() runs this during teardown
});
