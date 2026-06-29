// Scenario 6 assertions: the EOU must beat the bare floor to earn its place.
//   node --test 'src/**/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { summarize, measureVector, formatTable, type LabeledVector } from './measurement.ts';

const here = dirname(fileURLToPath(import.meta.url));
const labeledDir = join(here, '../../spec/turn-vectors/labeled');

const vectors: LabeledVector[] = readdirSync(labeledDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(labeledDir, f), 'utf8')) as LabeledVector);

test('scenario 6: smart-turn beats the bare floor on the labeled corpus', () => {
  assert.ok(vectors.length >= 3, 'a labeled corpus is present');
  const summary = summarize(vectors);
  // Surface the metrics table in the test output (the measured deliverable).
  console.log('\n' + formatTable(summary) + '\n');

  assert.ok(
    summary.combined.falseCutoffs < summary.baseline.falseCutoffs,
    'combined produces strictly fewer false cutoffs (the cardinal sin)',
  );
  assert.ok(
    summary.combined.weightedError <= summary.baseline.weightedError,
    'combined is no worse on total weighted error',
  );
  assert.equal(summary.eouBeatsFloor, true, 'the gate verdict: EOU earns its place');
});

test('per-vector: the veto never adds a false cutoff over the baseline', () => {
  for (const v of vectors) {
    const r = measureVector(v);
    assert.ok(
      r.combined.falseCutoffs <= r.baseline.falseCutoffs,
      `${v.name}: combined cutoffs (${r.combined.falseCutoffs}) <= baseline (${r.baseline.falseCutoffs})`,
    );
  }
});

test('control (tol-03 clean finish): both arms detect with zero error', () => {
  const v = vectors.find((x) => x.name === 'tol-03-clean-finish');
  assert.ok(v, 'tol-03 present');
  const r = measureVector(v as LabeledVector);
  assert.equal(r.combined.falseCutoffs, 0);
  assert.equal(r.combined.falseContinuations, 0);
  assert.equal(r.baseline.falseCutoffs, 0);
  assert.equal(r.baseline.falseContinuations, 0);
});

test('cost case (tol-04 misread finish): combined detects later but still on-time', () => {
  const v = vectors.find((x) => x.name === 'tol-04-misread-finish');
  assert.ok(v, 'tol-04 present');
  const r = measureVector(v as LabeledVector);
  assert.equal(r.combined.truePositives, 1, 'still detected');
  assert.equal(r.combined.falseContinuations, 0, 'not a missed end — just later');
  assert.ok(
    (r.combined.meanLatencyMs ?? 0) > (r.baseline.meanLatencyMs ?? 0),
    'the veto trades latency for patience on a misread',
  );
});
