// Tests for the warmed-loop instrumentation (loop-metrics.ts) — a pure per-stage
// latency recorder, in the same test discipline as measurement.ts.
//
// The guarantees under test:
//   1. the timed legs are exactly the consecutive stages of the pipeline
//   2. a fully-spoken turn yields all four leg deltas + a turn-end→speech-start total
//   3. a stage recorded once is not overwritten by a later render's clock (first-write-wins)
//   4. a turn missing a stage (e.g. a silent turn, never spoken) omits the legs that
//      touch it and reports total null — it is not counted as a completed loop
//   5. the summary means each leg over the turns that recorded it, and the total over
//      spoken turns only
//   6. clear(turn) forgets one turn — the escape hatch from first-write-wins for a
//      patience window that closed and was then abandoned (the thinker resumed)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LoopMetrics, LOOP_LEGS, LOOP_STAGES, legKey } from './loop-metrics.ts';

test('LOOP_LEGS are the consecutive stages of the pipeline', () => {
  assert.deepEqual(LOOP_STAGES, ['turn-end', 'transcript', 'gate', 'reply', 'speech-start']);
  assert.deepEqual(LOOP_LEGS, [
    { from: 'turn-end', to: 'transcript' },
    { from: 'transcript', to: 'gate' },
    { from: 'gate', to: 'reply' },
    { from: 'reply', to: 'speech-start' },
  ]);
});

test('a fully-spoken turn yields all four leg deltas + a total', () => {
  const m = new LoopMetrics();
  m.mark(1, 'turn-end', 1000);
  m.mark(1, 'transcript', 1300); // +300 STT
  m.mark(1, 'gate', 1305); //       +5   gate
  m.mark(1, 'reply', 1905); //      +600 LLM
  m.mark(1, 'speech-start', 2000); // +95 TTS

  const tl = m.turnLatency(1);
  assert.ok(tl);
  assert.equal(tl.totalMs, 1000); // 2000 - 1000
  const byKey = Object.fromEntries(tl.legs.map((l) => [legKey(l.from, l.to), l.ms]));
  assert.deepEqual(byKey, {
    'turn-end→transcript': 300,
    'transcript→gate': 5,
    'gate→reply': 600,
    'reply→speech-start': 95,
  });
});

test('first-write-wins: re-marking a stage keeps the original timestamp', () => {
  const m = new LoopMetrics();
  m.mark(1, 'turn-end', 1000);
  m.mark(1, 'turn-end', 9999); // a later render must not clobber the real stage time
  m.mark(1, 'speech-start', 1500);
  assert.equal(m.turnLatency(1)?.totalMs, 500);
  assert.equal(m.has(1, 'turn-end'), true);
  assert.equal(m.has(1, 'reply'), false);
});

test('a silent turn (no reply / no speech) omits the downstream legs and has no total', () => {
  const m = new LoopMetrics();
  m.mark(2, 'turn-end', 500);
  m.mark(2, 'transcript', 700);
  m.mark(2, 'gate', 705); // gate decided silence → never speaks

  const tl = m.turnLatency(2);
  assert.ok(tl);
  assert.equal(tl.totalMs, null);
  assert.deepEqual(
    tl.legs.map((l) => legKey(l.from, l.to)),
    ['turn-end→transcript', 'transcript→gate'],
  );
});

test('a missing intermediate stage omits only the legs touching it; the total still spans end→speech', () => {
  const m = new LoopMetrics();
  m.mark(3, 'turn-end', 0);
  // transcript mark dropped (e.g. an ack path that read the gate straight off cache)
  m.mark(3, 'gate', 40);
  m.mark(3, 'reply', 45);
  m.mark(3, 'speech-start', 120);

  const tl = m.turnLatency(3);
  assert.ok(tl);
  assert.equal(tl.totalMs, 120);
  assert.deepEqual(
    tl.legs.map((l) => legKey(l.from, l.to)),
    ['gate→reply', 'reply→speech-start'], // turn-end→transcript and transcript→gate both dropped
  );
});

test('turnLatency is null for an unseen turn', () => {
  assert.equal(new LoopMetrics().turnLatency(42), null);
});

test('turns() and all() are ascending by turn', () => {
  const m = new LoopMetrics();
  m.mark(3, 'turn-end', 30);
  m.mark(1, 'turn-end', 10);
  m.mark(2, 'turn-end', 20);
  assert.deepEqual(m.turns(), [1, 2, 3]);
  assert.deepEqual(
    m.all().map((t) => t.turn),
    [1, 2, 3],
  );
});

test('summary means each leg over recording turns and the total over spoken turns', () => {
  const m = new LoopMetrics();
  // turn 1: spoken, STT 200
  m.mark(1, 'turn-end', 0);
  m.mark(1, 'transcript', 200);
  m.mark(1, 'gate', 200);
  m.mark(1, 'reply', 300);
  m.mark(1, 'speech-start', 400); // total 400
  // turn 2: spoken, STT 400
  m.mark(2, 'turn-end', 0);
  m.mark(2, 'transcript', 400);
  m.mark(2, 'gate', 400);
  m.mark(2, 'reply', 500);
  m.mark(2, 'speech-start', 600); // total 600
  // turn 3: silent — turn-end + transcript + gate only, never spoken
  m.mark(3, 'turn-end', 0);
  m.mark(3, 'transcript', 100);
  m.mark(3, 'gate', 100);

  const s = m.summary();
  assert.equal(s.turns, 3);
  assert.equal(s.completed, 2); // only the two spoken turns
  assert.equal(s.meanTotalMs, 500); // (400 + 600) / 2
  // turn-end→transcript recorded on all three turns: (200 + 400 + 100) / 3 = 233
  assert.equal(s.meanLegMs[legKey('turn-end', 'transcript')], 233);
  // reply→speech-start recorded on the two spoken turns: (100 + 100) / 2 = 100
  assert.equal(s.meanLegMs[legKey('reply', 'speech-start')], 100);
});

test('an empty recorder summarizes to zeros / null', () => {
  const s = new LoopMetrics().summary();
  assert.deepEqual(s, { turns: 0, completed: 0, meanLegMs: {}, meanTotalMs: null });
});

test('reset drops all recorded marks', () => {
  const m = new LoopMetrics();
  m.mark(1, 'turn-end', 0);
  m.reset();
  assert.deepEqual(m.turns(), []);
  assert.equal(m.turnLatency(1), null);
});

test('clear(turn) frees an abandoned turn to be re-marked, and leaves other turns alone', () => {
  const m = new LoopMetrics();
  m.mark(1, 'turn-end', 1000); // patience window closed…
  m.mark(2, 'turn-end', 8000);
  m.clear(1); // …then the thinker resumed: that iteration never happened

  assert.deepEqual(m.turns(), [2], 'the abandoned turn is gone');
  // The escape from first-write-wins: the turn's REAL window close now sticks.
  m.mark(1, 'turn-end', 5000);
  m.mark(1, 'speech-start', 5400);
  assert.equal(m.turnLatency(1)?.totalMs, 400, 'measured from the real close (5000), not the abandoned one');
  assert.equal(m.has(2, 'turn-end'), true, 'turn 2 untouched');
});
