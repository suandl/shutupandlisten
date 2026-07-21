// Equivalence proof: the pre-widening gate vs. the EvalContext gate.
//
// su-lou.10.3 replaced decideTier's input — `GateTurn { turn, text, endReason }`
// plus a separate history array — with a structured `EvalContext` that carries the
// EOU completion PROBABILITY, the pause's elapsed time, and how long since the
// companion last spoke. It had to do that WITHOUT moving the policy: widening the
// contract is stage 1; letting the new signals change any decision is stage 2, and
// stage 2 is not authorised (su-lou.10).
//
// "Behaviour-preserving" is a claim that can be checked mechanically rather than
// asserted, so this file checks it. `legacyDecideTier` below is the implementation
// exactly as it stood at fb0a315, the commit this unit branched from, together with
// the constants and helpers it closed over. It is FROZEN and self-contained on
// purpose — an oracle, not a second implementation to keep up to date. It does not
// import wordCount or the ack list from the live module, so a change to either
// would surface here as a behavioural diff instead of moving both sides in step.
//
// If these tests ever fail, the policy moved. That is the signal, not the bug:
// moving it takes its own authorisation (stage 2 + a spec amendment), never a
// quiet edit inside a refactor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideTier,
  completionProbFromTurnEnd,
  DEFAULT_SUBSTANTIVE_WORDS,
  type EvalContext,
  type GateDecision,
  type PriorDecision,
  type Tier,
  type TurnEndReason,
} from './response-hierarchy.ts';

// ── the frozen pre-refactor gate (fb0a315), verbatim ──

interface LegacyGateTurn {
  turn: number;
  text: string;
  endReason: TurnEndReason;
}

interface LegacyGateConfig {
  substantiveWords: number;
  acks: readonly string[];
  questionCooldownTurns: number;
}

const LEGACY_ACKS: readonly string[] = ['mm', 'yeah', 'mhm', 'right', 'mm-hm'] as const;
const LEGACY_DEFAULT_GATE_CONFIG: LegacyGateConfig = {
  substantiveWords: 12,
  acks: LEGACY_ACKS,
  questionCooldownTurns: 2,
};

function legacyWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const LEGACY_TRAILING_OFF = /[…,\-—]$/;

function legacyDecideTier(
  turn: LegacyGateTurn,
  history: readonly PriorDecision[] = [],
  config: Partial<LegacyGateConfig> = {},
): GateDecision {
  const cfg: LegacyGateConfig = { ...LEGACY_DEFAULT_GATE_CONFIG, ...config };
  const text = turn.text.trim();
  const words = legacyWordCount(text);

  if (words === 0) {
    return { tier: 'silence', callModel: false, reason: 'no transcript — holding silence' };
  }

  if (turn.endReason === 'extended') {
    return { tier: 'silence', callModel: false, reason: 'detector held turn open (incomplete) — holding silence' };
  }

  if (LEGACY_TRAILING_OFF.test(text)) {
    return { tier: 'silence', callModel: false, reason: 'trailing off mid-thought — holding silence' };
  }

  const invited = /\?/.test(text);
  const substantive = words >= cfg.substantiveWords;

  if (!invited && !substantive) {
    const ackText = cfg.acks[((turn.turn % cfg.acks.length) + cfg.acks.length) % cfg.acks.length];
    return { tier: 'acknowledge', callModel: false, ackText, reason: `brief turn (${words}w) — minimal acknowledgment` };
  }

  const priorTurns = history.length;
  const lastQuestionTurn = history.reduce<number | null>(
    (acc, d) => (d.tier === 'question' ? (acc === null ? d.turn : Math.max(acc, d.turn)) : acc),
    null,
  );
  const sinceLastQuestion = lastQuestionTurn === null ? Infinity : turn.turn - lastQuestionTurn;
  const questionEarned =
    invited || (substantive && priorTurns >= 1 && sinceLastQuestion >= cfg.questionCooldownTurns);

  if (questionEarned) {
    return {
      tier: 'question',
      callModel: true,
      reason: invited ? 'thinker asked a question — one brief reply' : `substantive turn (${words}w), question cooldown elapsed`,
    };
  }
  return { tier: 'reflection', callModel: true, reason: `substantive turn (${words}w) — short reflection` };
}

// ── the conversion under test ──
//
// This is the SAME mapping main.ts performs at the call site: the two-valued
// turn-end reason becomes a completion probability via the module's own bridge, so
// the matrix below exercises the production path rather than a test-local shim.
// The timing fields the legacy gate never had are filled from `timing` — the sweep
// varies them precisely to show they cannot change the outcome.
function toEvalContext(
  turn: LegacyGateTurn,
  history: readonly PriorDecision[],
  timing: Pick<EvalContext, 'msSinceSpeechEnd' | 'msSinceWeLastSpoke'>,
): EvalContext {
  return {
    utteranceIndex: turn.turn,
    utteranceTextSoFar: turn.text,
    completionProb: completionProbFromTurnEnd(turn.endReason),
    priorDecisions: history,
    ...timing,
  };
}

// ── the matrix ──

// Texts chosen to reach every rule and both sides of each boundary.
const TEXTS: readonly string[] = [
  '', // rule 1: nothing transcribed
  '   ', // rule 1: whitespace only
  'mm', // rule 4: one word
  'that makes sense to me', // rule 4: short finished aside
  'so the core idea is that the patience window should stretch when the thinker keeps building', // rule 5: substantive
  Array.from({ length: DEFAULT_SUBSTANTIVE_WORDS }, (_, i) => `w${i}`).join(' '), // rule 5: exactly the threshold
  Array.from({ length: DEFAULT_SUBSTANTIVE_WORDS - 1 }, (_, i) => `w${i}`).join(' '), // rule 4: one under
  'and then…', // rule 3: ellipsis
  'because,', // rule 3: comma
  'so the thing is —', // rule 3: em dash
  'well-', // rule 3: hyphen
  'right?', // rule 5: short but invited
  'does that make any sense?', // rule 5: invited
  'wait, but what if the floor is wrong?', // invited AND held when incomplete
  'is it, ', // invited but trails off — rule 3 wins over rule 5
  '   padded words with space   ', // untrimmed input
];

const END_REASONS: readonly TurnEndReason[] = ['floor', 'extended'];

// Includes 0 and a negative to exercise the ack rotation's modulo guard.
const UTTERANCE_INDEXES: readonly number[] = [-1, 0, 1, 2, 3, 4, 5, 6];

const HISTORIES: ReadonlyArray<readonly PriorDecision[]> = [
  [],
  [{ turn: 1, tier: 'reflection' }],
  [{ turn: 1, tier: 'acknowledge' }],
  [
    { turn: 1, tier: 'reflection' },
    { turn: 3, tier: 'question' },
  ],
  [{ turn: 2, tier: 'question' }],
  [
    { turn: 1, tier: 'question' },
    { turn: 2, tier: 'silence' },
    { turn: 5, tier: 'question' },
  ],
];

const CONFIGS: ReadonlyArray<Partial<LegacyGateConfig>> = [
  {},
  { substantiveWords: 3 },
  { substantiveWords: 40 },
  { questionCooldownTurns: 0 },
  { questionCooldownTurns: 5 },
  { acks: ['a', 'b'] },
];

// The timing signals the widened contract added. The legacy gate had no equivalent,
// so equivalence must hold for EVERY value: that is exactly the claim that stage 1
// carries them without reading them.
const TIMINGS: ReadonlyArray<Pick<EvalContext, 'msSinceSpeechEnd' | 'msSinceWeLastSpoke'>> = [
  { msSinceSpeechEnd: 0, msSinceWeLastSpoke: 0 },
  { msSinceSpeechEnd: 2000, msSinceWeLastSpoke: Infinity },
  { msSinceSpeechEnd: 120_000, msSinceWeLastSpoke: 50 },
];

test('EvalContext gate reproduces the pre-refactor gate across the whole rule matrix', () => {
  const tiersSeen = new Set<Tier>();
  const reasonsSeen = new Set<string>();
  let cases = 0;

  for (const text of TEXTS) {
    for (const endReason of END_REASONS) {
      for (const turnIndex of UTTERANCE_INDEXES) {
        for (const history of HISTORIES) {
          for (const config of CONFIGS) {
            const legacyTurn: LegacyGateTurn = { turn: turnIndex, text, endReason };
            const expected = legacyDecideTier(legacyTurn, history, config);

            for (const timing of TIMINGS) {
              const actual = decideTier(toEvalContext(legacyTurn, history, timing), config);
              assert.deepEqual(
                actual,
                expected,
                `diverged for text=${JSON.stringify(text)} endReason=${endReason} ` +
                  `utterance=${turnIndex} history=${JSON.stringify(history)} ` +
                  `config=${JSON.stringify(config)} timing=${JSON.stringify(timing)}`,
              );
              cases += 1;
            }

            tiersSeen.add(expected.tier);
            reasonsSeen.add(expected.reason.replace(/\(\d+w\)/, '(Nw)'));
          }
        }
      }
    }
  }

  // A matrix that never reaches a rule proves nothing about that rule, so pin the
  // coverage too: all four rungs, and every distinct outcome the five rules emit.
  assert.deepEqual([...tiersSeen].sort(), ['acknowledge', 'question', 'reflection', 'silence']);
  assert.deepEqual(
    [...reasonsSeen].sort(),
    [
      'brief turn (Nw) — minimal acknowledgment',
      'detector held turn open (incomplete) — holding silence',
      'no transcript — holding silence',
      'substantive turn (Nw) — short reflection',
      'substantive turn (Nw), question cooldown elapsed',
      'thinker asked a question — one brief reply',
      'trailing off mid-thought — holding silence',
    ],
    'the matrix must exercise every outcome the five rules can produce',
  );
  assert.ok(cases > 1000, `expected a broad sweep, only ran ${cases} cases`);
});

// The arc test in response-hierarchy.test.ts pins the policy as a SEQUENCE. Replay
// the same shape through both gates: a per-turn match can still hide a divergence
// that only shows once decisions feed back in as history.
test('a threaded conversation decides identically under both gates', () => {
  const script: ReadonlyArray<{ text: string; endReason: TurnEndReason }> = [
    { text: 'so the core idea is that the patience window should stretch when the thinker keeps building', endReason: 'floor' },
    { text: 'and the thing about that is,', endReason: 'floor' },
    { text: 'so the core idea is that the patience window should stretch when the thinker keeps building', endReason: 'extended' },
    { text: 'that makes sense to me', endReason: 'floor' },
    { text: 'so the core idea is that the patience window should stretch when the thinker keeps building', endReason: 'floor' },
    { text: 'so the core idea is that the patience window should stretch when the thinker keeps building', endReason: 'floor' },
    { text: 'does that follow?', endReason: 'floor' },
    { text: '', endReason: 'floor' },
    { text: 'right', endReason: 'floor' },
  ];

  const legacyHistory: PriorDecision[] = [];
  const actualHistory: PriorDecision[] = [];

  script.forEach((step, i) => {
    const turnIndex = i + 1;
    const expected = legacyDecideTier({ turn: turnIndex, ...step }, legacyHistory);
    const actual = decideTier(
      toEvalContext({ turn: turnIndex, ...step }, actualHistory, {
        msSinceSpeechEnd: 2000,
        msSinceWeLastSpoke: turnIndex * 1000,
      }),
    );
    assert.deepEqual(actual, expected, `diverged at turn ${turnIndex} (${step.text})`);
    legacyHistory.push({ turn: turnIndex, tier: expected.tier });
    actualHistory.push({ turn: turnIndex, tier: actual.tier });
  });

  assert.deepEqual(actualHistory, legacyHistory);
});
