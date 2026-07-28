// Pins the blind-first-evaluation race (su-lou.10.8) so the finding cannot silently
// regress — either by a reducer change that closes it (which should be a deliberate,
// measured decision, not an accident) or by a stage-2 gate change that makes the
// bypass worse.
//
//   node --test 'src/**/*.test.ts'   (node:test + node:assert only)
//
// The mechanism, pinned two ways: named per-pause outcomes (each case the gate routes
// differently once the veto is bypassed), and the structural sweep property (the race
// is unique to floors below the measured EOU cost).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scorePauseAtFloor,
  measureRaceAtFloor,
  measureRace,
  raceConfirmed,
  WARMED_EOU_LATENCY_MS,
  type RacePause,
} from './race-measurement.ts';
import { RACE_CORPUS } from './race-corpus.ts';
import { FLOOR_SWEEP_MS } from './knobs.ts';

const byName = (name: string): RacePause => {
  const p = RACE_CORPUS.find((c) => c.name === name);
  if (!p) throw new Error(`no corpus pause ${name}`);
  return p;
};

// A floor from the ladder that is BELOW the measured EOU cost (200) and one ABOVE it.
const BELOW = 200;
const ABOVE = 500;

test('the corpus spans both verdicts (the measurement needs finished AND mid-thought pauses)', () => {
  assert.ok(RACE_CORPUS.some((p) => p.trueVerdict === 'complete'), 'need finished pauses');
  assert.ok(RACE_CORPUS.some((p) => p.trueVerdict === 'incomplete'), 'need mid-thought pauses');
  assert.ok(BELOW < WARMED_EOU_LATENCY_MS && ABOVE >= WARMED_EOU_LATENCY_MS, 'BELOW/ABOVE straddle the EOU cost');
  assert.ok(FLOOR_SWEEP_MS.includes(BELOW) && FLOOR_SWEEP_MS.includes(ABOVE), 'both test floors are real sweep rungs');
});

test('below the EOU cost, a substantive mid-thought pause races to a speaking commit — a false cutoff', () => {
  const o = scorePauseAtFloor(byName('midthought-substantive'), BELOW);
  assert.equal(o.blind, true, 'the deadline fires before the ~270ms verdict lands');
  assert.equal(o.committedToSpeaking, true);
  assert.equal(o.tier, 'reflection');
  assert.equal(o.raceFired, true);
  assert.equal(o.falseCutoff, true, 'the veto would have held this, but was bypassed');
});

test('a mid-thought pause that ends on a bare word (no discourse marker) also false-cuts — rule 3 cannot catch it', () => {
  const o = scorePauseAtFloor(byName('midthought-dangling'), BELOW);
  assert.equal(o.raceFired, true);
  assert.equal(o.falseCutoff, true);
});

test('ABOVE the EOU cost the veto holds the same mid-thought pause — the verdict is present at the deadline', () => {
  const o = scorePauseAtFloor(byName('midthought-substantive'), ABOVE);
  assert.equal(o.blind, false, 'the incomplete verdict lands before the deadline and extends the floor');
  assert.equal(o.committedToSpeaking, false);
  assert.equal(o.tier, 'silence');
  assert.equal(o.raceFired, false);
  assert.equal(o.falseCutoff, false);
});

test('a visibly trailing-off mid-thought is held on the WORDS (rule 3), not the veto — the race does not fire even below the cost', () => {
  for (const name of ['midthought-trailing-conjunction', 'midthought-ellipsis']) {
    const o = scorePauseAtFloor(byName(name), BELOW);
    assert.equal(o.blind, true, `${name}: the first evaluation is still blind`);
    assert.equal(o.tier, 'silence', `${name}: rule 3 holds on the trailing-off cue`);
    assert.equal(o.raceFired, false, `${name}: held on the words, so no blind speaking commit`);
    assert.equal(o.falseCutoff, false);
  }
});

test('a finished substantive pause commits to speaking at BOTH floors, but only blindly below the cost (never a false cutoff)', () => {
  const below = scorePauseAtFloor(byName('finished-reflection'), BELOW);
  assert.equal(below.blind, true);
  assert.equal(below.raceFired, true, 'a correct commit, but made blind');
  assert.equal(below.falseCutoff, false, 'the thought really was complete');

  const above = scorePauseAtFloor(byName('finished-reflection'), ABOVE);
  assert.equal(above.committedToSpeaking, true, 'still a reflection');
  assert.equal(above.blind, false, 'but the complete verdict was already present');
  assert.equal(above.raceFired, false);
});

test('the race is UNIQUE to floors below the measured EOU cost, across the whole sweep', () => {
  const results = measureRace(RACE_CORPUS);
  assert.equal(results.length, FLOOR_SWEEP_MS.length);
  for (const r of results) {
    if (r.floorMs < WARMED_EOU_LATENCY_MS) {
      assert.equal(r.blind, r.total, `${r.floorMs}ms: every first evaluation is blind`);
      assert.ok(r.raceFires > 0, `${r.floorMs}ms: the race fires`);
    } else {
      assert.equal(r.blind, 0, `${r.floorMs}ms: no first evaluation is blind`);
      assert.equal(r.raceFires, 0, `${r.floorMs}ms: the veto gates, so the race cannot fire`);
      assert.equal(r.falseCutoffs, 0, `${r.floorMs}ms: no false cutoffs`);
    }
  }
  assert.equal(raceConfirmed(results), true, 'the race fires somewhere in the sweep');
});

test('at 200ms every mid-thought pause WITHOUT a trailing-off cue is a false cutoff; the rest are held on the words', () => {
  const r = measureRaceAtFloor(RACE_CORPUS, BELOW);
  assert.equal(r.blind, r.total, 'all blind at a sub-cost floor');
  // The false cutoffs are exactly the mid-thought pauses whose transcript has no
  // discourse-marker cue for rule 3 to hold on — i.e. the veto was their only backstop.
  const held = r.outcomes.filter((o) => o.tier === 'silence').map((o) => o.name);
  const falseCuts = r.outcomes.filter((o) => o.falseCutoff).map((o) => o.name);
  assert.deepEqual(falseCuts.sort(), ['midthought-dangling', 'midthought-substantive']);
  assert.deepEqual(held.sort(), ['midthought-ellipsis', 'midthought-trailing-conjunction']);
});

test('the rate responds to the EOU latency, not a hard-coded 270 — a floor at/above the modeled cost is not blind', () => {
  // Same 200ms floor, but a HYPOTHETICAL 150ms cost: now the verdict lands before the
  // deadline, so nothing is blind and the veto gates. Proves the finding is a floor-vs-
  // cost comparison, not an artefact pinned to one rung.
  const fast = scorePauseAtFloor(byName('midthought-substantive'), 200, 150);
  assert.equal(fast.blind, false);
  assert.equal(fast.raceFired, false);
});
