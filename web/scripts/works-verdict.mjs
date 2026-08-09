// Verdict half of the works-check (su-ljrb.6) — pure report → classification.
//
// The probe page (src/probe.ts) reports FACTS (modes, texts, sample counts); this
// module decides what they MEAN, per the plan's requirements: each stage must
// report its REAL backend, not a stub (origin R2 for STT, R3 for TTS, the
// LISTENER since su-lou.9, and the same rule extended to the smart-turn EOU
// classifier in su-lou.10.1), and each must survive a smoke-run with non-empty
// output — liveness, not accuracy (R4).
// Split from the driver so the rules are unit-testable without a browser
// (works-verdict.test.mjs), and so the exit-0 path is covered even while the gate
// is expected red on main (su-lou.8's TTS stub is open by design until its fix
// lands WITH this guard).
//
// Exit-code contract (origin KTD4, consumed later by the refinery gate E3/U8):
//   0   → every stage passed
//   100 → REAL regression — a stage is live but reports a stub/degraded backend or
//         empty output; the summary names the stage(s)
//   2   → infra-flake — the check itself could not run to a verdict (build,
//         server, browser, fixture, provisioning, or a stage that ran out of TIME
//         rather than out of backend — see below); retryable, not a code verdict
// Any other code (an uncaught crash's 1, a signal death) also reads as infra —
// only 0 and 100 are ever a verdict about the code under check.
//
// BUDGET EXHAUSTION IS INFRA, NOT A REGRESSION (su-ucww). Every adapter degrades to
// its labelled fallback when a budget runs out, and a degraded fallback is exactly
// what a broken backend looks like from here — so on a loaded box this module used
// to report the machine's state as a verdict about the code. It did it identically
// on a branch and on origin/main (STT init at 15001ms vs 15006ms, both pinned to
// the same budget), which is the tell: a run that cannot discriminate is not a
// verdict. The probe now reports what each half was ALLOWED next to what it SPENT
// (src/probe-budgets.ts), and a HALF that spent its whole budget and degraded is
// classified `infra` — the check saying "I could not tell", never "the code broke".
//
// Per HALF is load-bearing, not a detail: a load that ran long and still came back
// REAL leaves the stage perfectly judgeable, so a smoke-run that then produced
// nothing usable is still a regression. Excusing it by the load's clock would be
// the same lie pointing the other way — a broken backend retried forever as a
// flake — which is why the downgrade below is gated on the load having actually
// degraded, not merely on it having been slow.

export const EXIT_PASS = 0;
export const EXIT_REGRESSION = 100;
export const EXIT_INFRA = 2;

/** Adapter modes that count as a REAL STT backend. 'stub' is the labelled
 *  degrade; 'sim' is the demo simulator's scripted words (su-lou.4.1) — genuine
 *  text but NOT a real STT run, so it must never green the gate. */
const REAL_STT_MODES = new Set(['moonshine', 'whisper']);

/** The one real TTS mode this gate accepts. R3 pins `wasm` exactly: the works
 *  gate runs the pure-WASM slice (GPU-less host), so a surprise 'webgpu' means
 *  the plan's scope assumption broke — fail loudly and revisit, don't green. */
const REAL_TTS_MODE = 'wasm';

/** The one real smart-turn mode (su-lou.10.1). 'heuristic' is the labelled degrade
 *  — the duration proxy that ran for EVERY session before a model was provisioned,
 *  which is exactly the silent-fallback class this gate exists to catch. */
const REAL_SMART_TURN_MODE = 'model';

/** Adapter modes that count as a REAL listener backend. Unlike TTS this accepts
 *  BOTH: the gate's headless browser exposes no WebGPU adapter with `shader-f16`,
 *  so it lands on the wasm rung, while an operator running the same check on a GPU
 *  box lands on webgpu — and both are honest live backends. 'stub' is the degrade. */
const REAL_LISTENER_MODES = new Set(['webgpu', 'wasm']);

/**
 * Is this reply real text, or a live-looking backend emitting noise?
 *
 * su-lou.9 measured a listener that loaded on WebGPU, reported mode 'webgpu',
 * threw nothing, and generated `"!!!!!!!!!!!!"` — the adapter had no `shader-f16`
 * so its f16 compute pipelines were all invalid. Every check the other stages use
 * passes on that: real backend, non-empty output. So the listener's liveness rule
 * additionally asks for CHARACTERS a language model produces — at least one letter,
 * and at least two distinct alphanumerics, which the degenerate runs (a single
 * punctuation mark or letter repeated to the token limit) cannot clear. Still
 * liveness, not accuracy: it says nothing about whether the reply is any good.
 */
export function isDegenerateText(text) {
  if (typeof text !== 'string') return true;
  const t = text.trim();
  if (t === '') return true;
  if (!/[A-Za-z]/.test(t)) return true;
  return new Set(t.toLowerCase().replace(/[^a-z0-9]/g, '')).size < 2;
}

/**
 * @typedef {'stt' | 'tts' | 'smart-turn' | 'listener'} Stage
 * @typedef {{ stage: Stage, reason: string, kind?: 'regression' | 'infra' }} Failure
 * @typedef {{ pass: boolean, failures: Failure[], scope: string }} Verdict
 */

/** A failure with no `kind` is a code regression. The default is the LOUD one on
 *  purpose: only the rules that can positively evidence budget exhaustion are
 *  allowed to downgrade a finding, so an unrecognised report shape — including one
 *  from a probe too old to report its budgets — still exits 100. */
const kindOf = (failure) => failure?.kind ?? 'regression';

/**
 * Did this half spend the whole budget the gate granted it?
 *
 * No fudge factor, and none is needed: the probe's clock starts strictly BEFORE the
 * adapter arms its own timer, so a half that timed out always reads at or past its
 * budget (the observed 15001ms against a 15000ms budget). A tolerance would only
 * buy the chance to excuse a genuinely fast degrade that landed near the boundary.
 *
 * Absent or nonsensical numbers answer NO — a report that cannot evidence
 * exhaustion does not get the benefit of the doubt.
 */
function spentWholeBudget(spentMs, budgetMs) {
  return (
    typeof budgetMs === 'number' &&
    Number.isFinite(budgetMs) &&
    budgetMs > 0 &&
    typeof spentMs === 'number' &&
    Number.isFinite(spentMs) &&
    spentMs >= budgetMs
  );
}

/**
 * Re-attribute a half's failures when that half ran out of TIME rather than out of
 * backend: the several R2/R4 findings a timeout produces all describe the same one
 * fact, so they collapse into a single `infra` failure that names the budget.
 *
 * Two properties make this safe to apply widely:
 *   - it never INVENTS a failure. An empty list stays empty, so a slow-but-healthy
 *     half — one that spent its budget and still returned a real backend — remains
 *     a pass rather than becoming an infra flake.
 *   - it never downgrades without evidence. Absent budgets, or a half that finished
 *     inside its budget, come back untouched and stay regressions.
 *
 * It re-attributes ONE half's own findings; which findings belong to which half,
 * and when a timed-out load speaks for the whole stage, is stageFailures' job.
 *
 * @param {Failure[]} failures @param {Stage} stage @param {string} what
 * @param {unknown} spentMs @param {unknown} budgetMs @param {string} diag
 * @returns {Failure[]}
 */
function budgetAware(failures, stage, what, spentMs, budgetMs, diag = '') {
  if (failures.length === 0 || !spentWholeBudget(spentMs, budgetMs)) return failures;
  return [
    {
      stage,
      kind: 'infra',
      reason:
        `${what} spent the whole ${budgetMs}ms the gate allowed (${spentMs}ms) and degraded — ` +
        `budget exhaustion on a contended machine, not a verdict about the code${diag}`,
    },
  ];
}

/**
 * Fold a stage's two halves — the LOAD assertions and the per-call SMOKE
 * assertions — into the run's findings, under each half's own budget.
 *
 * The whole rule lives here rather than at the four call sites, because the two
 * halves are NOT symmetric and the asymmetry is easy to get backwards:
 *
 *   - A load that timed out speaks for the WHOLE stage. Every later assertion is
 *     measuring the labelled stub that timeout produced, so they are one fact, not
 *     one finding per assertion it broke — STT's instant stub transcribe would
 *     otherwise read as a regression and pin the run back to exit 100, the exact
 *     false verdict su-ucww removes. Hence: collapse, and drop the smoke findings.
 *
 *   - A load that merely ran LONG collapses nothing. `spentMs >= budgetMs` is the
 *     evidence a load DEGRADED on its deadline, not evidence on its own: the probe's
 *     clock starts before the adapter arms its timer, so a real backend can cross
 *     the line and still hand back a working stage. When it does, the stage stayed
 *     judgeable, and a smoke-run that then produced nothing usable is a genuine
 *     regression — one the load's clock must not launder into a retryable flake
 *     (a real STT loaded at budget+1ms with an empty transcript is exit 100, not 2).
 *
 * So the collapse is gated on the load half having actually FAILED. With no load
 * finding there is nothing to collapse and nothing that explains the smoke half,
 * and each half is left under its own budget.
 *
 * @param {Stage} stage
 * @param {{ load: Failure[], smoke: Failure[], loadWhat: string, smokeWhat: string,
 *           loadMs: unknown, smokeMs: unknown, budgets: unknown, diag?: string }} halves
 * @returns {Failure[]}
 */
function stageFailures(stage, halves) {
  const { load, smoke, loadWhat, smokeWhat, loadMs, smokeMs, budgets, diag = '' } = halves;
  const initMs = budgets?.initMs;
  if (load.length > 0 && spentWholeBudget(loadMs, initMs)) {
    return budgetAware(load, stage, loadWhat, loadMs, initMs, diag);
  }
  return [...load, ...budgetAware(smoke, stage, smokeWhat, smokeMs, budgets?.callMs, diag)];
}

/**
 * Classify a probe report. Defensive against a malformed/partial report (a probe
 * bug must read as a failing stage, never a silent pass).
 *
 * @param {unknown} report — the ProbeReport from window.__worksCheck.run()
 * @returns {Verdict}
 */
export function evaluateReport(report) {
  /** @type {Failure[]} */
  const failures = [];
  const stt = report?.stt;
  const tts = report?.tts;

  if (!stt || typeof stt !== 'object') {
    failures.push({ stage: 'stt', reason: 'probe returned no stt report' });
  } else if (stt.error) {
    failures.push({ stage: 'stt', reason: `probe error: ${stt.error}` });
  } else {
    /** @type {Failure[]} */
    const load = [];
    if (!REAL_STT_MODES.has(stt.loadMode)) {
      load.push({ stage: 'stt', reason: `loaded mode '${stt.loadMode}' is not a real STT backend (R2)` });
    }
    /** @type {Failure[]} */
    const smoke = [];
    if (!stt.smoke) {
      smoke.push({ stage: 'stt', reason: 'smoke-run never produced a transcription result' });
    } else if (!REAL_STT_MODES.has(stt.smoke.mode)) {
      smoke.push({ stage: 'stt', reason: `smoke-run degraded to '${stt.smoke.mode}' (R4)` });
    } else if (typeof stt.smoke.text !== 'string' || stt.smoke.text.trim() === '') {
      smoke.push({ stage: 'stt', reason: 'smoke-run transcript is empty on the speech fixture (R4)' });
    }
    failures.push(
      ...stageFailures('stt', {
        load,
        smoke,
        loadWhat: 'the STT adapter load',
        smokeWhat: 'the transcription smoke-run',
        loadMs: stt.loadMs,
        smokeMs: stt.smoke?.ms,
        budgets: stt.budgets,
      }),
    );
  }

  if (!tts || typeof tts !== 'object') {
    failures.push({ stage: 'tts', reason: 'probe returned no tts report' });
  } else if (tts.error) {
    failures.push({ stage: 'tts', reason: `probe error: ${tts.error}` });
  } else {
    // The adapter's onDiagnostic lines carry WHY a voice degraded (su-lou.7's
    // diagnosability fix) — fold them in so the gate's one-line verdict names the
    // root cause without anyone re-running with a debugger.
    const diag = Array.isArray(tts.diagnostics) && tts.diagnostics.length > 0 ? ` — ${tts.diagnostics.join(' | ')}` : '';
    /** @type {Failure[]} */
    const load = [];
    if (tts.loadMode !== REAL_TTS_MODE) {
      load.push({ stage: 'tts', reason: `loaded mode '${tts.loadMode}' is not the real wasm backend (R3)${diag}` });
    }
    /** @type {Failure[]} */
    const smoke = [];
    if (!tts.smoke) {
      smoke.push({ stage: 'tts', reason: 'smoke-run never produced a synthesis result' });
    } else if (tts.smoke.mode !== REAL_TTS_MODE) {
      // The load can go green while synthesis still degrades per call — the
      // spike proved this exact false-green (partial mms-tts fix loads, then
      // falls to the placeholder tone), which is why the smoke-run is asserted
      // separately from the load mode. su-ucww is the same shape from the other
      // side: a synthesis that degraded because it ran out of budget, which the
      // wrapper below re-attributes to the machine rather than to the voice.
      smoke.push({ stage: 'tts', reason: `smoke-run degraded to '${tts.smoke.mode}' (R4)${diag}` });
    } else if (!(tts.smoke.samples > 0) || !(tts.smoke.sampleRate > 0)) {
      smoke.push({ stage: 'tts', reason: `smoke-run returned no audio (samples=${tts.smoke.samples}, rate=${tts.smoke.sampleRate}) (R4)` });
    } else if (!(tts.smoke.rms > 0)) {
      smoke.push({ stage: 'tts', reason: 'smoke-run audio is all-zero silence (R4)' });
    }
    failures.push(
      ...stageFailures('tts', {
        load,
        smoke,
        loadWhat: 'the TTS adapter load',
        smokeWhat: 'the synthesis smoke-run',
        loadMs: tts.loadMs,
        smokeMs: tts.smoke?.ms,
        budgets: tts.budgets,
        diag,
      }),
    );
  }

  const smartTurn = report?.smartTurn;
  if (!smartTurn || typeof smartTurn !== 'object') {
    failures.push({ stage: 'smart-turn', reason: 'probe returned no smart-turn report' });
  } else if (smartTurn.error) {
    failures.push({ stage: 'smart-turn', reason: `probe error: ${smartTurn.error}` });
  } else {
    // As with TTS, fold the adapter's diagnostics into the reason so "the model
    // 404s" and "the model loaded but scores nothing" are told apart at a glance.
    const diag =
      Array.isArray(smartTurn.diagnostics) && smartTurn.diagnostics.length > 0 ? ` — ${smartTurn.diagnostics.join(' | ')}` : '';
    /** @type {Failure[]} */
    const load = [];
    if (smartTurn.loadMode !== REAL_SMART_TURN_MODE) {
      load.push({
        stage: 'smart-turn',
        reason: `loaded mode '${smartTurn.loadMode}' is not the real EOU classifier (R2)${diag}`,
      });
    }
    /** @type {Failure[]} */
    const smoke = [];
    if (!smartTurn.smoke) {
      smoke.push({ stage: 'smart-turn', reason: 'smoke-run never produced a verdict' });
    } else if (smartTurn.smoke.mode !== REAL_SMART_TURN_MODE) {
      // The load can go green while the per-call path degrades — the same false-green
      // the TTS stage proved is real, and the likelier failure here: a front-end or
      // shape mismatch throws inside predict() and the adapter answers with the
      // heuristic while `.mode` still says model.
      smoke.push({ stage: 'smart-turn', reason: `smoke-run degraded to '${smartTurn.smoke.mode}' (R4)${diag}` });
    } else if (
      typeof smartTurn.smoke.completionProb !== 'number' ||
      !Number.isFinite(smartTurn.smoke.completionProb) ||
      smartTurn.smoke.completionProb < 0 ||
      smartTurn.smoke.completionProb > 1
    ) {
      // Liveness, not accuracy: WHICH verdict is right is a feel-test question. A
      // NaN or out-of-range score, though, means the output mapping is broken —
      // a model whose probability is nonsense is not a working stage.
      smoke.push({
        stage: 'smart-turn',
        reason: `smoke-run returned no usable probability (completionProb=${smartTurn.smoke.completionProb}) (R4)`,
      });
    }
    failures.push(
      ...stageFailures('smart-turn', {
        load,
        smoke,
        loadWhat: 'the EOU adapter load',
        smokeWhat: 'the EOU smoke-run',
        loadMs: smartTurn.loadMs,
        // The COLD verdict's own time, which is the one the budget bounded — the warm
        // runs after it are the occupancy measurement's, reported and never gated.
        smokeMs: smartTurn.smoke?.ms,
        budgets: smartTurn.budgets,
        diag,
      }),
    );
  }

  evaluateListener(report?.listener, failures);

  // What the run actually covered, so a PASS can never overclaim. The listener's
  // deep half is opt-in, and "we did not load the model" must be visible in the one
  // line most people read — a skipped check that prints like a passed one is the
  // failure mode this whole gate exists to prevent.
  const scope = report?.listener?.loaded
    ? 'stt + tts + smart-turn + listener'
    : 'stt + tts + smart-turn + listener weights (model not loaded — pass --with-listener)';

  return { pass: failures.length === 0, failures, scope };
}

/**
 * Listener rules (su-lou.9). Two tiers, matching the probe's two halves:
 *
 *   ALWAYS — every rung of the device ladder must have its weight file actually
 *   SERVED. This is the only listener assertion that covers a rung the gate's
 *   headless browser cannot execute (it has no WebGPU adapter, so `webgpu/q4f16` is
 *   never loaded here yet is exactly what an operator runs). A 404 means the
 *   provisioner and the ladder disagree about which quantization ships; a
 *   `200 text/html` means the SPA fallback is back (su-lou.7) and transformers.js is
 *   about to JSON.parse an HTML page.
 *
 *   WHEN LOADED (`works-check --with-listener`) — the adapter must report a real
 *   backend and generate real text, with the extra degeneracy rule above.
 *
 * @param {unknown} listener @param {Failure[]} failures
 */
function evaluateListener(listener, failures) {
  if (!listener || typeof listener !== 'object') {
    failures.push({ stage: 'listener', reason: 'probe returned no listener report' });
    return;
  }

  const assets = Array.isArray(listener.assets) ? listener.assets : null;
  if (!assets || assets.length === 0) {
    // Never treat "no rungs checked" as "no problems found": an empty list is the
    // shape a probe bug produces, and it must read as a failing stage.
    failures.push({ stage: 'listener', reason: 'probe checked no listener weight assets (R2)' });
  } else {
    for (const a of assets) {
      const where = `${a?.rung ?? '?'} weights ${a?.url ?? '?'}`;
      if (a?.error) {
        failures.push({ stage: 'listener', reason: `${where}: request failed (${a.error})` });
      } else if (a?.status === 404) {
        failures.push({
          stage: 'listener',
          reason: `${where}: HTTP ${a?.status} — the ladder wants a quantization the deploy does not serve (R2)`,
        });
      } else if (a?.status !== 200) {
        // A 404 is provisioner/ladder drift (diagnosed above); any other non-200
        // (500, 503, …) is the server misbehaving, not a missing file — don't
        // claim a deploy gap the status does not evidence.
        failures.push({
          stage: 'listener',
          reason: `${where}: HTTP ${a?.status} — unexpected status for a weight asset (R2)`,
        });
      } else if (/^text\/html/i.test(a?.contentType ?? '')) {
        failures.push({
          stage: 'listener',
          reason: `${where}: served as '${a.contentType}' — SPA fallback, not the model file (su-lou.7)`,
        });
      } else if (a?.bytes !== null && !(a?.bytes > 0)) {
        failures.push({ stage: 'listener', reason: `${where}: served 0 bytes` });
      }
    }
  }

  if (listener.error) {
    failures.push({ stage: 'listener', reason: `probe error: ${listener.error}` });
    return;
  }
  // The deep half is opt-in; when it did not run there is no backend to judge. The
  // driver prints that it was skipped — silence here must not read as a pass.
  if (!listener.loaded) return;

  // The adapter's onDiagnostic lines name WHY the listener degraded — the su-lou.9
  // diagnosability fix. Fold them in so the one-line verdict carries the root cause.
  const diag = Array.isArray(listener.diagnostics) && listener.diagnostics.length > 0 ? ` — ${listener.diagnostics.join(' | ')}` : '';
  // Only the LOADED half goes through the budget attribution. The asset findings
  // above stay where they are on purpose: a 404 or an SPA-fallback `text/html` is a
  // fact about what the deploy SERVES, true whatever the clock did, and a load that
  // happens to time out in the same run must not launder it into a retryable flake.
  /** @type {Failure[]} */
  const load = [];
  if (!REAL_LISTENER_MODES.has(listener.loadMode)) {
    load.push({ stage: 'listener', reason: `loaded mode '${listener.loadMode}' is not a real LLM backend (R2)${diag}` });
  }
  /** @type {Failure[]} */
  const smoke = [];
  if (!listener.smoke) {
    smoke.push({ stage: 'listener', reason: 'smoke-run never produced a reply' });
  } else if (!REAL_LISTENER_MODES.has(listener.smoke.mode)) {
    smoke.push({ stage: 'listener', reason: `smoke-run degraded to '${listener.smoke.mode}' (R4)${diag}` });
  } else if (isDegenerateText(listener.smoke.text)) {
    smoke.push({
      stage: 'listener',
      reason: `smoke-run reply is not language: ${JSON.stringify(String(listener.smoke.text ?? '').slice(0, 40))} (R4)${diag}`,
    });
  }
  failures.push(
    ...stageFailures('listener', {
      load,
      smoke,
      loadWhat: 'the listener model load',
      smokeWhat: 'the reply smoke-run',
      loadMs: listener.loadMs,
      smokeMs: listener.smoke?.ms,
      budgets: listener.budgets,
      diag,
    }),
  );
}

/**
 * A run with even ONE code regression is a code verdict — exit 100 — however many
 * other stages the machine made unjudgeable. Only when every finding is budget
 * exhaustion does the run fall back to the retryable infra code: there is nothing
 * to say about the code, so it must not say anything.
 *
 * @param {Verdict} verdict @returns {number}
 */
export function exitCodeFor(verdict) {
  if (verdict.pass) return EXIT_PASS;
  return verdict.failures.some((f) => kindOf(f) === 'regression') ? EXIT_REGRESSION : EXIT_INFRA;
}

/** @param {Failure[]} failures @returns {string} */
function byStage(failures) {
  const grouped = new Map();
  for (const f of failures) {
    if (!grouped.has(f.stage)) grouped.set(f.stage, []);
    grouped.get(f.stage).push(f.reason);
  }
  return [...grouped.entries()].map(([stage, reasons]) => `${stage} (${reasons.join('; ')})`).join(', ');
}

/**
 * One grep-able summary line, stage-named per KTD4 — what a human (or the E3
 * refinery gate) reads first.
 *
 * Three shapes, one per exit code, because the word that opens the line is the
 * whole message for most readers: REGRESSION means the code broke, INFRA means the
 * check could not tell. A run that found both leads with the regression — that IS
 * the verdict — and still names the stages it could not judge, so a green-looking
 * remainder is never mistaken for a stage that passed.
 *
 * @param {Verdict} verdict @returns {string}
 */
export function summarizeVerdict(verdict) {
  if (verdict.pass) return `WORKS-CHECK PASS: ${verdict.scope ?? 'stt + tts + smart-turn'} — real backends, non-empty smoke output`;
  const regressions = verdict.failures.filter((f) => kindOf(f) === 'regression');
  const unjudged = verdict.failures.filter((f) => kindOf(f) === 'infra');
  if (regressions.length === 0) {
    return `WORKS-CHECK INFRA (budget exhausted): ${byStage(unjudged)} — no verdict about the code; re-run on an idle machine`;
  }
  const line = `WORKS-CHECK REGRESSION: ${byStage(regressions)}`;
  return unjudged.length === 0 ? line : `${line} · NOT JUDGED (budget exhausted): ${byStage(unjudged)}`;
}
