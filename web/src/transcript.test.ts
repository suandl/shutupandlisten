// Tests for the pure transcript-alignment logic (transcript.ts).
//
// Runs with zero dependencies via Node's built-in runner + type stripping:
//   node --test 'src/**/*.test.ts'
// The grouping rule — "a segment belongs to the latest turn-start at or before
// its speech-end" — is what aligns words to turn boundaries, so it gets the same
// headless-test discipline as the detector itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupTranscript } from './transcript.ts';
import type { TranscriptSegment, TurnStartMark, TurnEndMark } from './transcript.ts';

function seg(id: number, startT: number, endT: number, over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return { id, startT, endT, text: `seg${id}`, mode: 'stub', pending: false, ...over };
}

test('several segments under one turn: a sub-floor thinking-pause keeps the same turn', () => {
  const starts: TurnStartMark[] = [{ turn: 1, t: 0 }];
  const ends: TurnEndMark[] = [{ turn: 1, t: 5000, reason: 'extended' }];
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
  assert.deepEqual(groups[0].end, { turn: 1, t: 5000, reason: 'extended' });
});

test('segments assign to the right turn by speech-end time', () => {
  const groups = groupTranscript({
    segments: [seg(0, 0, 1000), seg(1, 3500, 4500)],
    turnStarts: [
      { turn: 1, t: 0 },
      { turn: 2, t: 3500 },
    ],
    turnEnds: [
      { turn: 1, t: 3000, reason: 'floor' },
      { turn: 2, t: 6500, reason: 'floor' },
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
    turnEnds: [{ turn: 1, t: 3000, reason: 'floor' }],
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
    turnEnds: [{ turn: 1, t: 4500, reason: 'floor' }],
  });
  assert.deepEqual(groups[0].segments.map((s) => s.id), [0, 1, 2]);
});
