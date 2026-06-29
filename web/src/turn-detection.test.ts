// Scenario tests for the pure turn state machine.
//
// Runs with zero dependencies via Node's built-in test runner + type stripping:
//   node --test 'src/**/*.test.ts'
// (also runnable under vitest; the suite uses only node:test + node:assert).
//
// The six golden vectors in spec/turn-vectors/scenarios/ ARE the contract —
// this file loads each, replays it through a fresh TurnDetector, and asserts
// the emitted output matches byte-for-byte. The named tests below restate the
// plan's scenarios 1–5 (+ the asymmetric-veto hold) so intent stays legible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TurnDetector } from './turn-detection.ts';
import type { InputEvent, OutputEvent, TurnKnobs } from './turn-detection.ts';

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, '../../spec/turn-vectors/scenarios');

interface ScenarioVector {
  name: string;
  description: string;
  knobs: Partial<TurnKnobs>;
  events: InputEvent[];
  expected: {
    turnStartCount?: number;
    turnEndCount?: number;
    turnEnds?: Array<{ t: number; turn: number; reason: string }>;
    emit?: OutputEvent[];
  };
}

function loadScenarios(): ScenarioVector[] {
  return readdirSync(scenariosDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(scenariosDir, f), 'utf8')) as ScenarioVector);
}

/** Replay a vector through a fresh detector, returning the full emitted stream. */
function replay(vector: ScenarioVector): OutputEvent[] {
  const det = new TurnDetector(vector.knobs);
  const out: OutputEvent[] = [];
  for (const ev of vector.events) out.push(...det.input(ev));
  return out;
}

const byType = (out: OutputEvent[], type: string) => out.filter((e) => e.type === type);

// ── Data-driven: every scenario vector must replay to its expected output ──
for (const vector of loadScenarios()) {
  test(`vector ${vector.name}: ${vector.description}`, () => {
    const out = replay(vector);
    const exp = vector.expected;

    if (exp.emit) {
      assert.deepEqual(out, exp.emit, 'full emitted stream must match expected.emit');
    }
    if (exp.turnEnds) {
      const ends = byType(out, 'turn-end').map((e) => ({
        t: e.t,
        turn: (e as { turn: number }).turn,
        reason: (e as { reason: string }).reason,
      }));
      assert.deepEqual(ends, exp.turnEnds, 'turn-end events must match exactly');
    }
    if (exp.turnStartCount !== undefined) {
      assert.equal(byType(out, 'turn-start').length, exp.turnStartCount, 'turn-start count');
    }
    if (exp.turnEndCount !== undefined) {
      assert.equal(byType(out, 'turn-end').length, exp.turnEndCount, 'turn-end count');
    }
  });
}

// ── Named restatements of the plan scenarios (intent-legible) ──

// Scenario 1 — the cardinal-failure guard / TDD red anchor.
test('S1: a mid-thought pause under the floor does NOT emit end-of-turn', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 1200, type: 'speech-end' }),
    // resume 800ms later — well under the 2000ms floor
    ...det.input({ t: 2000, type: 'speech-start' }),
    ...det.input({ t: 3500, type: 'speech-end' }),
    ...det.input({ t: 4500, type: 'tick' }),
  ];
  assert.equal(byType(out, 'turn-end').length, 0, 'no turn may end on a sub-floor pause');
  assert.equal(byType(out, 'turn-start').length, 1, 'still a single, continuing turn');
});

// Scenario 2 — silence past the floor with no incomplete EOU emits exactly one end.
test('S2: silence past the floor emits exactly one end-of-turn at the floor', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 8000, type: 'tick' }),
  ];
  const ends = byType(out, 'turn-end');
  assert.equal(ends.length, 1, 'exactly one end-of-turn');
  assert.equal(ends[0].t, 4000, 'ends at silenceStart + floor');
});

// Scenario 3 — a complete verdict during a sub-floor pause does not short-circuit.
test('S3: a complete EOU during a sub-floor pause does not short-circuit the floor', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 2100, type: 'eou', verdict: 'complete' }),
    ...det.input({ t: 6000, type: 'tick' }),
  ];
  const ends = byType(out, 'turn-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].t, 4000, 'ends at the floor (4000), never at the verdict time (2100)');
});

// Scenario 4 — resume after a sub-floor pause continues the same turn.
test('S4: speech resuming after a sub-floor pause continues the same turn', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 1500, type: 'speech-end' }),
    ...det.input({ t: 2500, type: 'speech-start' }),
    ...det.input({ t: 4000, type: 'speech-end' }),
    ...det.input({ t: 8000, type: 'tick' }),
  ];
  assert.equal(byType(out, 'turn-start').length, 1, 'one turn-start (same turn)');
  const ends = byType(out, 'turn-end') as Array<OutputEvent & { turn: number }>;
  assert.equal(ends.length, 1, 'one end, for the completed thought');
  assert.equal(ends[0].turn, 1, 'same turn id throughout');
  assert.equal(ends[0].t, 6000, 'floor measured from the final speech-end (4000)');
});

// Scenario 5 — barge-in yields instantly.
test('S5: barge-in over a response yields instantly and starts a fresh turn', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000, responseDurationMs: 1500 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    // response runs 4000..5500; user barges in at 4500
    ...det.input({ t: 4500, type: 'speech-start' }),
    ...det.input({ t: 6000, type: 'tick' }),
  ];
  const respEnds = byType(out, 'response-end') as Array<OutputEvent & { reason: string }>;
  assert.equal(respEnds.length, 1);
  assert.equal(respEnds[0].reason, 'barge-in', 'response cut by the barge-in');
  assert.equal(respEnds[0].t, 4500, 'cut at the interrupt (4500), not the natural end (5500)');
  assert.equal(byType(out, 'barge-in').length, 1, 'a barge-in event is emitted');
  assert.equal(byType(out, 'turn-start').length, 2, 'the barge-in opens a fresh turn');
});

// Asymmetric-veto hold — the value the EOU adds over a bare floor.
test('veto: an incomplete EOU holds the turn open past the floor', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000, incompleteExtensionMs: 4000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 2100, type: 'eou', verdict: 'incomplete' }),
    ...det.input({ t: 10000, type: 'tick' }),
  ];
  const ends = byType(out, 'turn-end') as Array<OutputEvent & { reason: string }>;
  assert.equal(ends.length, 1);
  assert.equal(ends[0].t, 8000, 'floor (2000) + extension (4000) past speech-end (2000) = 8000');
  assert.equal(ends[0].reason, 'extended');
});

// useSmartTurn:false is the patience-only baseline arm — verdicts ignored.
test('baseline arm: with useSmartTurn=false an incomplete verdict is ignored', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000, incompleteExtensionMs: 4000, useSmartTurn: false });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 2100, type: 'eou', verdict: 'incomplete' }),
    ...det.input({ t: 10000, type: 'tick' }),
  ];
  const ends = byType(out, 'turn-end');
  assert.equal(ends[0].t, 4000, 'bare floor ignores the incomplete extension');
});

// Live knobs — a knob change takes effect on the next pause.
test('knobs: setKnobs changes patience for the next pause', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000 });
  const out1 = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 1000, type: 'speech-end' }),
    ...det.input({ t: 4000, type: 'tick' }), // ends at 1000+2000=3000
  ];
  assert.equal((byType(out1, 'turn-end')[0] as OutputEvent).t, 3000);
  det.setKnobs({ silenceFloorMs: 500 });
  const out2 = [
    ...det.input({ t: 10000, type: 'speech-start' }),
    ...det.input({ t: 11000, type: 'speech-end' }),
    ...det.input({ t: 12000, type: 'tick' }), // ends at 11000+500=11500
  ];
  assert.equal((byType(out2, 'turn-end')[0] as OutputEvent).t, 11500);
});
