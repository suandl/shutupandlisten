// Variety assertion — an applicability gate in front of judges/variety.txt.
//
// WHY THIS IS A JS ASSERTION AND NOT A BARE llm-rubric. The rubric used to
// carry its own under-sampling rule — "zero or one questions → 5" — which
// handed a PERFECT variety score to the most degenerate cells in the matrix: a
// listener that asks nothing at all scored top marks on the column that exists
// to measure how its questions differ from each other. The column read a
// healthy 3.63 / 14-of-16 on a run whose outputs included generic zero-question
// affirmations, i.e. it flattered exactly the output the bar rejects
// (su-lou.12).
//
// Variety genuinely IS undefined below two questions, so the fix is to exclude
// the cell, not to score it. promptfoo's llm-rubric has no N/A verdict, so the
// applicability test moves here, in front of the rubric, where it is a
// deterministic count instead of something a grader can be talked out of:
//
//   * fewer than MIN_ASSESSABLE_QUESTIONS listener questions → NOT APPLICABLE.
//     Non-blocking (pass: true — a quiet listener is not a variety failure, and
//     probing-depth / no-summarize are the judges that catch a degenerate one),
//     scored 0 so it reads as visibly outside the 1–5 band even in the raw
//     report, and reason-prefixed so .github/scripts/summarize-eval.js drops it
//     from the column's mean and pass rate rather than averaging it in.
//   * otherwise → delegate to judges/variety.txt through promptfoo's own
//     llm-rubric matcher, with the same arguments the built-in `llm-rubric`
//     assertion passes, so the assessable path scores identically to before.
//
// Counting questions here rather than in the rubric also means a degenerate
// cell costs no grader call at all.

const fs = require('fs');
const path = require('path');

// Imported, never retyped: a drifted copy of the marker string here would skip
// a line the harness does not actually emit (same principle as
// test/fixtures/transcripts.js).
const { LANDING_MARKER } = require('../providers/multi-turn.js');

const RUBRIC_PATH = path.resolve(__dirname, '..', 'judges', 'variety.txt');

// Two questions is the smallest sample in which "do they differ?" has an
// answer; at one there is nothing to compare it against.
const MIN_ASSESSABLE_QUESTIONS = 2;

// Machine-readable N/A signal. Deterministic because this module writes it —
// the summarizer keys on it to exclude the cell (see summarize-eval.js).
const NOT_APPLICABLE_PREFIX = 'NOT_APPLICABLE:';

// Split a "THINKER: …\n\nLISTENER: …" transcript into the listener's turns.
// A turn can span multiple lines, and the transcript also carries the landing
// marker emitted by providers/multi-turn.js, so attribute each line to the
// speaker that last opened a turn instead of splitting on blank lines.
function listenerTurns(transcript) {
  const turns = [];
  let current = null;
  for (const line of String(transcript ?? '').split('\n')) {
    const speaker = /^(THINKER|LISTENER):\s*(.*)$/.exec(line);
    if (speaker) {
      if (current !== null) turns.push(current);
      current = speaker[1] === 'LISTENER' ? speaker[2] : null;
      continue;
    }
    // Skip the landing marker so it is never appended into a listener turn.
    // It usually follows a THINKER turn (current === null, already skipped), but
    // an empty landing thinker turn can leave it directly after a LISTENER block.
    if (line.trim() === LANDING_MARKER) continue;
    if (current !== null) current += `\n${line}`;
  }
  if (current !== null) turns.push(current);
  return turns.map((t) => t.trim()).filter(Boolean);
}

// Deterministic proxy for "how many questions did the listener ask": count
// question marks across listener turns, collapsing runs so "really??" is one
// question. Only the APPLICABILITY call is made here — how much the questions
// actually differ stays with the rubric, which is a semantic judgement.
function countListenerQuestions(transcript) {
  return listenerTurns(transcript).reduce(
    (n, turn) => n + (turn.replace(/\?+/g, '?').match(/\?/g) || []).length,
    0,
  );
}

// promptfoo exposes its llm-rubric matcher on the package's public surface;
// resolved lazily (and via dynamic import, matching providers/multi-turn.js)
// so the keyless unit tests never load the promptfoo runtime. Cached back into
// the same _rubricMatcher slot the tests stub, so a real run imports promptfoo
// once instead of on every cell.
async function resolveRubricMatcher() {
  if (assertVariety._rubricMatcher) return assertVariety._rubricMatcher;
  const promptfoo = await import('promptfoo');
  const assertions = promptfoo.assertions || promptfoo.default?.assertions;
  const matcher = assertions && assertions.matchesLlmRubric;
  if (typeof matcher !== 'function') {
    // Loud on purpose. Falling back to a pass here would restore the exact
    // failure mode this file exists to remove: a variety column that reports a
    // number nobody can trust.
    throw new Error(
      'variety assertion: could not resolve promptfoo.assertions.matchesLlmRubric',
    );
  }
  assertVariety._rubricMatcher = matcher;
  return matcher;
}

async function assertVariety(output, context) {
  const transcript = typeof output === 'string' ? output : String(output ?? '');
  const questions = countListenerQuestions(transcript);

  if (questions < MIN_ASSESSABLE_QUESTIONS) {
    return {
      pass: true,
      score: 0,
      reason:
        `${NOT_APPLICABLE_PREFIX} variety needs at least ${MIN_ASSESSABLE_QUESTIONS} ` +
        `listener questions to compare; this transcript has ${questions}. ` +
        'Cell excluded from the variety column.',
    };
  }

  const matcher = await resolveRubricMatcher();
  const rubric = fs.readFileSync(RUBRIC_PATH, 'utf8');
  // Same argument order the built-in llm-rubric handler uses:
  // (rubric, output, grading config, vars).
  return matcher(rubric, transcript, (context && context.test && context.test.options) || {},
    context && context.test && context.test.vars);
}

module.exports = assertVariety;
module.exports.listenerTurns = listenerTurns;
module.exports.countListenerQuestions = countListenerQuestions;
module.exports.MIN_ASSESSABLE_QUESTIONS = MIN_ASSESSABLE_QUESTIONS;
module.exports.NOT_APPLICABLE_PREFIX = NOT_APPLICABLE_PREFIX;
module.exports.RUBRIC_PATH = RUBRIC_PATH;
// Test seam: stands in for promptfoo's llm-rubric matcher so the delegation
// path is exercisable without the runtime or a paid grader call. Null in a
// real run (see test/variety-assert.test.js).
module.exports._rubricMatcher = null;
