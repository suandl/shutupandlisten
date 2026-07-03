// Unit tests for the PR-comment summary builder used by the promptfoo CI
// workflow (.github/scripts/summarize-eval.js). Keyless, no model, no promptfoo
// runtime — buildSummary/failMarkdown are pure functions over a parsed
// promptfoo `--output results.json` object, so we exercise them against
// hand-built fixtures instead of a real (paid) eval run.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSummary,
  failMarkdown,
  judgeName,
  MARKER,
} = require('../../.github/scripts/summarize-eval.js');

// Build one promptfoo result cell (prompt × provider × scenario) with the three
// rubric judges scored on the 1–5 scale.
function cell(prompt, provider, scenario, success, judges) {
  return {
    provider: { label: provider },
    prompt: { label: prompt },
    testCase: { description: scenario },
    success,
    gradingResult: {
      pass: success,
      componentResults: Object.entries(judges).map(([name, score]) => ({
        pass: score >= 3,
        score,
        assertion: { type: 'llm-rubric', value: `file://judges/${name}.txt` },
      })),
    },
  };
}

// A 2×2 fixture: 3 passing cells, 1 failing, judges on the 1–5 scale.
function sample() {
  return {
    results: {
      stats: { successes: 3, failures: 1 },
      results: [
        cell('claude', 'openai-gpt-4o', 'feature-idea', true, { 'probing-depth': 4, restraint: 5, variety: 4 }),
        cell('claude', 'anthropic-claude-haiku-4-5', 'feature-idea', false, { 'probing-depth': 3, restraint: 2, variety: 4 }),
        cell('chatgpt', 'openai-gpt-4o', 'story-premise', true, { 'probing-depth': 5, restraint: 5, variety: 5 }),
        cell('chatgpt', 'anthropic-claude-haiku-4-5', 'story-premise', true, { 'probing-depth': 4, restraint: 4, variety: 3 }),
      ],
    },
  };
}

test('summary carries the sticky marker and heading', () => {
  const md = buildSummary(sample(), {});
  assert.ok(md.startsWith(MARKER), 'must lead with the sticky-comment marker');
  assert.match(md, /## 🧪 promptfoo eval/);
});

test('headline uses promptfoo stats and flags a non-clean run', () => {
  const md = buildSummary(sample(), { exitCode: '100', headSha: '1b24cd42abc' });
  assert.match(md, /3\/4 cells passed/);
  assert.match(md, /⚠️/);
  assert.match(md, /commit `1b24cd4`/);
  assert.match(md, /some cells below judge threshold/);
});

test('all-pass run reads as clean', () => {
  const data = sample();
  data.results.stats = { successes: 4, failures: 0 };
  const md = buildSummary(data, {});
  assert.match(md, /✅ \*\*4\/4 cells passed\*\*/);
});

test('by-judge table reports mean score and pass rate per judge', () => {
  const md = buildSummary(sample(), {});
  // probing-depth: (4+3+5+4)/4 = 4.00, all >=3 → 4/4
  assert.match(md, /\| probing-depth \| 4\.00 \| 4\/4 \|/);
  // restraint: (5+2+5+4)/4 = 4.00, the score-2 cell fails → 3/4
  assert.match(md, /\| restraint \| 4\.00 \| 3\/4 \|/);
  // variety: (4+4+5+3)/4 = 4.00, all >=3 → 4/4
  assert.match(md, /\| variety \| 4\.00 \| 4\/4 \|/);
});

test('judges render in preferred order', () => {
  const md = buildSummary(sample(), {});
  const iP = md.indexOf('probing-depth');
  const iR = md.indexOf('restraint');
  const iV = md.indexOf('variety');
  assert.ok(iP < iR && iR < iV, 'probing-depth < restraint < variety');
});

test('per prompt × provider table and full breakdown are present', () => {
  const md = buildSummary(sample(), {});
  assert.match(md, /\*\*By prompt × provider\*\*/);
  assert.match(md, /claude × openai-gpt-4o/);
  assert.match(md, /<details>/);
  assert.match(md, /feature-idea/);
  assert.match(md, /story-premise/);
});

test('1–5 scale is detected from the scores', () => {
  const md = buildSummary(sample(), {});
  assert.match(md, /\(scale 1–5\)/);
});

test('0–1 scale is detected when all scores are fractional', () => {
  const data = {
    results: {
      stats: { successes: 1, failures: 0 },
      results: [cell('claude', 'openai-gpt-4o', 'feature-idea', true, { 'probing-depth': 0.8, restraint: 0.9, variety: 0.7 })],
    },
  };
  const md = buildSummary(data, {});
  assert.match(md, /\(scale 0–1\)/);
});

test('empty results degrade to a graceful, still-sticky note', () => {
  const md = buildSummary({ results: { results: [] } }, {});
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /No eval cells were parsed/);
});

test('missing gradingResult / fields never throw', () => {
  const data = { results: { results: [{ provider: {}, prompt: {}, success: true }] } };
  assert.doesNotThrow(() => buildSummary(data, {}));
});

test('the run-url footer links the artifact when provided', () => {
  const md = buildSummary(sample(), { runUrl: 'https://example.test/runs/1', artifactName: 'promptfoo-report' });
  assert.match(md, /\[Full report artifact \(`promptfoo-report`\)\]\(https:\/\/example\.test\/runs\/1\)/);
});

test('failMarkdown stays sticky and carries the note', () => {
  const md = failMarkdown('_boom_', { runUrl: 'https://example.test/runs/2' });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /_boom_/);
  assert.match(md, /https:\/\/example\.test\/runs\/2/);
});

test('judgeName strips file:// prefix and extension', () => {
  assert.equal(judgeName({ value: 'file://judges/variety.txt' }), 'variety');
  assert.equal(judgeName({ value: 'judges/probing-depth.txt' }), 'probing-depth');
  assert.equal(judgeName({ metric: 'restraint' }), 'restraint');
  assert.equal(judgeName({ type: 'llm-rubric' }), 'llm-rubric');
});
