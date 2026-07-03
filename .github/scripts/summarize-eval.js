#!/usr/bin/env node
// Turn a promptfoo `--output results.json` file into a compact, readable
// Markdown summary for a PR comment: scores broken out per provider, per
// scenario, and per judge (probing-depth / restraint / variety).
//
// Usage:  node summarize-eval.js <results.json>   (Markdown is written to stdout)
//
// Context is read from the environment (all optional):
//   EVAL_EXIT_CODE  promptfoo's exit code (0 = all passed, 100 = some cells failed)
//   HEAD_SHA        commit the eval ran against
//   RUN_URL         link to the workflow run (where the full-report artifact lives)
//   ARTIFACT_NAME   name of the uploaded artifact (default: promptfoo-report)
//
// The parser is deliberately defensive: promptfoo's JSON shape shifts across
// versions, so every field access is guarded and an unparseable file degrades
// to a "see the artifact" note rather than crashing the workflow.
//
// `buildSummary(data, ctx)` and `failMarkdown(note, ctx)` are exported as pure
// functions so they can be unit-tested without model calls or a real eval run
// (see promptfoo/test/summarize-eval.test.js). Run as a script, this reads the
// results file named by argv[2] and writes the Markdown to stdout.

const fs = require('fs');

const MARKER = '<!-- promptfoo-eval-summary -->';

// Preferred judge column order; anything else is appended alphabetically.
const JUDGE_ORDER = ['probing-depth', 'restraint', 'variety'];

function num(x) { return typeof x === 'number' && Number.isFinite(x) ? x : null; }

function judgeName(assertion) {
  const raw = assertion?.value ?? assertion?.metric ?? assertion?.type ?? 'judge';
  if (typeof raw !== 'string') return 'judge';
  const base = raw.replace(/^file:\/\//, '').split(/[\\/]/).pop() || raw;
  return base.replace(/\.(txt|md|ya?ml|js|json)$/i, '');
}

// A short "couldn't parse — go read the artifact" comment. Kept identical in
// shape to a real summary (same MARKER + heading) so the sticky-comment upsert
// updates the same comment instead of posting a second one.
function failMarkdown(note, ctx = {}) {
  const lines = [MARKER, '## 🧪 promptfoo eval', '', note];
  if (ctx.runUrl) {
    lines.push('', `[Full report artifact (\`${ctx.artifactName || 'promptfoo-report'}\`)](${ctx.runUrl})`);
  }
  return lines.join('\n') + '\n';
}

function buildSummary(data, ctx = {}) {
  const artifactName = ctx.artifactName || 'promptfoo-report';

  // Locate the per-cell results array across schema variants.
  const rows = Array.isArray(data?.results?.results)
    ? data.results.results
    : (Array.isArray(data?.results) ? data.results : []);

  if (!rows.length) {
    return failMarkdown('_No eval cells were parsed from the results file. See the full report artifact._', ctx);
  }

  const judgeAgg = {};      // judge -> { sum, count, pass, total }
  const cellAgg = {};       // "prompt × provider" -> { pass, total, sum, scored }
  const scenarioAgg = {};   // scenario -> { pass, total }
  const detail = [];        // per-row rows for the collapsible table
  const judgesSeen = new Set();
  let cellPass = 0, cellTotal = 0, maxScore = 0;

  for (const row of rows) {
    const provider = row?.provider?.label || row?.provider?.id || (typeof row?.provider === 'string' ? row.provider : 'provider');
    const prompt = row?.prompt?.label || row?.promptLabel || row?.prompt?.id || 'prompt';
    const scenario = row?.testCase?.description || row?.description
      || row?.testCase?.metadata?.topic || row?.vars?.scenario || 'scenario';
    const grading = row?.gradingResult || {};
    const comps = Array.isArray(grading.componentResults) ? grading.componentResults : [];
    const passed = (row?.success ?? grading.pass) ? 1 : 0;

    cellTotal++; cellPass += passed;

    const cellKey = `${prompt} × ${provider}`;
    (cellAgg[cellKey] ||= { pass: 0, total: 0, sum: 0, scored: 0 });
    cellAgg[cellKey].total++; cellAgg[cellKey].pass += passed;

    (scenarioAgg[scenario] ||= { pass: 0, total: 0 });
    scenarioAgg[scenario].total++; scenarioAgg[scenario].pass += passed;

    const perJudge = {};
    for (const c of comps) {
      const jn = judgeName(c?.assertion);
      judgesSeen.add(jn);
      const score = num(c?.score);
      const jpass = c?.pass ? 1 : 0;
      (judgeAgg[jn] ||= { sum: 0, count: 0, pass: 0, total: 0 });
      judgeAgg[jn].pass += jpass; judgeAgg[jn].total++;
      if (score !== null) {
        judgeAgg[jn].sum += score; judgeAgg[jn].count++;
        cellAgg[cellKey].sum += score; cellAgg[cellKey].scored++;
        if (score > maxScore) maxScore = score;
        perJudge[jn] = score;
      }
    }
    detail.push({ prompt, provider, scenario, passed, perJudge });
  }

  // Judges output an integer 1–5 rubric score; other assertions are 0–1. Detect
  // which scale we're on so the numbers we print aren't silently misread.
  const scaleMax = maxScore > 1.0001 ? 5 : 1;
  const scaleNote = scaleMax === 5 ? ' (scale 1–5)' : ' (scale 0–1)';
  const fmt = (v) => (v === null || v === undefined) ? '–' : v.toFixed(2);
  const mean = (sum, count) => count > 0 ? sum / count : null;

  // Prefer promptfoo's own stats block for the headline pass/fail counts.
  const successes = num(data?.results?.stats?.successes);
  const failures = num(data?.results?.stats?.failures);
  const totalCells = (successes !== null && failures !== null) ? successes + failures : cellTotal;
  const passCells = (successes !== null) ? successes : cellPass;

  const orderedJudges = [
    ...JUDGE_ORDER.filter((j) => judgesSeen.has(j)),
    ...[...judgesSeen].filter((j) => !JUDGE_ORDER.includes(j)).sort(),
  ];

  const lines = [];
  const out = (s = '') => lines.push(s);

  out(MARKER);
  out('## 🧪 promptfoo eval');
  out('');

  const allPass = passCells === totalCells;
  const statusIcon = allPass ? '✅' : '⚠️';
  const bits = [`${statusIcon} **${passCells}/${totalCells} cells passed**${scaleNote}`];
  if (ctx.headSha) bits.push(`commit \`${String(ctx.headSha).slice(0, 7)}\``);
  if (ctx.exitCode === '100') bits.push('_some cells below judge threshold_');
  out(bits.join(' · '));
  out('');

  // By judge
  out('**By judge**');
  out('');
  out('| Judge | Mean | Pass rate |');
  out('| --- | --- | --- |');
  for (const j of orderedJudges) {
    const a = judgeAgg[j];
    out(`| ${j} | ${fmt(mean(a.sum, a.count))} | ${a.pass}/${a.total} |`);
  }
  out('');

  // By prompt × provider
  out('**By prompt × provider**');
  out('');
  out('| Prompt × provider | Mean | Cells passed |');
  out('| --- | --- | --- |');
  for (const key of Object.keys(cellAgg).sort()) {
    const a = cellAgg[key];
    out(`| ${key} | ${fmt(mean(a.sum, a.scored))} | ${a.pass}/${a.total} |`);
  }
  out('');

  // Full breakdown (collapsible): prompt × provider × scenario × judge
  out('<details>');
  out(`<summary>Per prompt × provider × scenario (${detail.length} cells)</summary>`);
  out('');
  out(`| Prompt | Provider | Scenario | ${orderedJudges.join(' | ')} | Pass |`);
  out(`| --- | --- | --- |${orderedJudges.map(() => ' --- |').join('')} --- |`);
  const sorted = detail.slice().sort((a, b) =>
    (a.prompt + a.provider + a.scenario).localeCompare(b.prompt + b.provider + b.scenario));
  for (const d of sorted) {
    const cells = orderedJudges.map((j) => fmt(d.perJudge[j] ?? null));
    out(`| ${d.prompt} | ${d.provider} | ${d.scenario} | ${cells.join(' | ')} | ${d.passed ? '✅' : '❌'} |`);
  }
  out('');
  out('</details>');
  out('');

  const footer = [];
  if (ctx.runUrl) footer.push(`[Full report artifact (\`${artifactName}\`)](${ctx.runUrl})`);
  footer.push('_Generated by `.github/workflows/promptfoo.yml`._');
  out(footer.join(' · '));

  return lines.join('\n') + '\n';
}

module.exports = { buildSummary, failMarkdown, judgeName, MARKER, JUDGE_ORDER };

if (require.main === module) {
  const ctx = {
    exitCode: process.env.EVAL_EXIT_CODE || '',
    headSha: process.env.HEAD_SHA || '',
    runUrl: process.env.RUN_URL || '',
    artifactName: process.env.ARTIFACT_NAME || 'promptfoo-report',
  };
  const resultsPath = process.argv[2];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  } catch (e) {
    process.stdout.write(
      failMarkdown(`_Could not read promptfoo results (\`${e.message}\`). See the full report artifact._`, ctx));
    process.exit(0);
  }
  process.stdout.write(buildSummary(data, ctx));
}
