// Tests for the response-hierarchy gate (response-hierarchy.ts).
//
// The gate is pure, so — like turn-detection.ts and transcript.ts — the whole
// escalate-slowly policy is pinned headlessly here. The contract under test:
//  - an unfinished thought is NEVER escalated (B1), whether the "still going"
//    signal is the detector's veto (endReason 'extended') or trailing-off text;
//  - silence/acknowledge are rules-only (callModel=false), reflection/question
//    call the model (callModel=true) — the L1-2 / L3-4 split;
//  - questions are rare and earned (invited, or substantive past the opening turn
//    with the cooldown elapsed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideTier,
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
  type GateTurn,
  type PriorDecision,
} from './response-hierarchy.ts';

// A substantive utterance: >= DEFAULT_SUBSTANTIVE_WORDS (12) words, finished.
const SUBSTANTIVE =
  'so the core idea is that the patience window should stretch when the thinker keeps building';
// A short, finished aside: < 12 words, no question, no trailing-off.
const SHORT = 'that makes sense to me';

function turn(over: Partial<GateTurn> & { text: string }): GateTurn {
  return { turn: 1, endReason: 'floor', ...over };
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
  const d = decideTier(turn({ text: '' }));
  assert.equal(d.tier, 'silence');
  assert.equal(d.callModel, false);
});

test("detector held the turn (endReason 'extended') → silence, even for substantive text", () => {
  const d = decideTier(turn({ text: SUBSTANTIVE, endReason: 'extended' }));
  assert.equal(d.tier, 'silence');
  assert.equal(d.callModel, false);
  assert.match(d.reason, /incomplete/);
});

test("an 'extended' turn that even ends in a question is still held (audio beats text)", () => {
  const d = decideTier(turn({ text: 'wait, but what if the floor is wrong?', endReason: 'extended' }));
  assert.equal(d.tier, 'silence');
});

test('trailing-off punctuation → silence (still going)', () => {
  for (const tail of ['and then…', 'because,', 'so the thing is —', 'well-', 'and it was, like,']) {
    const d = decideTier(turn({ text: tail }));
    assert.equal(d.tier, 'silence', `expected silence for "${tail}"`);
    assert.equal(d.callModel, false);
  }
});

// ── acknowledge: short finished asides, rules-only ──

test('short finished aside → acknowledge with a rules-produced backchannel, no model', () => {
  const d = decideTier(turn({ text: SHORT }));
  assert.equal(d.tier, 'acknowledge');
  assert.equal(d.callModel, false);
  assert.ok(d.ackText && DEFAULT_ACKS.includes(d.ackText), `ackText should be a default ack, got ${d.ackText}`);
});

test('acknowledgment rotates by turn number so a gated run does not stick', () => {
  const a1 = decideTier(turn({ turn: 1, text: SHORT })).ackText;
  const a2 = decideTier(turn({ turn: 2, text: SHORT })).ackText;
  const a5 = decideTier(turn({ turn: 5, text: SHORT })).ackText;
  assert.notEqual(a1, a2); // adjacent turns differ
  assert.equal(a5, DEFAULT_ACKS[5 % DEFAULT_ACKS.length]); // deterministic rotation
});

// ── reflection / question: the substantive tiers, escalate slowly ──

test('substantive opening turn → reflection, not a question (never open with a question)', () => {
  const d = decideTier(turn({ turn: 1, text: SUBSTANTIVE }), []);
  assert.equal(d.tier, 'reflection');
  assert.equal(d.callModel, true);
});

test('substantive turn past the opening, cooldown elapsed → question', () => {
  const history: PriorDecision[] = [{ turn: 1, tier: 'reflection' }];
  const d = decideTier(turn({ turn: 2, text: SUBSTANTIVE }), history);
  assert.equal(d.tier, 'question');
  assert.equal(d.callModel, true);
});

test('a direct question from the thinker → question, even on the opening turn', () => {
  const d = decideTier(turn({ turn: 1, text: 'does that make any sense?' }), []);
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
  const d = decideTier(turn({ turn: 4, text: SUBSTANTIVE }), history);
  assert.equal(d.tier, 'reflection');
});

test('question cooldown clears once enough turns have passed', () => {
  const history: PriorDecision[] = [
    { turn: 1, tier: 'reflection' },
    { turn: 3, tier: 'question' },
  ];
  // gap 2 == cooldown → allowed again.
  const d = decideTier(turn({ turn: 5, text: SUBSTANTIVE }), history);
  assert.equal(d.tier, 'question');
});

test('a direct question bypasses the cooldown (answering an ask is not escalating)', () => {
  const history: PriorDecision[] = [{ turn: 2, tier: 'question' }];
  const d = decideTier(turn({ turn: 3, text: 'right?' }), history);
  assert.equal(d.tier, 'question');
});

test('word-count boundary: exactly the threshold is substantive; one under is an aside', () => {
  const atThreshold = Array.from({ length: DEFAULT_SUBSTANTIVE_WORDS }, (_, i) => `w${i}`).join(' ');
  const underThreshold = Array.from({ length: DEFAULT_SUBSTANTIVE_WORDS - 1 }, (_, i) => `w${i}`).join(' ');
  assert.equal(decideTier(turn({ turn: 1, text: atThreshold })).tier, 'reflection');
  assert.equal(decideTier(turn({ turn: 1, text: underThreshold })).tier, 'acknowledge');
});

test('config overrides: a lower substantive threshold escalates a shorter turn', () => {
  const d = decideTier(turn({ turn: 1, text: SHORT }), [], { substantiveWords: 3 });
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
  const t = turn({ turn: 2, text: SUBSTANTIVE });
  const h: PriorDecision[] = [{ turn: 1, tier: 'reflection' }];
  assert.deepEqual(decideTier(t, h), decideTier(t, h));
});

// End-to-end escalate-slowly arc: feed a whole conversation through the gate,
// threading each decision into the history the way main.ts does. This pins the
// POLICY as a sequence, not just per-turn: silence/ack dominate, a question is
// never the opening move and never fires twice inside the cooldown.
test('a full conversation escalates slowly and holds through unfinished thoughts', () => {
  const history: PriorDecision[] = [];
  const run = (t: GateTurn): string => {
    const d = decideTier(t, history);
    history.push({ turn: t.turn, tier: d.tier });
    return d.tier;
  };

  // 1: opening substantive dump — reflect, never open with a question.
  assert.equal(run(turn({ turn: 1, text: SUBSTANTIVE })), 'reflection');
  // 2: thinker trails off mid-thought → hold silence (B1), whatever the words.
  assert.equal(run(turn({ turn: 2, text: 'and the thing about that is,' })), 'silence');
  // 3: detector held the turn open (incomplete) → still silence.
  assert.equal(run(turn({ turn: 3, text: SUBSTANTIVE, endReason: 'extended' })), 'silence');
  // 4: a short finished aside → minimal acknowledgment.
  assert.equal(run(turn({ turn: 4, text: SHORT })), 'acknowledge');
  // 5: another substantive, finished turn, cooldown long elapsed → a question is earned.
  assert.equal(run(turn({ turn: 5, text: SUBSTANTIVE })), 'question');
  // 6: substantive again, but immediately after a question → back to reflection (cooldown).
  assert.equal(run(turn({ turn: 6, text: SUBSTANTIVE })), 'reflection');

  // Questions stayed rare: exactly one across the arc.
  assert.equal(history.filter((h) => h.tier === 'question').length, 1);
});
