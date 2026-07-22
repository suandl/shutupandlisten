// Judge acceptance — OPT-IN, calls a real grader (costs money).
//
//   npm run test:judges          # 1Password key injection, like the evals
//   RUN_JUDGE_ACCEPTANCE=1 OPENAI_API_KEY=… node --test test/judge-acceptance.test.js
//
// Skipped by default so `npm test` stays keyless. Everything else in test/ pins
// STRUCTURE — that the harness emits a landing boundary, that the variety gate
// counts questions. Only a real grader can answer the question su-lou.12
// actually names: "a deliberately restrained transcript can score 5 and a
// deliberately intrusive one cannot."
//
// That is the acceptance bar because the restraint column previously could not
// clear it for ANY input. The ideal Haiku transcript — "Mm." plus four short
// questions, no banned phrase anywhere — scored 2, the same as the worst cells,
// because the simulator never ended its dictation and every listener turn was
// therefore mid-dictation by construction. Numbers alone could not distinguish
// "over-engaged" from "unmeasurable"; two fixtures that differ ONLY in timing
// can.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RESTRAINED, INTRUSIVE } = require('./fixtures/transcripts.js');

const RESTRAINT_JUDGE = path.resolve(__dirname, '..', 'judges', 'restraint.txt');
const OPT_IN = process.env.RUN_JUDGE_ACCEPTANCE === '1';
const skip = OPT_IN ? false : 'set RUN_JUDGE_ACCEPTANCE=1 (and API keys) to run — makes paid grader calls';

// Score one transcript through the same matcher promptfoo's llm-rubric
// assertion uses, so this measures the judge as it actually runs.
async function scoreRestraint(transcript) {
  const promptfoo = await import('promptfoo');
  const assertions = promptfoo.assertions || promptfoo.default?.assertions;
  const rubric = fs.readFileSync(RESTRAINT_JUDGE, 'utf8');
  const result = await assertions.matchesLlmRubric(rubric, transcript, {});
  return result;
}

test('a deliberately restrained transcript can score 5 on restraint', { skip }, async () => {
  const result = await scoreRestraint(RESTRAINED);
  console.log(`restrained → ${result.score}: ${result.reason}`);
  assert.equal(
    result.score,
    5,
    'silence through the dictation plus one post-landing thread-pull is the rubric\'s top band; ' +
      'anything less means the column still cannot reward restraint',
  );
});

test('a deliberately intrusive transcript cannot', { skip }, async () => {
  const result = await scoreRestraint(INTRUSIVE);
  console.log(`intrusive → ${result.score}: ${result.reason}`);
  // Same idea, same words, no banned phrase — the ONLY difference from the
  // restrained fixture is that the listener speaks through the dictation.
  assert.ok(result.score < 5, `interjecting through the dictation must not score 5 (got ${result.score})`);
});
