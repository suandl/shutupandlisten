// Tests for the pure transcript-alignment logic (transcript.ts).
//
// Runs with zero dependencies via Node's built-in runner + type stripping:
//   node --test 'src/**/*.test.ts'
// The grouping rule — "a segment belongs to the latest turn-start at or before
// its speech-end" — is what aligns words to turn boundaries, so it gets the same
// headless-test discipline as the detector itself.
//
// su-lou.10.4: a turn is one UTTERANCE and can close its patience window several
// times, so the end marks are keyed by evaluation and the latest one wins.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupTranscript, recordTurnEnd } from './transcript.ts';
import type { TranscriptSegment, TurnStartMark, TurnEndMark, TurnEndClosure } from './transcript.ts';

function seg(id: number, startT: number, endT: number, over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { id, startT, endT, text: `seg${id}`, mode: 'stub', pending: false, ...over };
}

test('several segments under one turn: a sub-floor thinking-pause keeps the same turn', () => {
  const starts: TurnStartMark[] = [{ turn: 1, t: 0 }];
  const ends: TurnEndMark[] = [{ turn: 1, evaluation: 1, t: 5000, reason: 'extended' }];
  const groups = groupTranscript({
    segments: [seg(0, 0, 1000), seg(1, 1500, 2500)],
    turnStarts: starts,
    turnEnds: ends,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].turn, 1);
  assert.deepEqual(
    groups[0].segments.map((s) => s.id),
    [0, 1],
  );
  assert.deepEqual(groups[0].end, { turn: 1, evaluation: 1, t: 5000, reason: 'extended' });
});

// A turn the gate declined to speak into stays open, so its later words join the
// SAME group and the newest of its several end marks is the one on show.
test('several evaluations on one turn: the words stay together and the latest mark wins', () => {
  const groups = groupTranscript({
    segments: [seg(0, 0, 1000, { text: 'so the core idea' }), seg(1, 1500, 2500, { text: 'is patience' })],
    turnStarts: [{ turn: 1, t: 0 }],
    turnEnds: [
      { turn: 1, evaluation: 1, t: 1500, reason: 'floor' }, // declined; the thinker kept going
      { turn: 1, evaluation: 2, t: 3000, reason: 'floor' },
    ],
  });
  assert.equal(groups.length, 1, 'one utterance, not one group per evaluation');
  assert.deepEqual(groups[0].segments.map((s) => s.text), ['so the core idea', 'is patience']);
  assert.equal(groups[0].end?.evaluation, 2, 'the live window, not the superseded one');
  assert.equal(groups[0].end?.t, 3000);
});

test('a later evaluation wins even if the marks arrive out of order', () => {
  const groups = groupTranscript({
    segments: [seg(0, 0, 1000)],
    turnStarts: [{ turn: 1, t: 0 }],
    turnEnds: [
      { turn: 1, evaluation: 2, t: 3000, reason: 'floor' },
      { turn: 1, evaluation: 1, t: 1500, reason: 'extended' },
    ],
  });
  assert.equal(groups[0].end?.evaluation, 2);
});

test('segments assign to the right turn by speech-end time', () => {
  const groups = groupTranscript({
    segments: [seg(0, 0, 1000), seg(1, 3500, 4500)],
    turnStarts: [
      { turn: 1, t: 0 },
      { turn: 2, t: 3500 },
    ],
    turnEnds: [
      { turn: 1, evaluation: 1, t: 3000, reason: 'floor' },
      { turn: 2, evaluation: 2, t: 6500, reason: 'floor' },
    ],
  });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].segments.map((s) => s.id), [0]);
  assert.equal(groups[0].end?.reason, 'floor');
  assert.deepEqual(groups[1].segments.map((s) => s.id), [1]);
  assert.equal(groups[1].turn, 2);
});

test('an open turn (no turn-end yet) has a null end', () => {
  const groups = groupTranscript({
    segments: [seg(0, 0, 1000)],
    turnStarts: [{ turn: 1, t: 0 }],
    turnEnds: [],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].end, null);
});

test('a started turn with no transcript yet still appears (seeded)', () => {
  const groups = groupTranscript({
    segments: [seg(0, 0, 1000)],
    turnStarts: [
      { turn: 1, t: 0 },
      { turn: 2, t: 5000 },
    ],
    turnEnds: [{ turn: 1, evaluation: 1, t: 3000, reason: 'floor' }],
  });
  assert.equal(groups.length, 2);
  assert.equal(groups[1].turn, 2);
  assert.equal(groups[1].segments.length, 0);
  assert.equal(groups[1].end, null);
});

test('empty input yields no groups', () => {
  assert.deepEqual(groupTranscript({ segments: [], turnStarts: [], turnEnds: [] }), []);
});

test('a segment before any turn-start is never dropped (attached to earliest turn)', () => {
  const groups = groupTranscript({
    segments: [seg(0, 0, 500)],
    turnStarts: [{ turn: 2, t: 1000 }],
    turnEnds: [],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].turn, 2);
  assert.deepEqual(groups[0].segments.map((s) => s.id), [0]);
});

test('segments within a turn are ordered by start time', () => {
  const groups = groupTranscript({
    segments: [seg(2, 2000, 2500), seg(0, 0, 400), seg(1, 800, 1200)],
    turnStarts: [{ turn: 1, t: 0 }],
    turnEnds: [{ turn: 1, evaluation: 1, t: 4500, reason: 'floor' }],
  });
  assert.deepEqual(groups[0].segments.map((s) => s.id), [0, 1, 2]);
});

// ── recordTurnEnd: the host's turn-end bookkeeping (su-l74p) ────────────────────
//
// Lifted out of main.ts so it can be tested at all. It used to live inline in an
// event callback in a DOM entry point, which is how a P1 shipped past a suite that
// otherwise pins this contract from both ends: every test around it MIRRORED main's
// logic rather than running it, so the mirror stayed right while main drifted.

function closure(over: Partial<TurnEndClosure> = {}): TurnEndClosure {
  return { turn: 1, evaluation: 1, t: 1200, reason: 'floor', completionProb: null, ...over };
}

test('recordTurnEnd: a turn\'s first closure is recorded and opens a loop-metric origin', () => {
  const rec = recordTurnEnd([], closure({ completionProb: 0.6 }));
  assert.equal(rec.effect, 'opened');
  assert.equal(rec.clearedTurn, null, 'nothing was superseded');
  assert.deepEqual(rec.marks, [{ turn: 1, evaluation: 1, t: 1200, reason: 'floor', completionProb: 0.6 }]);
});

// THE REGRESSION. An evidence-driven re-emit (§4b) carries the same evaluation id: the
// window has not closed again, the evidence behind the question improved. Keeping the
// first mark wholesale — main.ts's `if (!turnEnds.some(m => m.evaluation === ...))` —
// strands the score the window closed WITH, which after a blind first evaluation is no
// score at all. The gate then bridges `reason: 'floor'` to a certain 1 and speaks into a
// pause the classifier has since scored 0.3. See the composed end-to-end in
// turn-detection.test.ts for that consequence.
test('recordTurnEnd: a same-evaluation re-emit refreshes the score and keeps the deadline', () => {
  const blind = recordTurnEnd([], closure({ t: 1200, reason: 'floor', completionProb: null }));
  const late = recordTurnEnd(blind.marks, closure({ t: 1250, reason: 'floor', completionProb: 0.3 }));

  assert.equal(late.effect, 'refreshed');
  assert.equal(late.clearedTurn, null);
  assert.equal(late.marks.length, 1, 'a re-emit is not a second mark');
  assert.equal(late.marks[0].completionProb, 0.3, 'the newer evidence wins — this is the fix');
  assert.equal(late.marks[0].t, 1200, 'the deadline is where the window closed, and it has not moved');
  assert.equal(late.marks[0].reason, 'floor', 'the patience reason describes that same deadline');
});

// The other direction of the same rule: newest evidence wins even when it is WEAKER.
// An EOU carrying a bare two-valued verdict clears the detector's graded score
// (`TurnSnapshot.completionProb` → null), and null is the honest reading — it routes the
// gate back to the reason-bridge, which is correct and only correct when there is no
// score. Pinning a stale 0.85 here would be a certainty no classifier expressed.
test('recordTurnEnd: a re-emit whose evidence is a bare verdict clears the stale score', () => {
  const scored = recordTurnEnd([], closure({ completionProb: 0.85 }));
  const bare = recordTurnEnd(scored.marks, closure({ t: 1300, completionProb: null }));
  assert.equal(bare.effect, 'refreshed');
  assert.equal(bare.marks[0].completionProb, null);
});

// A NEW evaluation on the same turn: the gate declined, the thinker kept going, and the
// window closed again further along. The predecessor's loop-metric origin belongs to an
// iteration that never happened, so the caller is told to clear it.
test('recordTurnEnd: a new evaluation on the same turn supersedes the old mark', () => {
  const first = recordTurnEnd([], closure({ evaluation: 1, t: 1200, completionProb: 0.6 }));
  const second = recordTurnEnd(first.marks, closure({ evaluation: 2, t: 5000, reason: 'extended', completionProb: 0.3 }));

  assert.equal(second.effect, 'opened', 'a fresh window closure is a fresh loop-metric origin');
  assert.equal(second.clearedTurn, 1, 'and the superseded origin must be cleared first');
  assert.deepEqual(second.marks, [
    { turn: 1, evaluation: 2, t: 5000, reason: 'extended', completionProb: 0.3 },
  ]);
});

test('recordTurnEnd: another turn\'s marks are left alone', () => {
  const prior: TurnEndMark[] = [{ turn: 1, evaluation: 1, t: 1200, reason: 'floor', completionProb: 0.6 }];
  const rec = recordTurnEnd(prior, closure({ turn: 2, evaluation: 2, t: 9000 }));
  assert.equal(rec.effect, 'opened');
  assert.equal(rec.clearedTurn, null, 'turn 2 superseded nothing — turn 1 keeps its origin');
  assert.deepEqual(rec.marks.map((m) => m.turn), [1, 2]);
});

// Pure: the caller holds the previous array (main.ts re-reads `turnEnds` on the next
// event) and must not see it change under a call it made for a different turn.
test('recordTurnEnd: never mutates the marks it was given', () => {
  const prior: TurnEndMark[] = [{ turn: 1, evaluation: 1, t: 1200, reason: 'floor', completionProb: null }];
  const snapshot = structuredClone(prior);
  recordTurnEnd(prior, closure({ completionProb: 0.3 }));
  recordTurnEnd(prior, closure({ evaluation: 2, t: 5000 }));
  assert.deepEqual(prior, snapshot);
});
