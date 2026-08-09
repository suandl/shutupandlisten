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
//   7. a stage that ran out of TIME rather than out of backend is INFRA, not a
//      regression (su-ucww) — and the guards that keep that downgrade honest

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LISTENER_BUDGETS,
  SMART_TURN_BUDGETS,
  STT_BUDGETS,
  TTS_BUDGETS,
} from '../src/probe-budgets.ts';
import {
  EXIT_INFRA,
  EXIT_PASS,
  EXIT_REGRESSION,
  evaluateReport,
  exitCodeFor,
  isDegenerateText,
  summarizeVerdict,
} from './works-verdict.mjs';

/** Both listener rungs served, as a provisioned deploy answers: a small GRAPH file
 *  per rung plus the external `_data` sibling that holds the actual weights. */
function servedWeights() {
  return [
    { rung: 'webgpu/q4f16', url: '/models/m/onnx/model_q4f16.onnx', status: 200, contentType: 'application/octet-stream', bytes: 149790, error: null },
    { rung: 'webgpu/q4f16 weights', url: '/models/m/onnx/model_q4f16.onnx_data', status: 200, contentType: 'application/octet-stream', bytes: 1089605632, error: null },
    { rung: 'wasm/q4', url: '/models/m/onnx/model_q4.onnx', status: 200, contentType: 'application/octet-stream', bytes: 149112, error: null },
    { rung: 'wasm/q4 weights', url: '/models/m/onnx/model_q4.onnx_data', status: 200, contentType: 'application/octet-stream', bytes: 1692672000, error: null },
  ];
}

/** A fully-healthy report; tests override fields per scenario. The budgets are the
 *  REAL ones the probe grants, not invented numbers: the timeout rules compare
 *  elapsed against them, so a fixture carrying anything else would test a gate
 *  nobody runs — and a budget shrunk below these healthy timings SHOULD fail here. */
function healthyReport(overrides = {}) {
  return {
    version: 1,
    stt: {
      loadMode: 'moonshine',
      loadMs: 4200,
      smoke: { mode: 'moonshine', text: 'the works check confirms', ms: 180 },
      budgets: STT_BUDGETS,
      error: null,
      ...(overrides.stt ?? {}),
    },
    tts: {
      loadMode: 'wasm',
      loadMs: 6100,
      diagnostics: [],
      smoke: { mode: 'wasm', samples: 47000, sampleRate: 16000, rms: 0.114, ms: 5300 },
      budgets: TTS_BUDGETS,
      error: null,
      ...(overrides.tts ?? {}),
    },
    smartTurn: {
      loadMode: 'model',
      loadMs: 900,
      diagnostics: [],
      smoke: { mode: 'model', completionProb: 0.7434, ms: 60, warmMs: 55 },
      budgets: SMART_TURN_BUDGETS,
      error: null,
      ...(overrides.smartTurn ?? {}),
    },
    // Default = the cheap half only, which is what a plain `npm run works-check`
    // produces: weights asserted, model never loaded.
    listener: {
      loadMode: null,
      dtype: null,
      loadMs: 0,
      diagnostics: [],
      smoke: null,
      assets: servedWeights(),
      loaded: false,
      budgets: LISTENER_BUDGETS,
      error: null,
      ...(overrides.listener ?? {}),
    },
  };
}

/** A report from `works-check --with-listener` — the deep half ran and is healthy. */
function loadedListener(overrides = {}) {
  return {
    loadMode: 'wasm',
    dtype: 'q4',
    loadMs: 45000,
    diagnostics: [],
    smoke: { mode: 'wasm', text: 'That sounds exhausting. What keeps pulling you back to it?', ms: 9000 },
    assets: servedWeights(),
    loaded: true,
    budgets: LISTENER_BUDGETS,
    error: null,
    ...overrides,
  };
}

/** The shape an adapter leaves behind when it runs out of time: it spent its whole
 *  budget and handed back the labelled fallback. `over` is the overshoot past the
 *  deadline — the observed runs were 1-18ms past (su-ucww). */
const spent = (budgetMs, over = 1) => budgetMs + over;

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
    assert.deepEqual(failedStages(verdict).sort(), ['listener', 'smart-turn', 'stt', 'tts']);
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

// ── listener (su-lou.9) ──

test('weights-only run passes and its summary says the model was NOT loaded', () => {
  const verdict = evaluateReport(healthyReport());
  assert.equal(verdict.pass, true);
  const summary = summarizeVerdict(verdict);
  assert.match(summary, /^WORKS-CHECK PASS/);
  // The overclaim guard: a cheap run must never read as "the listener works".
  assert.match(summary, /model not loaded/);
  assert.match(summary, /--with-listener/);
});

test('a loaded listener passes and the summary drops the not-loaded caveat', () => {
  const verdict = evaluateReport(healthyReport({ listener: loadedListener() }));
  assert.equal(verdict.pass, true);
  assert.equal(exitCodeFor(verdict), EXIT_PASS);
  assert.doesNotMatch(summarizeVerdict(verdict), /not loaded/);
});

test('a rung whose weights 404 is a regression — the ladder wants what nobody ships', () => {
  const assets = servedWeights();
  assets[0] = { ...assets[0], status: 404, contentType: 'text/plain' };
  const verdict = evaluateReport(healthyReport({ listener: { assets } }));
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['listener']);
  assert.match(verdict.failures[0].reason, /webgpu\/q4f16 weights .* HTTP 404/);
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
});

test('a graph served with its external weights MISSING is a regression', () => {
  // The interrupted-provisioning shape: `model_q4.onnx` (149KB of graph) is on disk
  // and its 1.69G `_data` sibling is not. Checking only the .onnx would green this.
  const assets = servedWeights();
  assets[3] = { ...assets[3], status: 404, contentType: 'text/plain', bytes: null };
  const verdict = evaluateReport(healthyReport({ listener: { assets } }));
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['listener']);
  assert.match(verdict.failures[0].reason, /wasm\/q4 weights .*model_q4\.onnx_data: HTTP 404/);
});

test('weights answered by the SPA fallback (200 text/html) fail, not pass — su-lou.7', () => {
  const assets = servedWeights();
  assets[1] = { ...assets[1], contentType: 'text/html; charset=utf-8', bytes: 610 };
  const verdict = evaluateReport(healthyReport({ listener: { assets } }));
  assert.equal(verdict.pass, false);
  assert.match(verdict.failures[0].reason, /SPA fallback/);
});

test('an empty asset list fails — "checked nothing" must not read as "found nothing"', () => {
  const verdict = evaluateReport(healthyReport({ listener: { assets: [] } }));
  assert.equal(verdict.pass, false);
  assert.match(verdict.failures[0].reason, /checked no listener weight assets/);
});

test('a stubbed listener load is a regression carrying the adapter diagnosis', () => {
  const verdict = evaluateReport(
    healthyReport({
      listener: loadedListener({
        loadMode: 'stub',
        dtype: null,
        smoke: { mode: 'stub', text: '⟨listener: reflection — LLM not loaded⟩', ms: 1 },
        diagnostics: ["[listener] listener unavailable: no model loaded (webgpu/q4f16: skipped — no WebGPU adapter with 'shader-f16'; wasm/q4: out of memory) — using the labelled stub"],
      }),
    }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['listener']);
  const summary = summarizeVerdict(verdict);
  assert.match(summary, /^WORKS-CHECK REGRESSION: listener /);
  // The whole point of the diagnosability fix: the gate line names the cause.
  assert.match(summary, /shader-f16/);
});

test('the su-lou.9 false-green — real backend, non-empty, but not language — fails', () => {
  const verdict = evaluateReport(
    healthyReport({
      listener: loadedListener({
        loadMode: 'webgpu',
        dtype: 'q4f16',
        smoke: { mode: 'webgpu', text: '!!!!!!!!!!!!', ms: 29000 },
      }),
    }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['listener']);
  assert.match(verdict.failures[0].reason, /not language/);
});

// ── budget exhaustion is INFRA, not a regression (su-ucww) ────────────────────

test('an STT load that spends its whole budget is INFRA, and collapses to one finding', () => {
  // The observed shape: init blew the budget, the adapter degraded exactly as
  // designed, and the instant stub transcribe that followed is a CONSEQUENCE of
  // that — not a second, separate finding, and certainly not a regression that
  // would pin the run back to exit 100.
  const verdict = evaluateReport(
    healthyReport({
      stt: {
        loadMode: 'stub',
        loadMs: spent(STT_BUDGETS.initMs),
        smoke: { mode: 'stub', text: '⟨speech 2.4s — STT model not loaded⟩', ms: 1 },
      },
    }),
  );
  assert.equal(verdict.pass, false);
  assert.equal(verdict.failures.length, 1, 'the timeout is ONE fact, not one finding per assertion it broke');
  assert.equal(verdict.failures[0].stage, 'stt');
  assert.equal(verdict.failures[0].kind, 'infra');
  assert.equal(exitCodeFor(verdict), EXIT_INFRA);
  const summary = summarizeVerdict(verdict);
  assert.match(summary, /^WORKS-CHECK INFRA \(budget exhausted\): stt /);
  assert.match(summary, new RegExp(`${STT_BUDGETS.initMs}ms`), 'the line must name the budget that ran out');
  assert.match(summary, /re-run on an idle machine/);
  assert.doesNotMatch(summary, /REGRESSION/);
});

test('a TTS smoke-run that spends its whole budget is INFRA even though the load was real', () => {
  // The other half of the observed pair: `tts load=wasm smoke=stub (30018ms)`. The
  // voice loaded fine; synthesis just never finished inside its budget.
  const verdict = evaluateReport(
    healthyReport({
      tts: { smoke: { mode: 'stub', samples: 12000, sampleRate: 16000, rms: 0.08, ms: spent(TTS_BUDGETS.callMs, 18) } },
    }),
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(failedStages(verdict), ['tts']);
  assert.equal(verdict.failures[0].kind, 'infra');
  assert.equal(exitCodeFor(verdict), EXIT_INFRA);
  assert.match(summarizeVerdict(verdict), /^WORKS-CHECK INFRA \(budget exhausted\): tts /);
});

test('the su-ucww run — STT load and TTS synthesis both out of budget — is exit 2, not 100', () => {
  // Byte-identical on the branch and on origin/main is what proved this was the
  // machine talking. A gate that answers 100 to both discriminates nothing.
  const verdict = evaluateReport(
    healthyReport({
      stt: {
        loadMode: 'stub',
        loadMs: spent(STT_BUDGETS.initMs),
        smoke: { mode: 'stub', text: '⟨speech 2.4s — STT model not loaded⟩', ms: 1 },
      },
      tts: { smoke: { mode: 'stub', samples: 12000, sampleRate: 16000, rms: 0.08, ms: spent(TTS_BUDGETS.callMs, 18) } },
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_INFRA);
  assert.deepEqual(failedStages(verdict).sort(), ['stt', 'tts']);
  assert.ok(verdict.failures.every((f) => f.kind === 'infra'));
});

test('a real regression alongside an unjudgeable stage still exits 100 — and says which was which', () => {
  const verdict = evaluateReport(
    healthyReport({
      // Out of time: no verdict available for this stage.
      stt: {
        loadMode: 'stub',
        loadMs: spent(STT_BUDGETS.initMs),
        smoke: { mode: 'stub', text: '⟨speech 2.4s — STT model not loaded⟩', ms: 1 },
      },
      // Out of backend, promptly: a genuine finding, and the run's verdict.
      smartTurn: {
        loadMode: 'heuristic',
        diagnostics: ['[smart-turn] model failed to load (404) — using the duration heuristic'],
        smoke: { mode: 'heuristic', completionProb: 0.83, ms: 1 },
      },
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  const summary = summarizeVerdict(verdict);
  assert.match(summary, /^WORKS-CHECK REGRESSION: smart-turn /);
  // The stage nobody could judge must not read as a stage that passed.
  assert.match(summary, /NOT JUDGED \(budget exhausted\): stt /);
});

test('a degrade well inside its budget stays a REGRESSION — the downgrade needs evidence', () => {
  // su-lou.8's stubbed voice failed in 3ms. Nothing about that is a slow machine,
  // and a rule that excused it would have deleted the gate.
  const verdict = evaluateReport(
    healthyReport({
      tts: {
        loadMode: 'stub',
        loadMs: 900,
        diagnostics: ['[tts] voice unavailable: no model loaded — using the placeholder tone'],
        smoke: { mode: 'stub', samples: 12000, sampleRate: 16000, rms: 0.08, ms: 3 },
      },
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  assert.ok(verdict.failures.every((f) => (f.kind ?? 'regression') === 'regression'));
});

test('a report that carries no budgets fails LOUD — an old probe must not silence the gate', () => {
  // Fail-closed default: a probe too old to report what it was granted (or a
  // malformed one) cannot evidence exhaustion, so nothing is downgraded.
  const stt = { loadMode: 'stub', loadMs: 15001, smoke: { mode: 'stub', text: 'x', ms: 1 }, error: null };
  const verdict = evaluateReport({ ...healthyReport(), stt });
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  assert.match(summarizeVerdict(verdict), /^WORKS-CHECK REGRESSION: stt /);
});

test('a slow but HEALTHY half is still a pass — the rule never invents a failure', () => {
  // The guard on the downgrade: it re-labels findings, it does not create them. A
  // half that somehow spent its whole budget and still returned a real backend has
  // nothing wrong with it, and must not become an infra flake.
  const verdict = evaluateReport(
    healthyReport({
      stt: { loadMs: spent(STT_BUDGETS.initMs), smoke: { mode: 'moonshine', text: 'still real', ms: spent(STT_BUDGETS.callMs) } },
    }),
  );
  assert.equal(verdict.pass, true);
  assert.equal(exitCodeFor(verdict), EXIT_PASS);
});

test('a listener load out of budget is INFRA, but a 404 rung in the same run is still a regression', () => {
  // Asset findings are facts about what the deploy SERVES — true whatever the clock
  // did. A slow load in the same run must not launder a 404 into a retryable flake.
  const assets = servedWeights();
  assets[0] = { ...assets[0], status: 404, contentType: 'text/plain' };
  const verdict = evaluateReport(
    healthyReport({
      listener: loadedListener({
        assets,
        loadMode: 'stub',
        dtype: null,
        loadMs: spent(LISTENER_BUDGETS.initMs),
        smoke: { mode: 'stub', text: '⟨listener: reflection — LLM not loaded⟩', ms: 1 },
      }),
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  const kinds = verdict.failures.map((f) => f.kind ?? 'regression');
  assert.deepEqual(kinds, ['regression', 'infra'], 'the 404 stands; the timed-out load collapses to one infra finding');
  const summary = summarizeVerdict(verdict);
  assert.match(summary, /^WORKS-CHECK REGRESSION: listener .*HTTP 404/);
  assert.match(summary, /NOT JUDGED \(budget exhausted\): listener /);
});

// ── a SLOW load does not excuse a BROKEN smoke-run (su-8xkb) ─────────────────
//
// The load-side downgrade collapses a whole stage, so it has to be gated on the
// load having actually degraded — not merely on it having been slow. `spentMs >=
// budgetMs` alone does not prove a timeout: the probe's clock starts before the
// adapter arms its own timer, so a REAL backend can cross the line and still hand
// back a working stage. When it does, the stage stayed judgeable, and a smoke-run
// that produced nothing usable is a genuine regression. Excusing it by the load's
// clock is su-ucww's lie pointing the other way — the gate would exit 2 and retry
// forever over output that is actually broken.
//
// One per stage, because the wrapper is applied identically at all four.

test('a real STT load that merely ran LONG does not launder an empty transcript', () => {
  const verdict = evaluateReport(
    healthyReport({
      stt: {
        loadMode: 'moonshine',
        loadMs: spent(STT_BUDGETS.initMs),
        smoke: { mode: 'moonshine', text: '', ms: 150 },
      },
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  assert.deepEqual(failedStages(verdict), ['stt']);
  assert.equal(verdict.failures.length, 1);
  assert.equal(verdict.failures[0].kind ?? 'regression', 'regression');
  assert.match(verdict.failures[0].reason, /transcript is empty/);
  assert.match(summarizeVerdict(verdict), /^WORKS-CHECK REGRESSION: stt /);
});

test('a real TTS load that merely ran LONG does not launder a degraded synthesis', () => {
  const verdict = evaluateReport(
    healthyReport({
      tts: {
        loadMode: 'wasm',
        loadMs: spent(TTS_BUDGETS.initMs),
        smoke: { mode: 'stub', samples: 12000, sampleRate: 16000, rms: 0.08, ms: 40 },
      },
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0].reason, /smoke-run degraded/);
});

test('a real EOU load that merely ran LONG does not launder a heuristic verdict', () => {
  const verdict = evaluateReport(
    healthyReport({
      smartTurn: {
        loadMode: 'model',
        loadMs: spent(SMART_TURN_BUDGETS.initMs),
        smoke: { mode: 'heuristic', completionProb: 0.83, ms: 1 },
      },
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0].reason, /smoke-run degraded/);
});

test('a real listener load that merely ran LONG does not launder a degenerate reply', () => {
  // su-lou.9's `"!!!!!!!!!!!!"` — a live webgpu backend with no `shader-f16`. It is
  // broken whatever the load's clock did, and the 420s budget is exactly the one a
  // contended box crosses on this stage.
  const verdict = evaluateReport(
    healthyReport({
      listener: loadedListener({
        loadMode: 'webgpu',
        dtype: 'q4f16',
        loadMs: spent(LISTENER_BUDGETS.initMs),
        smoke: { mode: 'webgpu', text: '!!!!!!!!!!!!', ms: 29000 },
      }),
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0].reason, /not language/);
});

test('a prompt load regression and a timed-out smoke-run stay TWO findings, one per half', () => {
  // The collapse is what makes a timed-out load speak for its whole stage; without
  // one, each half keeps its own attribution. su-lou.8's 3ms stubbed voice is a
  // verdict about the code, and the synthesis that then ran out of budget is not —
  // reporting only one of those would drop a real finding or invent a fake one.
  const verdict = evaluateReport(
    healthyReport({
      tts: {
        loadMode: 'stub',
        loadMs: 900,
        diagnostics: ['[tts] voice unavailable: no model loaded — using the placeholder tone'],
        smoke: { mode: 'stub', samples: 12000, sampleRate: 16000, rms: 0.08, ms: spent(TTS_BUDGETS.callMs) },
      },
    }),
  );
  assert.equal(exitCodeFor(verdict), EXIT_REGRESSION);
  assert.deepEqual(
    verdict.failures.map((f) => f.kind ?? 'regression'),
    ['regression', 'infra'],
  );
  const summary = summarizeVerdict(verdict);
  assert.match(summary, /^WORKS-CHECK REGRESSION: tts .*no model loaded/);
  assert.match(summary, /NOT JUDGED \(budget exhausted\): tts /);
});

test('isDegenerateText separates noise from short real replies', () => {
  for (const bad of ['', '   ', '!!!!!!!!!!!!', '............', 'aaaaaaaa', '1111', null, undefined]) {
    assert.equal(isDegenerateText(bad), true, `expected degenerate: ${JSON.stringify(bad)}`);
  }
  for (const good of ['Hi', 'Ok.', 'I see.', 'That sounds exhausting. What keeps pulling you back?']) {
    assert.equal(isDegenerateText(good), false, `expected real text: ${JSON.stringify(good)}`);
  }
});
