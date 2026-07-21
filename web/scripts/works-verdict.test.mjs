// Tests for the works-check classification rules (works-verdict.mjs).
//
// The guarantees under test:
//   1. a fully-live report (real backends, non-empty smoke output) passes → exit 0
//      — the green path is covered here BECAUSE the live gate is expected red on
//      main until su-lou.8's TTS fix lands with this guard
//   2. a stub/degraded backend or empty smoke output is a REGRESSION naming the
//      stage → exit 100 (origin R2/R3/R4, KTD4)
//   3. the spike-proven false-green (TTS loads wasm, synthesis degrades per call)
//      is caught by the separate smoke-run assertion
//   4. 'sim' words and a surprise 'webgpu' voice never green the WASM gate
//   5. a malformed/partial report fails the missing stage, never silently passes
//   6. the smart-turn EOU stage (su-lou.10.1) is held to the same rules: the
//      `heuristic` fallback — which is what EVERY session ran before a model was
//      provisioned — must never green the gate

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EXIT_PASS, EXIT_REGRESSION, evaluateReport, exitCodeFor, summarizeVerdict } from './works-verdict.mjs';

/** A fully-healthy report; tests override fields per scenario. */
function healthyReport(overrides = {}) {
  return {
    version: 1,
    stt: {
      loadMode: 'moonshine',
      loadMs: 4200,
      smoke: { mode: 'moonshine', text: 'the works check confirms', ms: 180 },
      error: null,
      ...(overrides.stt ?? {}),
    },
    tts: {
      loadMode: 'wasm',
      loadMs: 6100,
      diagnostics: [],
      smoke: { mode: 'wasm', samples: 47000, sampleRate: 16000, rms: 0.114, ms: 5300 },
      error: null,
      ...(overrides.tts ?? {}),
    },
    smartTurn: {
      loadMode: 'model',
      loadMs: 900,
      diagnostics: [],
      smoke: { mode: 'model', completionProb: 0.7434, ms: 60, warmMs: 55 },
      error: null,
      ...(overrides.smartTurn ?? {}),
    },
  };
}

const failedStages = (verdict) => [...new Set(verdict.failures.map((f) => f.stage))];

test('fully-live report passes with exit 0', () => {
  const verdict = evaluateReport(healthyReport());
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.failures, []);
  assert.equal(exitCodeFor(verdict), EXIT_PASS);
  assert.match(summarizeVerdict(verdict), /^WORKS-CHECK PASS/);
  assert.match(summarizeVerdict(verdict), /smart-turn/);
});

test('whisper fallback is a real backend and passes R2', () => {
  const verdict = evaluateReport(
    healthyReport({ stt: { loadMode: 'whisper', smoke: { mode: 'whisper', text: 'hello there', ms: 200 } } }),
  );
  assert.equal(verdict.pass, true);
});

test("today's main — TTS stubbed (su-lou.8) — is a regression naming tts only", () => {
  const verdict = evaluateReport(
    healthyReport({
      tts: {
        loadMode: 'stub',
        diagnostics: ['[tts] voice unavailable: no model loaded — using the placeholder tone'],
        smoke: { mode: 'stub', samples: 12000, sampleRate: 16000, rms: 0.08, ms: 3 },
      },
    }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['tts']);
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  // The verdict line names the stage AND carries the adapter's own diagnosis.
  const summary = summarizeVerdict(verdict);
  assert.match(summary, /^WORKS-CHECK REGRESSION: tts /);
  assert.match(summary, /no model loaded/);
});

test('spike false-green — TTS loads wasm but synthesis degrades — fails on the smoke-run', () => {
  const verdict = evaluateReport(
    healthyReport({ tts: { smoke: { mode: 'stub', samples: 9000, sampleRate: 16000, rms: 0.08, ms: 40 } } }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['tts']);
  assert.match(verdict.failures[0].reason, /smoke-run degraded/);
});

test('stub STT load is a regression naming stt', () => {
  const verdict = evaluateReport(
    healthyReport({
      stt: { loadMode: 'stub', smoke: { mode: 'stub', text: '⟨speech 1.5s — STT model not loaded⟩', ms: 1 } },
    }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['stt']);
});

test("'sim' words never green the gate", () => {
  const verdict = evaluateReport(
    healthyReport({ stt: { loadMode: 'sim', smoke: { mode: 'sim', text: 'scripted demo words', ms: 1 } } }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['stt']);
});

test('empty transcript on the speech fixture fails R4 even with a real backend', () => {
  const verdict = evaluateReport(
    healthyReport({ stt: { smoke: { mode: 'moonshine', text: '   ', ms: 150 } } }),
  );
  assert.equal(verdict.pass, false);
  assert.match(verdict.failures[0].reason, /transcript is empty/);
});

test("a surprise 'webgpu' voice fails the WASM gate loudly (R3 scope pin)", () => {
  const verdict = evaluateReport(
    healthyReport({
      tts: { loadMode: 'webgpu', smoke: { mode: 'webgpu', samples: 47000, sampleRate: 16000, rms: 0.1, ms: 900 } },
    }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['tts']);
});

test('empty or silent synthesis audio fails R4', () => {
  const empty = evaluateReport(
    healthyReport({ tts: { smoke: { mode: 'wasm', samples: 0, sampleRate: 16000, rms: 0, ms: 20 } } }),
  );
  assert.match(empty.failures[0].reason, /no audio/);
  const silent = evaluateReport(
    healthyReport({ tts: { smoke: { mode: 'wasm', samples: 47000, sampleRate: 16000, rms: 0, ms: 20 } } }),
  );
  assert.match(silent.failures[0].reason, /all-zero silence/);
});

test('a probe-level stage error is a named failure, never a pass', () => {
  const verdict = evaluateReport(healthyReport({ stt: { error: 'createTranscriber threw: boom' } }));
  assert.equal(verdict.pass, false);
  assert.match(verdict.failures[0].reason, /probe error: createTranscriber threw/);
});

test('a malformed report fails every stage rather than silently passing', () => {
  for (const bad of [null, undefined, {}, { version: 1 }]) {
    const verdict = evaluateReport(bad);
    assert.equal(verdict.pass, false);
    assert.deepEqual(failedStages(verdict).sort(), ['smart-turn', 'stt', 'tts']);
  }
});

test('a missing smoke result fails the stage', () => {
  const verdict = evaluateReport(
    healthyReport({ stt: { smoke: null }, tts: { smoke: null }, smartTurn: { smoke: null } }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict).sort(), ['smart-turn', 'stt', 'tts']);
});

// ── smart-turn (su-lou.10.1) ──────────────────────────────────────────────────

test('the heuristic EOU fallback is a regression naming smart-turn', () => {
  // This is what main looked like for the whole life of the file: no provisioner,
  // so `if (!opts.modelUrl) return heuristic` took every call and the 2s silence
  // floor carried all the patience alone. The gate now says so out loud.
  const verdict = evaluateReport(
    healthyReport({
      smartTurn: {
        loadMode: 'heuristic',
        diagnostics: ['[smart-turn] model failed to load (404) — using the duration heuristic'],
        smoke: { mode: 'heuristic', completionProb: 0.83, ms: 1 },
      },
    }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['smart-turn']);
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  const summary = summarizeVerdict(verdict);
  assert.match(summary, /^WORKS-CHECK REGRESSION: smart-turn /);
  assert.match(summary, /404/, 'the adapter diagnosis must reach the one-line verdict');
});

test('an EOU load that greens while the per-call path degrades still fails (R4)', () => {
  const verdict = evaluateReport(
    healthyReport({ smartTurn: { smoke: { mode: 'heuristic', completionProb: 0.83, ms: 1 } } }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['smart-turn']);
  assert.match(verdict.failures[0].reason, /smoke-run degraded/);
});

test('a NaN or out-of-range probability is not a working classifier', () => {
  for (const completionProb of [NaN, -0.1, 1.5, 'yes', undefined]) {
    const verdict = evaluateReport(
      healthyReport({ smartTurn: { smoke: { mode: 'model', completionProb, ms: 40 } } }),
    );
    assert.equal(verdict.pass, false, `completionProb=${completionProb} must not pass`);
    assert.match(verdict.failures[0].reason, /no usable probability/);
  }
});

test('the EOU gate asserts liveness, not WHICH verdict is right', () => {
  // Both extremes are legitimate model output — a confident "complete" on a finished
  // sentence and a confident "incomplete" mid-thought. Accuracy is a feel-test
  // question (su-lou.10.5), so the gate must green either.
  for (const completionProb of [0, 0.0292, 0.5, 1]) {
    const verdict = evaluateReport(
      healthyReport({ smartTurn: { smoke: { mode: 'model', completionProb, ms: 40 } } }),
    );
    assert.equal(verdict.pass, true, `completionProb=${completionProb} should pass`);
  }
});

test('a probe-level smart-turn error is a named failure', () => {
  const verdict = evaluateReport(healthyReport({ smartTurn: { error: 'createSmartTurn threw: boom' } }));
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['smart-turn']);
  assert.match(verdict.failures[0].reason, /probe error: createSmartTurn threw/);
});
