// Tests for the smart-turn EOU adapter (smart-turn.ts).
//
// The guarantees under test:
//   1. no model configured → the labelled duration heuristic, unchanged (an
//      un-provisioned deploy / CI must still run)
//   2. a configured model reports mode `model` and is fed the [1, 80, 800] Whisper
//      features — not raw audio, which is what the adapter used to send
//   3. v3's output is ALREADY a probability (its graph ends in Sigmoid); applying
//      sigmoid again would squash every verdict into [0.5, 0.73] and silently kill
//      the completionThreshold knob. Raw-logit and 2-class exports still map right.
//   4. every degrade is REPORTED and reflected in the per-call result mode — a load
//      failure, a per-call throw, a wedged session, a wrong sample rate. A stage
//      claiming `model` while running the heuristic is the exact bug class
//      su-lou.10.1 exists to close (cf. su-lou.7/.8/.9).
//   5. predict never throws, whatever the classifier does

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { completionProbFrom, createSmartTurn, type FeatureClassifier } from './smart-turn.ts';
import { N_FRAMES, N_MELS } from './whisper-mel.ts';

const SR = 16000;
/** A speech-shaped segment of `ms` milliseconds (content is irrelevant here). */
const segment = (ms: number): Float32Array =>
  Float32Array.from({ length: Math.round((SR * ms) / 1000) }, (_, i) => Math.sin(i / 11) * 0.4);

/**
 * Records what the adapter feeds the model. The FIRST run is createSmartTurn's
 * load-time warmup, so `output` applies from the second call on and `warmup` (a
 * healthy score by default) stands in for it.
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
  return { classifier, seen, predictCalls: () => seen.length - 1, closedCount: () => closed };
}

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

// ── the model path ─────────────────────────────────────────────────────────────

test('a configured model reports `model` and is fed [1, 80, 800] Whisper features', async () => {
  const fake = fakeClassifier([0.87]);
  const st = await createSmartTurn({ createClassifier: async () => fake.classifier });
  assert.equal(st.mode, 'model');
  assert.equal(fake.seen.length, 1, 'the graph is warmed once at load, before any speech');

  const r = await st.predict(segment(1200), SR);
  assert.equal(r.mode, 'model');
  assert.equal(r.completionProb, 0.87);
  assert.equal(fake.predictCalls(), 1);
  for (const features of fake.seen) {
    assert.equal(features.length, N_MELS * N_FRAMES, 'the model must get log-Mel features, not raw audio');
  }

  st.close();
  assert.equal(fake.closedCount(), 1, 'close() must release the session');
});

test('a model that loads but cannot score is a FAILED LOAD, not a `model` that degrades', async () => {
  // The false-green su-lou.7/.8/.9 each turned out to be: the stage reports its real
  // backend at load, then falls back on every single call. Warming the graph at load
  // turns that into an honest `heuristic` before the first utterance.
  const diagnostics: string[] = [];
  for (const badWarmup of [[], [NaN]]) {
    const fake = fakeClassifier([0.9], badWarmup);
    const st = await createSmartTurn({
      createClassifier: async () => fake.classifier,
      onDiagnostic: (m) => diagnostics.push(m),
    });
    assert.equal(st.mode, 'heuristic');
    assert.equal(fake.closedCount(), 1, 'a session that cannot score must be released');
    st.close();
  }
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0], /could not score/);
});

test('the feature window is fixed-size however long the segment is', async () => {
  const fake = fakeClassifier([0.5]);
  const st = await createSmartTurn({ createClassifier: async () => fake.classifier });
  for (const ms of [80, 2400, 30000]) await st.predict(segment(ms), SR);
  assert.equal(fake.predictCalls(), 3);
  for (const features of fake.seen) assert.equal(features.length, N_MELS * N_FRAMES);
  st.close();
});

// ── degrades: reported, and visible in the per-call mode ───────────────────────

test('a model that fails to load degrades to the heuristic and says why', async () => {
  const diagnostics: string[] = [];
  const st = await createSmartTurn({
    createClassifier: async () => {
      throw new Error('404 fetching the model');
    },
    onDiagnostic: (m) => diagnostics.push(m),
  });
  assert.equal(st.mode, 'heuristic');
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /404 fetching the model/);
  assert.match(diagnostics[0], /heuristic/);
  st.close();
});

test('a per-call failure degrades THAT verdict, and the result says heuristic', async () => {
  const diagnostics: string[] = [];
  const fake = fakeClassifier(async () => {
    throw new Error('shape mismatch');
  });
  const st = await createSmartTurn({
    createClassifier: async () => fake.classifier,
    onDiagnostic: (m) => diagnostics.push(m),
  });
  assert.equal(st.mode, 'model');
  const r = await st.predict(segment(1200), SR);
  // The adapter still holds a session, but THIS verdict came from the heuristic —
  // which is what the works-check reads to catch a false-green load.
  assert.equal(r.mode, 'heuristic');
  assert.ok(r.completionProb > 0 && r.completionProb <= 1);
  await st.predict(segment(1200), SR);
  assert.equal(diagnostics.length, 1, 'a repeated per-call failure must not spam the console');
  st.close();
});

test('a wedged session times out instead of holding the turn open', async () => {
  const diagnostics: string[] = [];
  let calls = 0;
  const st = await createSmartTurn({
    timeoutMs: 20,
    createClassifier: async () => ({
      // Warms fine, then wedges — a session that dies mid-session, which the
      // load-time warmup by construction cannot catch.
      run: () => (++calls === 1 ? Promise.resolve([0.5]) : new Promise<number[]>(() => {})),
      close() {},
    }),
    onDiagnostic: (m) => diagnostics.push(m),
  });
  assert.equal(st.mode, 'model');
  const r = await st.predict(segment(1200), SR);
  assert.equal(r.mode, 'heuristic');
  assert.match(diagnostics[0], /timed out/);
  st.close();
});

test('audio at the wrong rate degrades loudly rather than being silently resampled', async () => {
  const diagnostics: string[] = [];
  const fake = fakeClassifier([0.9]);
  const st = await createSmartTurn({
    createClassifier: async () => fake.classifier,
    onDiagnostic: (m) => diagnostics.push(m),
  });
  const r = await st.predict(segment(1200), 48000);
  assert.equal(r.mode, 'heuristic');
  assert.equal(fake.predictCalls(), 0, 'nothing should reach the model at the wrong rate');
  assert.match(diagnostics[0], /16000Hz/);
  st.close();
});

test('predict never throws, whatever the classifier returns', async () => {
  const outputs: Array<number[]> = [[], [NaN], [Infinity, 1]];
  for (const out of outputs) {
    // Warms healthily, so this exercises the per-call path rather than the load one.
    const st = await createSmartTurn({
      createClassifier: async () => fakeClassifier(out).classifier,
      onDiagnostic: () => {},
    });
    const r = await st.predict(segment(900), SR);
    assert.ok(Number.isFinite(r.completionProb), `output ${JSON.stringify(out)} produced ${r.completionProb}`);
    assert.ok(r.completionProb >= 0 && r.completionProb <= 1);
    st.close();
  }
});

test('close() on a heuristic adapter is safe, and a throwing close is swallowed', async () => {
  const heuristic = await createSmartTurn();
  heuristic.close();
  const st = await createSmartTurn({
    createClassifier: async () => ({
      async run() {
        return [0.5];
      },
      close() {
        throw new Error('release failed');
      },
    }),
  });
  assert.equal(st.mode, 'model');
  st.close(); // must not propagate — stop() runs this during teardown
});
