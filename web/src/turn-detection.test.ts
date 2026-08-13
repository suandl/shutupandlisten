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
// The last block checks the two B1 mechanisms together, so it needs the gate the
// detector's patience reason is bridged into — see that test for why it crosses over.
import { decideTier, completionProbFromTurnEnd, type TurnEndReason } from './response-hierarchy.ts';
import { gateConfigFromTurnKnobs } from './knobs.ts';

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

// ── The graded veto and the bar it reads (su-uzy9.5) ──
//
// Decoupling the two B1 mechanisms gave the veto its own, higher bar
// (`confidentCompletionThreshold`) while the gate's rule-2 silence kept
// `completionThreshold`. These pin both halves of that split — and then the
// ORDERING it silently depends on, which is the half that had no test.

test('veto: a weak-cue score extends the floor without the verdict calling it incomplete', () => {
  // 0.6 is the linguistic EOU's "no strong cue" reading: >= completionThreshold (0.5)
  // so the verdict is `complete`, but < confidentCompletionThreshold (0.8) so patience
  // is still bought. That band IS the fix — it could not exist while one number served
  // both readers, which is what let an uncued mid-thought pause defeat B1.
  const det = new TurnDetector({ silenceFloorMs: 2000, incompleteExtensionMs: 4000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 2100, type: 'eou', completionProb: 0.6 }),
    ...det.input({ t: 10000, type: 'tick' }),
  ];
  assert.equal(det.peek(10000).verdict, 'complete', 'the evidence is not relabelled incomplete');
  const evals = byType(out, 'evaluate') as Array<OutputEvent & { reason: string }>;
  assert.equal(evals[0].t, 8000, 'floor (2000) + extension (4000) past speech-end (2000)');
  assert.equal(evals[0].reason, 'extended', 'weak evidence of completeness still buys patience');
});

test('veto: a positive completeness cue releases the floor', () => {
  const det = new TurnDetector({ silenceFloorMs: 2000, incompleteExtensionMs: 4000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 2100, type: 'eou', completionProb: 0.85 }), // terminal punctuation
    ...det.input({ t: 10000, type: 'tick' }),
  ];
  const evals = byType(out, 'evaluate') as Array<OutputEvent & { reason: string }>;
  assert.equal(evals[0].t, 4000, 'bare floor: 0.85 >= 0.8 reads as confidently finished');
  assert.equal(evals[0].reason, 'floor');
});

// REGRESSION (su-g805, pre-open signoff on su-uzy9.5). `completionThreshold` carries a
// live 0..1 slider; `confidentCompletionThreshold` carries no knob at all. Raise the
// slider past 0.8 and the pair INVERTS — and a score inside the inverted band was
// called `incomplete` by resolveVerdict while still clearing the fixed confidence bar,
// so the pause collected no extension. The veto's bar is floored at
// `completionThreshold`, so the asymmetric veto's guarantee — an `incomplete` verdict
// only ever LENGTHENS patience (spec §2) — survives any setting of the two knobs.
test('veto: an incomplete verdict extends even when completionThreshold exceeds the confident bar', () => {
  const det = new TurnDetector({
    silenceFloorMs: 2000,
    incompleteExtensionMs: 4000,
    completionThreshold: 0.9, // the live retune
    // confidentCompletionThreshold stays at its 0.8 default — no knob exposes it
  });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 2000, type: 'speech-end' }),
    ...det.input({ t: 2100, type: 'eou', completionProb: 0.85 }), // 0.8 <= 0.85 < 0.9
    ...det.input({ t: 10000, type: 'tick' }),
  ];
  assert.equal(det.peek(10000).verdict, 'incomplete', '0.85 < completionThreshold 0.9');
  const evals = byType(out, 'evaluate') as Array<OutputEvent & { reason: string }>;
  assert.equal(evals[0].reason, 'extended', 'an incomplete verdict must never lose the extension');
  assert.equal(evals[0].t, 8000, 'floor (2000) + extension (4000) past speech-end (2000)');
});

test('veto: incomplete always extends, for every ordering of the two thresholds', () => {
  // The invariant the band relies on, checked across the ordering rather than assumed:
  // ordered (the shipped shape), inverted (the live retune), and equal.
  for (const [completionThreshold, confidentCompletionThreshold] of [
    [0.5, 0.8],
    [0.9, 0.8],
    [0.8, 0.8],
    [1, 0],
  ] as const) {
    const prob = completionThreshold - 0.05; // just under the bar ⇒ verdict `incomplete`
    const det = new TurnDetector({
      silenceFloorMs: 2000,
      incompleteExtensionMs: 4000,
      completionThreshold,
      confidentCompletionThreshold,
    });
    const label = `completion=${completionThreshold} confident=${confidentCompletionThreshold}`;
    const out = [
      ...det.input({ t: 0, type: 'speech-start' }),
      ...det.input({ t: 2000, type: 'speech-end' }),
      ...det.input({ t: 2100, type: 'eou', completionProb: prob }),
      ...det.input({ t: 10000, type: 'tick' }),
    ];
    assert.equal(det.peek(10000).verdict, 'incomplete', `${label}: verdict`);
    const evals = byType(out, 'evaluate') as Array<OutputEvent & { reason: string }>;
    assert.equal(evals[0].reason, 'extended', `${label}: an incomplete verdict extends`);
  }
});

// The two B1 mechanisms, end to end — the failure the signoff actually caught.
//
// This crosses into the gate on purpose, and mirrors exactly what main.ts feeds it:
// the pause's real P(complete) when the detector has one, and only otherwise the
// patience REASON bridged to a synthetic 0/1 (`completionProbFromTurnEnd`). Here the
// two readings agree — 0.85 is below the retuned 0.9, so the classifier positively
// called the thought unfinished — and both mechanisms must hold.
test('B1: a retuned completion threshold holds the pause in BOTH mechanisms', () => {
  const det = new TurnDetector({
    silenceFloorMs: 200,
    incompleteExtensionMs: 4000,
    completionThreshold: 0.9,
  });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 1000, type: 'speech-end' }),
    ...det.input({ t: 1000, type: 'eou', completionProb: 0.85 }),
    ...det.input({ t: 6000, type: 'tick' }),
  ];
  const evaluate = byType(out, 'evaluate')[0] as OutputEvent & { reason: TurnEndReason };

  // Mechanism 1 — the veto extends the patience floor.
  assert.equal(evaluate.reason, 'extended');

  // Mechanism 2 — the gate holds silence rather than speaking into the thought.
  const decision = decideTier(
    {
      utteranceIndex: 1,
      utteranceTextSoFar: 'so the thing I keep coming back to is whether we should',
      completionProb: det.peek(6000).completionProb ?? completionProbFromTurnEnd(evaluate.reason),
      msSinceSpeechEnd: 4200,
      msSinceWeLastSpoke: Infinity,
      priorDecisions: [],
    },
    gateConfigFromTurnKnobs(det.config),
  );
  assert.equal(decision.tier, 'silence', 'the gate must not speak into a pause it calls incomplete');
});

// The DECOUPLING itself — b1-03 carried past the extension, which is where the first
// signoff round found the two mechanisms still welded together (su-eyp8 P1).
//
// b1-03 is ordinary thinking-out-loud: 15 unpunctuated words, so the linguistic EOU
// returns its "no strong cue" 0.6 — weak evidence of completeness, not a finished
// thought. Under the shipped defaults that score is ABOVE the gate's 0.5 and BELOW the
// veto's 0.8, which is the whole point of the split: extra patience without calling
// the utterance incomplete.
//
// The vector's own thinker resumes at 4200 and the extension covers them. This test
// takes the OTHER branch — the thinker really was finished — and pins what happens
// when the extended deadline elapses in silence. Feeding the gate the patience reason
// instead of the score turns "held open because we were unsure" into "certainly
// incomplete", so rule 2 returns silence and the companion waits 7.2 s and then says
// nothing. That is the veto forcing gate-rule-2 silence: the two mechanisms reading
// one number again, via the bridge rather than via the constant.
test('B1: a weak-cue pause that waits out the extension may still speak (the decoupling)', () => {
  // The b1-03 utterance. 15 words, no terminal punctuation, no trailing-off cue.
  const text = "I've been trying to work out why the deploy keeps failing on the staging box";
  const NO_STRONG_CUE = 0.6; // LinguisticEOU's default for a bare unpunctuated ending.

  const det = new TurnDetector({ silenceFloorMs: 200, incompleteExtensionMs: 4000 });
  const out = [
    ...det.input({ t: 0, type: 'speech-start' }),
    ...det.input({ t: 3000, type: 'speech-end' }),
    ...det.input({ t: 3000, type: 'eou', completionProb: NO_STRONG_CUE }),
  ];

  // While the window is open: held, and the snapshot says so WITHOUT relabelling the
  // verdict — the surface main.ts's patience caption reads (su-eyp8 P2).
  const pending = det.peek(4000);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.verdict, 'complete', '0.6 >= 0.5: the evidence is not called incomplete');
  assert.equal(pending.extended, true, 'yet the veto extends — 0.6 < the 0.8 confidence bar');
  assert.equal(pending.completionProb, NO_STRONG_CUE, 'the graded score survives for the gate');
  assert.equal(pending.msUntilTurnEnd, 3200, 'counting down 200 + 4000 from the 3000 speech-end');

  // Mechanism 1 — the extension held the floor to 7200 instead of 3200.
  out.push(...det.input({ t: 7200, type: 'tick' }));
  const evaluate = byType(out, 'evaluate')[0] as OutputEvent & { t: number; reason: TurnEndReason };
  assert.equal(evaluate.t, 7200, 'the pause was granted the extension');
  assert.equal(evaluate.reason, 'extended');

  // Mechanism 2 — INDEPENDENT of mechanism 1. Nobody resumed, so the thinker really
  // was done; the gate reads the classifier's actual 0.6 against its own unchanged
  // 0.5 and is free to speak.
  const gateCtx = {
    utteranceIndex: 1,
    utteranceTextSoFar: text,
    msSinceSpeechEnd: evaluate.t - 3000,
    msSinceWeLastSpoke: Infinity,
    priorDecisions: [],
  };
  const scored = det.peek(evaluate.t).completionProb;
  assert.equal(scored, NO_STRONG_CUE, 'the score is still the one this pause was judged on');
  const decision = decideTier(
    { ...gateCtx, completionProb: scored ?? completionProbFromTurnEnd(evaluate.reason) },
    gateConfigFromTurnKnobs(det.config),
  );
  assert.equal(decision.tier, 'reflection', 'a finished 15-word thought earns a reply after the wait');

  // And the regression proper: the reason-bridge would have vetoed it. If this ever
  // stops diverging, main.ts has quietly gone back to deriving the score from the
  // reason and the extension is forcing silence again.
  const bridged = decideTier(
    { ...gateCtx, completionProb: completionProbFromTurnEnd(evaluate.reason) },
    gateConfigFromTurnKnobs(det.config),
  );
  assert.equal(bridged.tier, 'silence', 'the bridge reads the extension as certainly-incomplete');
  assert.notEqual(
    decision.tier,
    bridged.tier,
    'the score and the reason MUST disagree here — that gap is the decoupling',
  );
});

// The gate threshold is unchanged, so the band that buys patience is exactly the band
// where the two mechanisms are allowed to disagree. Below 0.5 both hold; at/above 0.8
// neither does; in between the floor extends and the gate still permits a reply.
test('B1: the weak-cue band extends the floor without silencing the gate', () => {
  const text = "I've been trying to work out why the deploy keeps failing on the staging box";
  for (const [prob, wantExtended, wantSilence] of [
    [0.3, true, true], // positively incomplete — both mechanisms hold
    [0.6, true, false], // no strong cue — patient, but not silenced
    [0.85, false, false], // a positive completeness cue — neither holds
  ] as const) {
    const det = new TurnDetector({ silenceFloorMs: 200, incompleteExtensionMs: 4000 });
    det.input({ t: 0, type: 'speech-start' });
    det.input({ t: 3000, type: 'speech-end' });
    det.input({ t: 3000, type: 'eou', completionProb: prob });
    const snap = det.peek(3100);
    assert.equal(snap.extended, wantExtended, `P=${prob}: veto extends?`);
    const tier = decideTier(
      {
        utteranceIndex: 1,
        utteranceTextSoFar: text,
        completionProb: snap.completionProb ?? 1,
        msSinceSpeechEnd: 100,
        msSinceWeLastSpoke: Infinity,
        priorDecisions: [],
      },
      gateConfigFromTurnKnobs(det.config),
    ).tier;
    assert.equal(tier === 'silence', wantSilence, `P=${prob}: gate holds silence?`);
  }
});
