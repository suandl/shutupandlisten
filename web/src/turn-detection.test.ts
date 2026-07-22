// Scenario tests for the pure turn state machine.
//
// Runs with zero dependencies via Node's built-in test runner + type stripping:
//   node --test 'src/**/*.test.ts'
// (also runnable under vitest; the suite uses only node:test + node:assert).
//
// The golden vectors in spec/turn-vectors/scenarios/ ARE the contract —
// this file loads each, replays it through a fresh TurnDetector, and asserts
// the emitted output matches byte-for-byte. The named tests below restate the
// plan's scenarios 1–5 (+ the asymmetric-veto hold) so intent stays legible,
// then pin the un-collapsed `Deciding` state: the floor triggers an EVALUATE and
// only a `speak` verdict enters `responding`. The last block pins the identity
// split those two together forced (spec §4b): `turn` counts UTTERANCES and only a
// taken floor advances it, while `evaluation` counts window closures.

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
//
// The floor closing the patience window now emits an `evaluate` and parks in
// `deciding`; the host's `decision` is what takes the floor. These scenarios are
// about the TIMING contract, so they answer `speak` at the deadline — the
// timing-only wiring, byte-identical in emitted turn-ends to the collapsed
// machine. The un-collapsing itself is pinned by the `deciding` tests below.

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
    ...det.input({ t: 4000, type: 'decision', outcome: 'speak' }),
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
    ...det.input({ t: 4000, type: 'decision', outcome: 'speak' }),
    ...det.input({ t: 6000, type: 'tick' }),
  ];
  const evals = byType(out, 'evaluate');
  assert.equal(evals.length, 1);
  assert.equal(evals[0].t, 4000, 'evaluates at the floor (4000), never at the verdict time (2100)');
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
    ...det.input({ t: 6000, type: 'decision', outcome: 'speak' }),
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
    ...det.input({ t: 4000, type: 'decision', outcome: 'speak' }),
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
    ...det.input({ t: 8000, type: 'decision', outcome: 'speak' }),
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
    ...det.input({ t: 4000, type: 'decision', outcome: 'speak' }),
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
    ...det.input({ t: 3000, type: 'decision', outcome: 'speak' }), // evaluates at 1000+2000=3000
    ...det.input({ t: 4000, type: 'tick' }),
  ];
  assert.equal((byType(out1, 'turn-end')[0] as OutputEvent).t, 3000);
  det.setKnobs({ silenceFloorMs: 500 });
  const out2 = [
    ...det.input({ t: 10000, type: 'speech-start' }),
    ...det.input({ t: 11000, type: 'speech-end' }),
    ...det.input({ t: 11500, type: 'decision', outcome: 'speak' }), // evaluates at 11000+500=11500
    ...det.input({ t: 12000, type: 'tick' }),
  ];
  assert.equal((byType(out2, 'turn-end')[0] as OutputEvent).t, 11500);
});

// ── Un-collapsed `Deciding` — the floor triggers evaluation, it does not decide ──

test('deciding: the floor emits an evaluate and parks — no turn-end until the host answers', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 9000, type: 'tick' }), // seven seconds past the floor, still unanswered
  ];
  const evals = byType(out, 'evaluate') as Array<OutputEvent & { reason: string; trigger: string }>;
  assert.equal(evals.length, 1, 'exactly one evaluation for the pause');
  assert.equal(evals[0].t, 4000, 'evaluates at the patience deadline');
  assert.equal(evals[0].reason, 'floor');
  assert.equal(evals[0].trigger, 'deadline');
  assert.equal(byType(out, 'turn-end').length, 0, 'the floor alone never ends the turn');
  assert.equal(byType(out, 'response-start').length, 0, 'and never commits to responding');
  assert.equal(det.state, 'deciding', 'waiting on the verdict, not parked in responding');
});

// The bead's headline guarantee: declining to speak costs nothing.
test('deciding: a `silence` verdict never enters responding — it re-arms to listening', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000, responseDurationMs: 1500 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 4000, type: 'decision', outcome: 'silence' }),
    ...det.input({ t: 4200, type: 'tick' }),
  ];
  assert.equal(byType(out, 'turn-end').length, 0, 'no turn-end: the floor was never taken');
  assert.equal(byType(out, 'response-start').length, 0, 'no response park');
  assert.equal(byType(out, 'response-end').length, 0);
  assert.equal(det.state, 'listening', 're-armed straight back to listening');
  // …and the next speech is neither a barge-in (nothing was spoken to interrupt)
  // nor a new turn (nothing ended one): it is the same thought resuming — §4b.
  const next = det.input({ t: 4500, type: 'speech-start' });
  assert.equal(byType(next, 'barge-in').length, 0, 'nothing to barge in over');
  assert.deepEqual(next, [], 'no turn-start: a declined pause did not end the turn');
  assert.equal(det.currentTurn, 1, 'still the same utterance');
  assert.equal(det.state, 'speaking');
});

test('deciding: a `speak` verdict takes the floor, carrying the patience reason', () => {
  for (const [verdict, reason, decisionT] of [
    ['complete', 'floor', 4000],
    ['incomplete', 'extended', 8000],
  ] as const) {
    const det = new TurnDetector({ silenceFloorMs: 2000, incompleteExtensionMs: 4000 });
    const out = [
      ...det.input({ t: 0, type: 'speech-start' }),
      ...det.input({ t: 2000, type: 'speech-end' }),
      ...det.input({ t: 2100, type: 'eou', verdict }),
      ...det.input({ t: decisionT, type: 'decision', outcome: 'speak' }),
    ];
    const ends = byType(out, 'turn-end') as Array<OutputEvent & { reason: string }>;
    assert.equal(ends.length, 1, `${verdict}: one turn-end`);
    assert.equal(ends[0].reason, reason, `${verdict}: turn-end carries the patience reason`);
    assert.equal(byType(out, 'response-start').length, 1, `${verdict}: enters responding`);
    assert.equal(det.state, 'responding');
  }
});

test('deciding: the thinker resuming abandons the evaluation and continues the same turn', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }), // evaluates at 4000, unanswered
    ...det.input({ t: 4200, type: 'speech-start' }),
  ];
  assert.equal(byType(out, 'barge-in').length, 0, 'nothing was spoken — this is a resume, not a barge-in');
  assert.equal(byType(out, 'turn-start').length, 1, 'still the same, single turn');
  assert.equal(det.state, 'speaking');
  // A verdict for the abandoned evaluation is stale and must not take the floor.
  const stale = det.input({ t: 4300, type: 'decision', outcome: 'speak' });
  assert.deepEqual(stale, [], 'a decision outside `deciding` is ignored');
  assert.equal(det.state, 'speaking');
});

test('deciding: fresh EOU evidence supersedes the outstanding evaluation (no clock tick involved)', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 4100, type: 'eou', verdict: 'incomplete' }),
  ];
  const evals = byType(out, 'evaluate') as Array<OutputEvent & { trigger: string }>;
  assert.equal(evals.length, 2, 'the deadline evaluation plus one driven by the new evidence');
  assert.equal(evals[1].t, 4100, 're-evaluates when the evidence lands, not on a tick');
  assert.equal(evals[1].trigger, 'evidence');
  assert.equal(det.state, 'deciding', 'still awaiting a verdict — a re-evaluation is not a decision');
  // A repeat of the same verdict carries no new information: no re-evaluation.
  const repeat = det.input({ t: 4200, type: 'eou', verdict: 'incomplete' });
  assert.deepEqual(repeat, []);
});

test('deciding: the baseline arm (useSmartTurn=false) never re-evaluates on a verdict', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000, useSmartTurn: false });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 4100, type: 'eou', verdict: 'incomplete' }),
  ];
  assert.equal(byType(out, 'evaluate').length, 1, 'only the deadline evaluation; verdicts are ignored');
});

// ── Two identities: `turn` counts utterances, `evaluation` counts window closures ──

test('identity: a declined pause keeps ONE turn while the evaluation tick advances', () => {
  // The shape su-lou.10.5 makes routine: a short floor, a thinker who keeps going.
  const det = new TurnDetector({ silenceFloorMs: 500 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 1000, type: 'speech-end' }),
    ...det.input({ t: 1500, type: 'decision', outcome: 'silence' }), // evaluates at 1500
    ...det.input({ t: 1800, type: 'speech-start' }), // the same thought, continuing
    ...det.input({ t: 2800, type: 'speech-end' }),
    ...det.input({ t: 3300, type: 'decision', outcome: 'silence' }), // evaluates at 3300
    ...det.input({ t: 3600, type: 'speech-start' }),
    ...det.input({ t: 5000, type: 'speech-end' }),
    ...det.input({ t: 5500, type: 'decision', outcome: 'speak' }), // evaluates at 5500, takes the floor
  ];
  const evals = byType(out, 'evaluate') as Array<OutputEvent & { turn: number; evaluation: number }>;
  assert.deepEqual(evals.map((e) => e.evaluation), [1, 2, 3], 'each closing window is its own tick');
  assert.deepEqual(evals.map((e) => e.turn), [1, 1, 1], 'all of them about ONE thought');
  assert.equal(byType(out, 'turn-start').length, 1, 'one utterance, one turn-start');
  const ends = byType(out, 'turn-end') as Array<OutputEvent & { evaluation: number }>;
  assert.equal(ends.length, 1, 'only the answered evaluation ends the turn');
  assert.equal(ends[0].evaluation, 3, 'turn-end names the evaluation the verdict answered');
  // …and NOW the turn is over, so the next speech is a new one.
  const next = det.input({ t: 8000, type: 'speech-start' });
  assert.deepEqual(next.filter((e) => e.type === 'turn-start'), [{ t: 8000, type: 'turn-start', turn: 2 }]);
});

test('identity: an evidence re-evaluation is the SAME tick, a new window is a new one', () => {
  const det = new TurnDetector({ silenceFloorMs: 500 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 1000, type: 'speech-end' }),
    ...det.input({ t: 1600, type: 'eou', verdict: 'incomplete' }), // supersedes the 1500 evaluation
    ...det.input({ t: 1700, type: 'decision', outcome: 'silence' }),
    ...det.input({ t: 2000, type: 'speech-start' }),
    ...det.input({ t: 3000, type: 'speech-end' }),
    ...det.input({ t: 3500, type: 'tick' }), // a second window closes
  ];
  const evals = byType(out, 'evaluate') as Array<OutputEvent & { evaluation: number; trigger: string }>;
  assert.deepEqual(
    evals.map((e) => [e.trigger, e.evaluation]),
    [
      ['deadline', 1],
      ['evidence', 1], // better evidence for the same question — not a new one
      ['deadline', 2],
    ],
  );
});

test('identity: barge-in still opens a fresh turn (B2 is untouched)', () => {
  const det = new TurnDetector({ silenceFloorMs: 500, responseDurationMs: 1500 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 1000, type: 'speech-end' }),
    ...det.input({ t: 1500, type: 'decision', outcome: 'speak' }), // response runs 1500..3000
    ...det.input({ t: 2000, type: 'speech-start' }), // barge-in
  ];
  assert.equal(byType(out, 'barge-in').length, 1);
  const starts = byType(out, 'turn-start') as Array<OutputEvent & { turn: number }>;
  assert.deepEqual(starts.map((e) => e.turn), [1, 2], 'the floor was taken, so this IS a new thought');
  const respEnds = byType(out, 'response-end') as Array<OutputEvent & { reason: string; t: number }>;
  assert.equal(respEnds[0].reason, 'barge-in');
  assert.equal(respEnds[0].t, 2000, 'cut at the interrupt, instantly');
});

test('identity: dropTurn ends the turn without a response (the host reset the session)', () => {
  const det = new TurnDetector({ silenceFloorMs: 500 });
  det.input({ t: 0, type: 'speech-start' });
  det.input({ t: 1000, type: 'speech-end' });
  const abandoned = det.input({ t: 1500, type: 'decision', outcome: 'silence' });
  assert.equal(byType(abandoned, 'turn-end').length, 0);
  det.dropTurn();
  const next = det.input({ t: 2000, type: 'speech-start' });
  assert.deepEqual(next, [{ t: 2000, type: 'turn-start', turn: 2 }], 'a dropped turn does not resume');
});

// The decision loop's real wiring: the host answers from inside the emit callback.
test('deciding: a host answering from within onEmit gets one ordered, complete stream', () => {
  const seen: OutputEvent[] = [];
  const det: TurnDetector = new TurnDetector({ silenceFloorMs: 2000, responseDurationMs: 1500 }, (e) => {
    seen.push(e);
    if (e.type === 'evaluate') det.input({ t: e.t, type: 'decision', outcome: 'speak' });
  });
  det.input({ t: 0, type: 'speech-start' });
  det.input({ t: 4000, type: 'speech-end' });
  const out = det.input({ t: 6000, type: 'tick' }); // fires the deadline; the host answers re-entrantly
  assert.deepEqual(out, [
    { t: 6000, type: 'evaluate', turn: 1, evaluation: 1, reason: 'floor', trigger: 'deadline' },
    { t: 6000, type: 'turn-end', turn: 1, evaluation: 1, reason: 'floor' },
    { t: 6000, type: 'response-start', turn: 1 },
  ]);
  assert.deepEqual(seen.slice(1), out, 'the callback saw exactly what the caller was returned');
  assert.equal(det.state, 'responding');
});
