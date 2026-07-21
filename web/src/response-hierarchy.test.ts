// Tests for the response-hierarchy gate (response-hierarchy.ts).
//
// The gate is pure, so — like turn-detection.ts and transcript.ts — the whole
// escalate-slowly policy is pinned headlessly here. The contract under test:
//  - an unfinished thought is NEVER escalated (B1), whether the "still going"
//    signal is the EOU classifier scoring the pause incomplete or trailing-off text;
//  - silence/acknowledge are rules-only (callModel=false), reflection/question
//    call the model (callModel=true) — the L1-2 / L3-4 split;
//  - questions are rare and earned (invited, or substantive past the opening turn
//    with the cooldown elapsed).
//
// su-lou.10.3 widened the gate's INPUT from `GateTurn { turn, text, endReason }`
// plus a separate history array to a single structured `EvalContext`, without
// moving the policy. The equivalence proof against the pre-refactor gate lives in
// response-hierarchy.equivalence.test.ts; what this file adds for the widening is
// the threshold behaviour around `completionProb` and — load-bearing for "stage 2
// is not authorised" — that the newly carried timing signals change NOTHING.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideTier,
  completionProbFromTurnEnd,
  wordCount,
  tierRank,
  maxTier,
  minTier,
  tierCallsModel,
  toChatMessages,
  buildListenerRequest,
  tierInstruction,
  TIERS,
  DEFAULT_ACKS,
  DEFAULT_SUBSTANTIVE_WORDS,
  DEFAULT_COMPLETION_THRESHOLD,
  type EvalContext,
  type PriorDecision,
} from './response-hierarchy.ts';

// A substantive utterance: >= DEFAULT_SUBSTANTIVE_WORDS (12) words, finished.
const SUBSTANTIVE =
  'so the core idea is that the patience window should stretch when the thinker keeps building';
// A short, finished aside: < 12 words, no question, no trailing-off.
const SHORT = 'that makes sense to me';

// The two EOU verdicts the pre-widening gate could express, as probabilities: the
// same certainty stand-ins main.ts bridges the detector's turn-end reason to.
const COMPLETE = completionProbFromTurnEnd('floor'); // a clean finish
const INCOMPLETE = completionProbFromTurnEnd('extended'); // held open mid-thought

/**
 * An EvalContext with everything but the text defaulted: utterance 1, a pause the
 * classifier scored COMPLETE, a floor-length pause, a companion that has not spoken,
 * and no history. Each test overrides only the field it is about.
 */
function ctx(text: string, over: Partial<EvalContext> = {}): EvalContext {
  return {
    utteranceIndex: 1,
    utteranceTextSoFar: text,
    completionProb: COMPLETE,
    msSinceSpeechEnd: 2000,
    msSinceWeLastSpoke: Infinity,
    priorDecisions: [],
    ...over,
  };
}

// ── tier helpers ──

test('TIERS is the canonical hierarchy, lowest → highest', () => {
  assert.deepEqual([...TIERS], ['silence', 'acknowledge', 'reflection', 'question']);
  assert.equal(tierRank('silence'), 0);
  assert.equal(tierRank('question'), 3);
  assert.equal(maxTier('silence', 'reflection'), 'reflection');
  assert.equal(minTier('question', 'acknowledge'), 'acknowledge');
});

test('tierCallsModel: only reflection/question invoke the LLM', () => {
  assert.equal(tierCallsModel('silence'), false);
  assert.equal(tierCallsModel('acknowledge'), false);
  assert.equal(tierCallsModel('reflection'), true);
  assert.equal(tierCallsModel('question'), true);
});

test('wordCount is whitespace-split and ignores blank runs', () => {
  assert.equal(wordCount('  one   two  three '), 3);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
});

// ── restraint: unfinished thoughts are never escalated (B1) ──

test('empty transcript → silence, no model', () => {
  const d = decideTier(ctx(''));
  assert.equal(d.tier, 'silence');
  assert.equal(d.callModel, false);
});

test('EOU scored the pause incomplete → silence, even for substantive text', () => {
  const d = decideTier(ctx(SUBSTANTIVE, { completionProb: INCOMPLETE }));
  assert.equal(d.tier, 'silence');
  assert.equal(d.callModel, false);
  assert.match(d.reason, /incomplete/);
});

test('an incomplete pause that even ends in a question is still held (audio beats text)', () => {
  const d = decideTier(ctx('wait, but what if the floor is wrong?', { completionProb: INCOMPLETE }));
  assert.equal(d.tier, 'silence');
});

test('trailing-off punctuation → silence (still going)', () => {
  for (const tail of ['and then…', 'because,', 'so the thing is —', 'well-', 'and it was, like,']) {
    const d = decideTier(ctx(tail));
    assert.equal(d.tier, 'silence', `expected silence for "${tail}"`);
    assert.equal(d.callModel, false);
  }
});

// ── the widened contract: a probability, not a boolean ──

test('completionProb is compared against the threshold, not truthiness', () => {
  const t = DEFAULT_COMPLETION_THRESHOLD;
  // At/above the threshold the thought is finished — the gate may escalate.
  assert.equal(decideTier(ctx(SUBSTANTIVE, { completionProb: t })).tier, 'reflection');
  assert.equal(decideTier(ctx(SUBSTANTIVE, { completionProb: 0.9 })).tier, 'reflection');
  // Below it the thinker is mid-thought — B1 holds silence however good the words.
  assert.equal(decideTier(ctx(SUBSTANTIVE, { completionProb: t - Number.EPSILON })).tier, 'silence');
  assert.equal(decideTier(ctx(SUBSTANTIVE, { completionProb: 0.49 })).tier, 'silence');
});

test('completionThreshold config: a higher bar makes the gate more patient', () => {
  const prob = 0.6;
  assert.equal(decideTier(ctx(SUBSTANTIVE, { completionProb: prob })).tier, 'reflection');
  const d = decideTier(ctx(SUBSTANTIVE, { completionProb: prob }), { completionThreshold: 0.8 });
  assert.equal(d.tier, 'silence'); // same score, stricter bar → held
});

test('a non-finite completionProb fails safe to silence (no usable EOU verdict)', () => {
  // Widening a two-valued reason into a real number admits values it could not
  // express. "No verdict" must read as "might still be talking", never as complete.
  for (const bad of [NaN, undefined as unknown as number, null as unknown as number]) {
    const d = decideTier(ctx(SUBSTANTIVE, { completionProb: bad }));
    assert.equal(d.tier, 'silence', `expected silence for completionProb=${String(bad)}`);
    assert.equal(d.callModel, false);
  }
});

test('completionProbFromTurnEnd bridges the detector reason for any threshold in (0,1]', () => {
  for (const threshold of [0.01, 0.5, 0.9, 1]) {
    const held = decideTier(ctx(SUBSTANTIVE, { completionProb: completionProbFromTurnEnd('extended') }), {
      completionThreshold: threshold,
    });
    const clean = decideTier(ctx(SUBSTANTIVE, { completionProb: completionProbFromTurnEnd('floor') }), {
      completionThreshold: threshold,
    });
    assert.equal(held.tier, 'silence', `extended should hold at threshold ${threshold}`);
    assert.notEqual(clean.tier, 'silence', `floor should not hold at threshold ${threshold}`);
  }
});

// Stage 1 carries the timing signals so stage 2 can use them; reading one HERE
// would be the unauthorised policy change. Pin that they are inert.
test('the carried timing signals do not influence the stage-1 policy', () => {
  const timings: Array<Pick<EvalContext, 'msSinceSpeechEnd' | 'msSinceWeLastSpoke'>> = [
    { msSinceSpeechEnd: 0, msSinceWeLastSpoke: 0 },
    { msSinceSpeechEnd: 250, msSinceWeLastSpoke: 500 },
    { msSinceSpeechEnd: 60_000, msSinceWeLastSpoke: Infinity },
    { msSinceSpeechEnd: Infinity, msSinceWeLastSpoke: 1 },
    // NaN is a value main.ts actually sends: the "no speech-end to measure from"
    // sentinel (see EvalContext.msSinceSpeechEnd) — it must be as inert as any number.
    { msSinceSpeechEnd: NaN, msSinceWeLastSpoke: 3000 },
  ];
  const history: PriorDecision[] = [{ turn: 1, tier: 'reflection' }];
  for (const text of ['', SHORT, SUBSTANTIVE, 'and then…', 'does that make sense?']) {
    for (const completionProb of [COMPLETE, INCOMPLETE]) {
      const baseline = decideTier(ctx(text, { utteranceIndex: 2, completionProb, priorDecisions: history }));
      for (const timing of timings) {
        const d = decideTier(
          ctx(text, { utteranceIndex: 2, completionProb, priorDecisions: history, ...timing }),
        );
        assert.deepEqual(d, baseline, `timing changed the decision for "${text}" @ ${completionProb}`);
      }
    }
  }
});

// ── acknowledge: short finished asides, rules-only ──

test('short finished aside → acknowledge with a rules-produced backchannel, no model', () => {
  const d = decideTier(ctx(SHORT));
  assert.equal(d.tier, 'acknowledge');
  assert.equal(d.callModel, false);
  assert.ok(d.ackText && DEFAULT_ACKS.includes(d.ackText), `ackText should be a default ack, got ${d.ackText}`);
});

test('acknowledgment rotates by utterance so a gated run does not stick', () => {
  const a1 = decideTier(ctx(SHORT, { utteranceIndex: 1 })).ackText;
  const a2 = decideTier(ctx(SHORT, { utteranceIndex: 2 })).ackText;
  const a5 = decideTier(ctx(SHORT, { utteranceIndex: 5 })).ackText;
  assert.notEqual(a1, a2); // adjacent utterances differ
  assert.equal(a5, DEFAULT_ACKS[5 % DEFAULT_ACKS.length]); // deterministic rotation
});

// ── reflection / question: the substantive tiers, escalate slowly ──

test('substantive opening turn → reflection, not a question (never open with a question)', () => {
  const d = decideTier(ctx(SUBSTANTIVE, { utteranceIndex: 1, priorDecisions: [] }));
  assert.equal(d.tier, 'reflection');
  assert.equal(d.callModel, true);
});

test('substantive turn past the opening, cooldown elapsed → question', () => {
  const history: PriorDecision[] = [{ turn: 1, tier: 'reflection' }];
  const d = decideTier(ctx(SUBSTANTIVE, { utteranceIndex: 2, priorDecisions: history }));
  assert.equal(d.tier, 'question');
  assert.equal(d.callModel, true);
});

test('a direct question from the thinker → question, even on the opening turn', () => {
  const d = decideTier(ctx('does that make any sense?', { utteranceIndex: 1, priorDecisions: [] }));
  assert.equal(d.tier, 'question');
  assert.equal(d.callModel, true);
  assert.match(d.reason, /asked a question/);
});

test('question cooldown: a substantive turn too soon after a question falls back to reflection', () => {
  // Last question was turn 3; cooldown is 2, so turn 4 (gap 1) may not question again.
  const history: PriorDecision[] = [
    { turn: 1, tier: 'reflection' },
    { turn: 3, tier: 'question' },
  ];
  const d = decideTier(ctx(SUBSTANTIVE, { utteranceIndex: 4, priorDecisions: history }));
  assert.equal(d.tier, 'reflection');
});

test('question cooldown clears once enough turns have passed', () => {
  const history: PriorDecision[] = [
    { turn: 1, tier: 'reflection' },
    { turn: 3, tier: 'question' },
  ];
  // gap 2 == cooldown → allowed again.
  const d = decideTier(ctx(SUBSTANTIVE, { utteranceIndex: 5, priorDecisions: history }));
  assert.equal(d.tier, 'question');
});

test('a direct question bypasses the cooldown (answering an ask is not escalating)', () => {
  const history: PriorDecision[] = [{ turn: 2, tier: 'question' }];
  const d = decideTier(ctx('right?', { utteranceIndex: 3, priorDecisions: history }));
  assert.equal(d.tier, 'question');
});

test('word-count boundary: exactly the threshold is substantive; one under is an aside', () => {
  const atThreshold = Array.from({ length: DEFAULT_SUBSTANTIVE_WORDS }, (_, i) => `w${i}`).join(' ');
  const underThreshold = Array.from({ length: DEFAULT_SUBSTANTIVE_WORDS - 1 }, (_, i) => `w${i}`).join(' ');
  assert.equal(decideTier(ctx(atThreshold, { utteranceIndex: 1 })).tier, 'reflection');
  assert.equal(decideTier(ctx(underThreshold, { utteranceIndex: 1 })).tier, 'acknowledge');
});

test('config overrides: a lower substantive threshold escalates a shorter turn', () => {
  const d = decideTier(ctx(SHORT, { utteranceIndex: 1 }), { substantiveWords: 3 });
  assert.equal(d.tier, 'reflection'); // SHORT is 5 words ≥ 3
});

// ── prompt construction ──

test('tierInstruction: reflection forbids a question; question permits exactly one', () => {
  assert.match(tierInstruction('reflection'), /Do NOT ask a question/i);
  assert.match(tierInstruction('question'), /ONE brief follow-up question/i);
  assert.equal(tierInstruction('silence'), '');
  assert.equal(tierInstruction('acknowledge'), '');
});

test('toChatMessages prepends system, drops empty turns, merges consecutive same-role', () => {
  const msgs = toChatMessages('SYS', [
    { speaker: 'thinker', text: 'first thought' },
    { speaker: 'listener', text: '' }, // silent — dropped
    { speaker: 'thinker', text: 'still me' }, // merges with previous user
    { speaker: 'listener', text: 'mm' },
  ]);
  assert.deepEqual(msgs, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'first thought\n\nstill me' },
    { role: 'assistant', content: 'mm' },
  ]);
});

test('buildListenerRequest appends the current turn as the final user message + folds in the tier instruction', () => {
  const req = buildListenerRequest({
    systemPrompt: 'You are a quiet companion.',
    tier: 'reflection',
    currentTurnText: 'so here is the idea',
    history: [
      { speaker: 'thinker', text: 'earlier idea' },
      { speaker: 'listener', text: 'mm' },
    ],
  });
  assert.equal(req.tier, 'reflection');
  assert.ok(req.maxNewTokens > 0);
  const system = req.messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /quiet companion/);
  assert.match(system.content, /Do NOT ask a question/i); // tier instruction folded in
  const last = req.messages[req.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content, 'so here is the idea');
  // strictly alternating user/assistant after the system message
  for (let i = 1; i < req.messages.length - 1; i += 1) {
    assert.notEqual(req.messages[i].role, req.messages[i + 1].role);
  }
});

test('decideTier is pure — identical inputs give identical decisions', () => {
  const c = ctx(SUBSTANTIVE, { utteranceIndex: 2, priorDecisions: [{ turn: 1, tier: 'reflection' }] });
  assert.deepEqual(decideTier(c), decideTier(c));
});

// End-to-end escalate-slowly arc: feed a whole conversation through the gate,
// threading each decision into the history the way main.ts does. This pins the
// POLICY as a sequence, not just per-turn: silence/ack dominate, a question is
// never the opening move and never fires twice inside the cooldown.
test('a full conversation escalates slowly and holds through unfinished thoughts', () => {
  const history: PriorDecision[] = [];
  const run = (utteranceIndex: number, text: string, completionProb = COMPLETE): string => {
    const d = decideTier(ctx(text, { utteranceIndex, completionProb, priorDecisions: history }));
    history.push({ turn: utteranceIndex, tier: d.tier });
    return d.tier;
  };

  // 1: opening substantive dump — reflect, never open with a question.
  assert.equal(run(1, SUBSTANTIVE), 'reflection');
  // 2: thinker trails off mid-thought → hold silence (B1), whatever the words.
  assert.equal(run(2, 'and the thing about that is,'), 'silence');
  // 3: EOU scored the pause incomplete → still silence.
  assert.equal(run(3, SUBSTANTIVE, INCOMPLETE), 'silence');
  // 4: a short finished aside → minimal acknowledgment.
  assert.equal(run(4, SHORT), 'acknowledge');
  // 5: another substantive, finished turn, cooldown long elapsed → a question is earned.
  assert.equal(run(5, SUBSTANTIVE), 'question');
  // 6: substantive again, but immediately after a question → back to reflection (cooldown).
  assert.equal(run(6, SUBSTANTIVE), 'reflection');

  // Questions stayed rare: exactly one across the arc.
  assert.equal(history.filter((h) => h.tier === 'question').length, 1);
});
