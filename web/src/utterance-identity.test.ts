// The utterance/evaluation split, end to end — su-lou.10.4.
//
// turn-detection.test.ts pins the split inside the reducer and transcript.test.ts
// pins it inside the grouping. What neither can show is the reason it exists: the
// three pure modules COMPOSED are what feeds the gate, and the bug the split fixes
// only appears in that composition. So this file drives the real detector, the real
// `groupTranscript` and the real `decideTier` through the same wiring main.ts uses
// (main.ts itself is DOM-coupled, so its ~10 lines of glue are restated here — that
// glue is the only thing not under test).
//
// THE FAILURE IT GUARDS: the companion chirping mid-sentence. Once the floor is
// short enough to evaluate several times per thought (su-lou.10.5's job), a pause the
// gate declines to speak into used to start a NEW turn — so the next evaluation saw
// only the words since that pause. A substantive thought arrived at the gate as a
// "brief turn" and rule 4 answered it with a backchannel: "mm." over someone who is
// still talking. Grouping on the UTTERANCE is what stops it: the gate is shown the
// thought so far, not the fragment.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TurnDetector, type TurnKnobs } from './turn-detection.ts';
import { groupTranscript } from './transcript.ts';
import type { TranscriptSegment, TurnStartMark, TurnEndMark } from './transcript.ts';
import {
  decideTier,
  completionProbFromTurnEnd,
  tierCallsModel,
  type EvalContext,
  type GateDecision,
  type PriorDecision,
} from './response-hierarchy.ts';

/** One spoken run of words, exactly as the VAD + STT would deliver it. */
interface Phrase {
  startT: number;
  endT: number;
  text: string;
}

/** What the gate was asked, and what it answered. */
interface Evaluated {
  turn: number;
  evaluation: number;
  /** The text the gate was SHOWN — the assertion that matters most here. */
  shown: string;
  decision: GateDecision;
}

/**
 * Replay phrases through detector → transcript → gate → detector, the way main.ts
 * wires them, answering each `evaluate` with the gate's tier.
 *
 * The `tick` before each phrase stands in for main.ts's 90 ms clock loop: without
 * it the next speech-start would arrive in the same `input()` call that fires the
 * deadline and ABANDON the evaluation (spec §6) instead of answering it.
 */
function runLoop(phrases: readonly Phrase[], knobs: Partial<TurnKnobs>, finalT: number): Evaluated[] {
  const segments: TranscriptSegment[] = [];
  const turnStarts: TurnStartMark[] = [];
  let turnEnds: TurnEndMark[] = [];
  const decided: Evaluated[] = [];

  const det: TurnDetector = new TurnDetector(knobs, (e) => {
    if (e.type === 'turn-start') {
      turnStarts.push({ turn: e.turn, t: e.t });
      return;
    }
    if (e.type !== 'evaluate') return;

    // main.ts: the newest window supersedes any earlier one on the same turn.
    if (!turnEnds.some((m) => m.evaluation === e.evaluation)) {
      turnEnds = turnEnds.filter((m) => m.turn !== e.turn);
      turnEnds.push({ turn: e.turn, evaluation: e.evaluation, t: e.t, reason: e.reason });
    }

    const group = groupTranscript({ segments, turnStarts, turnEnds }).find((g) => g.turn === e.turn);
    const shown = (group?.segments ?? [])
      .map((s) => s.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    // History from EARLIER turns only, stamped with the turn it was about.
    const priorDecisions: PriorDecision[] = decided
      .filter((d) => d.turn < e.turn)
      .map((d) => ({ turn: d.turn, tier: d.decision.tier }));

    const decision = decideTier({
      utteranceIndex: e.turn,
      utteranceTextSoFar: shown,
      completionProb: completionProbFromTurnEnd(e.reason),
      msSinceSpeechEnd: 500,
      msSinceWeLastSpoke: Infinity,
      priorDecisions,
    });
    decided.push({ turn: e.turn, evaluation: e.evaluation, shown, decision });
    det.input({ t: e.t, type: 'decision', outcome: decision.tier === 'silence' ? 'silence' : 'speak' });
  });

  phrases.forEach((p, i) => {
    if (i > 0) det.input({ t: p.startT - 1, type: 'tick' });
    det.input({ t: p.startT, type: 'speech-start' });
    segments.push({ id: segments.length, startT: p.startT, endT: p.endT, text: p.text, mode: 'sim', pending: false });
    det.input({ t: p.endT, type: 'speech-end' });
  });
  det.input({ t: finalT, type: 'tick' });
  return decided;
}

/** The gate context the composed loop builds, for asking a counterfactual directly. */
function ctx(over: Partial<EvalContext>): EvalContext {
  return {
    utteranceIndex: 1,
    utteranceTextSoFar: '',
    completionProb: completionProbFromTurnEnd('floor'),
    msSinceSpeechEnd: 500,
    msSinceWeLastSpoke: Infinity,
    priorDecisions: [],
    ...over,
  };
}

// A 16-word finished thought: substantive by any of the gate's measures.
const SUBSTANTIVE = 'so the core idea is that the patience window should stretch when the thinker keeps building';

// ── the chirp ──

test('a short mid-utterance fragment at a low floor is NOT acknowledged', () => {
  // 500 ms floor: a mid-sentence breath is long enough to close the patience window.
  const OPENING = 'so the core idea is,'; // trails off — the gate declines to speak
  const REST = 'that patience should stretch when the thinker keeps building'; // 9 words

  const decided = runLoop(
    [
      { startT: 0, endT: 1000, text: OPENING },
      { startT: 1800, endT: 3000, text: REST },
    ],
    { silenceFloorMs: 500 },
    3600,
  );

  assert.equal(decided.length, 2, 'the window closed twice');
  assert.deepEqual(decided.map((d) => d.turn), [1, 1], 'ONE thought, not one per pause');
  assert.deepEqual(decided.map((d) => d.evaluation), [1, 2], 'two evaluation ticks under it');

  // First look: still going, so the gate holds — and holding keeps the turn open.
  assert.equal(decided[0].decision.tier, 'silence');

  // Second look: the whole thought so far, NOT the 9 words since the pause.
  assert.equal(decided[1].shown, `${OPENING} ${REST}`, 'the gate sees the thought, not the fragment');
  assert.notEqual(decided[1].decision.tier, 'acknowledge', 'no backchannel over an unfinished sentence');
  assert.equal(tierCallsModel(decided[1].decision.tier), true, 'read as substantive, as it is');

  // …and this is exactly what the fragment alone would have earned. Shown only the
  // words since the declined pause — which is what a tick-keyed grouping shows —
  // the same gate chirps.
  assert.equal(
    decideTier(ctx({ utteranceIndex: 2, utteranceTextSoFar: REST })).tier,
    'acknowledge',
    'the pre-split input is what produced the chirp; the policy did not change',
  );
});

// ── the cooldown ──

test('the question cooldown counts utterances, not evaluation ticks', () => {
  const decided = runLoop(
    [
      { startT: 0, endT: 1000, text: SUBSTANTIVE }, // utterance 1
      { startT: 2500, endT: 3500, text: SUBSTANTIVE }, // utterance 2
      { startT: 5000, endT: 6000, text: 'and then,' }, // utterance 3, declined…
      { startT: 7000, endT: 8000, text: SUBSTANTIVE }, // …still utterance 3
      { startT: 9500, endT: 10500, text: SUBSTANTIVE }, // utterance 4
    ],
    { silenceFloorMs: 500, responseDurationMs: 200 },
    11500,
  );

  assert.deepEqual(decided.map((d) => d.turn), [1, 2, 3, 3, 4], 'five evaluations over four thoughts');
  assert.deepEqual(
    decided.map((d) => d.decision.tier),
    ['reflection', 'question', 'silence', 'reflection', 'question'],
  );

  // The load-bearing one is the fourth: utterance 3 is one thought after the
  // question on utterance 2, so the cooldown (2) still holds and it reflects.
  // Counted in TICKS it would be evaluation 4 against a question at 2 — a gap of
  // two, and the companion would have asked twice in consecutive breaths.
  assert.equal(
    decideTier(
      ctx({
        utteranceIndex: 4, // the tick index the pre-split machine would have passed
        utteranceTextSoFar: decided[3].shown,
        priorDecisions: [
          { turn: 1, tier: 'reflection' },
          { turn: 2, tier: 'question' },
          { turn: 3, tier: 'silence' },
        ],
      }),
    ).tier,
    'question',
    'tick-keyed indices clear the cooldown a whole thought early',
  );
});

// The other boundary: taking the floor DOES end the utterance, so what follows is a
// new thought with a fresh word count — the split must not merge separate turns.
test('a spoken response closes the utterance — the next words start a new one', () => {
  const decided = runLoop(
    [
      { startT: 0, endT: 1000, text: SUBSTANTIVE },
      { startT: 2500, endT: 3500, text: 'that makes sense to me' },
    ],
    { silenceFloorMs: 500, responseDurationMs: 200 },
    4200,
  );

  assert.deepEqual(decided.map((d) => d.turn), [1, 2], 'the reflection ended turn 1');
  assert.equal(decided[0].decision.tier, 'reflection');
  assert.equal(decided[1].shown, 'that makes sense to me', 'turn 2 carries only its own words');
  assert.equal(decided[1].decision.tier, 'acknowledge', 'a genuinely short finished aside still gets one');
});
