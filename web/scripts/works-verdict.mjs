// Verdict half of the works-check (su-ljrb.6) — pure report → classification.
//
// The probe page (src/probe.ts) reports FACTS (modes, texts, sample counts); this
// module decides what they MEAN, per the plan's requirements: each stage must
// report its REAL backend, not a stub (origin R2 for STT, R3 for TTS), and each
// must survive a smoke-run with non-empty output — liveness, not accuracy (R4).
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
//         server, browser, fixture, provisioning); retryable, not a code verdict
// Any other code (an uncaught crash's 1, a signal death) also reads as infra —
// only 0 and 100 are ever a verdict about the code under check.

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

/**
 * @typedef {{ stage: 'stt' | 'tts', reason: string }} Failure
 * @typedef {{ pass: boolean, failures: Failure[] }} Verdict
 */

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
    if (!REAL_STT_MODES.has(stt.loadMode)) {
      failures.push({ stage: 'stt', reason: `loaded mode '${stt.loadMode}' is not a real STT backend (R2)` });
    }
    if (!stt.smoke) {
      failures.push({ stage: 'stt', reason: 'smoke-run never produced a transcription result' });
    } else {
      if (!REAL_STT_MODES.has(stt.smoke.mode)) {
        failures.push({ stage: 'stt', reason: `smoke-run degraded to '${stt.smoke.mode}' (R4)` });
      } else if (typeof stt.smoke.text !== 'string' || stt.smoke.text.trim() === '') {
        failures.push({ stage: 'stt', reason: 'smoke-run transcript is empty on the speech fixture (R4)' });
      }
    }
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
    if (tts.loadMode !== REAL_TTS_MODE) {
      failures.push({ stage: 'tts', reason: `loaded mode '${tts.loadMode}' is not the real wasm backend (R3)${diag}` });
    }
    if (!tts.smoke) {
      failures.push({ stage: 'tts', reason: 'smoke-run never produced a synthesis result' });
    } else {
      if (tts.smoke.mode !== REAL_TTS_MODE) {
        // The load can go green while synthesis still degrades per call — the
        // spike proved this exact false-green (partial mms-tts fix loads, then
        // falls to the placeholder tone), which is why the smoke-run is asserted
        // separately from the load mode.
        failures.push({ stage: 'tts', reason: `smoke-run degraded to '${tts.smoke.mode}' (R4)${diag}` });
      } else if (!(tts.smoke.samples > 0) || !(tts.smoke.sampleRate > 0)) {
        failures.push({ stage: 'tts', reason: `smoke-run returned no audio (samples=${tts.smoke.samples}, rate=${tts.smoke.sampleRate}) (R4)` });
      } else if (!(tts.smoke.rms > 0)) {
        failures.push({ stage: 'tts', reason: 'smoke-run audio is all-zero silence (R4)' });
      }
    }
  }

  return { pass: failures.length === 0, failures };
}

/** @param {Verdict} verdict @returns {number} */
export function exitCodeFor(verdict) {
  return verdict.pass ? EXIT_PASS : EXIT_REGRESSION;
}

/**
 * One grep-able summary line, stage-named per KTD4 — what a human (or the E3
 * refinery gate) reads first.
 *
 * @param {Verdict} verdict @returns {string}
 */
export function summarizeVerdict(verdict) {
  if (verdict.pass) return 'WORKS-CHECK PASS: stt + tts report real backends and non-empty smoke output';
  const byStage = new Map();
  for (const f of verdict.failures) {
    if (!byStage.has(f.stage)) byStage.set(f.stage, []);
    byStage.get(f.stage).push(f.reason);
  }
  const parts = [...byStage.entries()].map(([stage, reasons]) => `${stage} (${reasons.join('; ')})`);
  return `WORKS-CHECK REGRESSION: ${parts.join(', ')}`;
}
