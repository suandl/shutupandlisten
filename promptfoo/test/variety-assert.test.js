// Variety must not flatter emptiness — keyless, no model, no promptfoo runtime.
//
// su-lou.12 defect 2: judges/variety.txt carried a "<=1 questions -> 5" rule, so
// the most degenerate cells in the matrix — a listener that asked nothing at all
// — scored PERFECT on the column that measures how its questions differ. The
// column read 3.63 / 14-of-16 on a run whose outputs included generic
// zero-question affirmations.
//
// The applicability call now happens in asserts/variety.js, before the rubric,
// where it is a deterministic count. These tests pin both halves: an
// unassessable transcript is excluded (and costs no grader call), an assessable
// one is handed to the real rubric unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const variety = require('../asserts/variety.js');
const {
  countListenerQuestions,
  listenerTurns,
  MIN_ASSESSABLE_QUESTIONS,
  NOT_APPLICABLE_PREFIX,
  RUBRIC_PATH,
} = variety;
const { ZERO_QUESTION, MULTI_QUESTION, RESTRAINED, LANDING_MARKER } = require('./fixtures/transcripts.js');

// Stand in for promptfoo's llm-rubric matcher and record what it was handed.
function stubMatcher(result = { pass: true, score: 4, reason: 'stub' }) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

test.afterEach(() => { variety._rubricMatcher = null; });

test('a zero-question transcript is N/A, not a 5', async () => {
  const matcher = stubMatcher();
  variety._rubricMatcher = matcher;

  const result = await variety(ZERO_QUESTION, {});
  assert.ok(result.reason.startsWith(NOT_APPLICABLE_PREFIX), `got: ${result.reason}`);
  assert.equal(result.score, 0, 'scored outside the 1–5 band so it cannot read as a verdict');
  assert.equal(result.pass, true, 'a quiet listener is not a variety failure — N/A is non-blocking');
  assert.equal(matcher.calls.length, 0, 'an unassessable cell must not cost a grader call');
});

test('one question is still under-sampled', async () => {
  variety._rubricMatcher = stubMatcher();
  const oneQuestion = [
    'THINKER: so the idea is a grocery app, but backwards.',
    LANDING_MARKER,
    'LISTENER: What happens when two things expire on the same day?',
  ].join('\n\n');

  assert.equal(countListenerQuestions(oneQuestion), 1);
  const result = await variety(oneQuestion, {});
  assert.ok(result.reason.startsWith(NOT_APPLICABLE_PREFIX));
  assert.match(result.reason, /has 1\b/, 'the reason names the count that made it unassessable');
});

test('the ideal restrained transcript is N/A rather than scored', async () => {
  // The shape restraint.txt scores 5 asks exactly one question — which is
  // precisely the sample size variety cannot speak to. Excluding it is the
  // point: the two columns must not launder each other's signal.
  variety._rubricMatcher = stubMatcher();
  const result = await variety(RESTRAINED, {});
  assert.ok(result.reason.startsWith(NOT_APPLICABLE_PREFIX));
});

test('two or more questions delegate to the real rubric', async () => {
  const matcher = stubMatcher({ pass: true, score: 5, reason: 'distinct stems' });
  variety._rubricMatcher = matcher;

  assert.ok(countListenerQuestions(MULTI_QUESTION) >= MIN_ASSESSABLE_QUESTIONS);
  const result = await variety(MULTI_QUESTION, { test: { options: { provider: 'openai:gpt-4o' }, vars: { a: 1 } } });

  assert.equal(result.score, 5);
  assert.equal(matcher.calls.length, 1);
  const [rubric, output, grading, vars] = matcher.calls[0];
  assert.equal(rubric, fs.readFileSync(RUBRIC_PATH, 'utf8'), 'the rubric file is passed verbatim');
  assert.equal(output, MULTI_QUESTION);
  assert.deepEqual(grading, { provider: 'openai:gpt-4o' }, 'grading config is forwarded, so the grader is unchanged');
  assert.deepEqual(vars, { a: 1 });
});

test('only LISTENER turns count, across multi-line turns and the marker', () => {
  const transcript = [
    'THINKER: is this the kind of thing you mean? I think it is?',
    'LISTENER: What decides the order?\nAnd what happens when you ignore it??',
    `THINKER: well, ${'the queue just re-sorts. right?'}`,
    LANDING_MARKER,
    'LISTENER: Why would staples stay invisible?',
  ].join('\n\n');

  // Thinker question marks (3 of them) are ignored; "??" collapses to one.
  assert.equal(countListenerQuestions(transcript), 3);
  const turns = listenerTurns(transcript);
  assert.equal(turns.length, 2);
  assert.ok(turns[1].startsWith('Why would staples'), 'the marker is not attributed to a speaker');
});

test('an empty or non-string output is unassessable rather than a crash', async () => {
  variety._rubricMatcher = stubMatcher();
  for (const output of ['', null, undefined, 42]) {
    const result = await variety(output, {});
    assert.ok(result.reason.startsWith(NOT_APPLICABLE_PREFIX), `output ${JSON.stringify(output)}`);
  }
});

// Sync guard: the rubric must not re-grow its own under-sampling rule, or the
// gate in front of it becomes decorative.
test('judges/variety.txt no longer scores a transcript for asking few questions', () => {
  const rubric = fs.readFileSync(RUBRIC_PATH, 'utf8');
  assert.ok(
    !/zero or one questions.*score 5/is.test(rubric),
    'the "<=1 questions -> 5" rule is the defect — it must not come back',
  );
  assert.match(rubric, /asserts\/variety\.js/, 'the rubric must point at the gate that decides applicability');
});
