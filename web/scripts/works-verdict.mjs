// Verdict half of the works-check (su-ljrb.6) — pure report → classification.
//
// The probe page (src/probe.ts) reports FACTS (modes, texts, sample counts); this
// module decides what they MEAN, per the plan's requirements: each stage must
// report its REAL backend, not a stub (origin R2 for STT, R3 for TTS, and the
// LISTENER since su-lou.9), and each must survive a smoke-run with non-empty
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
 * @typedef {{ stage: 'stt' | 'tts' | 'listener', reason: string }} Failure
 * @typedef {{ pass: boolean, failures: Failure[], scope: string }} Verdict
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

  evaluateListener(report?.listener, failures);

  // What the run actually covered, so a PASS can never overclaim. The listener's
  // deep half is opt-in, and "we did not load the model" must be visible in the one
  // line most people read — a skipped check that prints like a passed one is the
  // failure mode this whole gate exists to prevent.
  const scope = report?.listener?.loaded
    ? 'stt + tts + listener'
    : 'stt + tts + listener weights (model not loaded — pass --with-listener)';

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
  if (!REAL_LISTENER_MODES.has(listener.loadMode)) {
    failures.push({ stage: 'listener', reason: `loaded mode '${listener.loadMode}' is not a real LLM backend (R2)${diag}` });
  }
  if (!listener.smoke) {
    failures.push({ stage: 'listener', reason: 'smoke-run never produced a reply' });
    return;
  }
  if (!REAL_LISTENER_MODES.has(listener.smoke.mode)) {
    failures.push({ stage: 'listener', reason: `smoke-run degraded to '${listener.smoke.mode}' (R4)${diag}` });
  } else if (isDegenerateText(listener.smoke.text)) {
    failures.push({
      stage: 'listener',
      reason: `smoke-run reply is not language: ${JSON.stringify(String(listener.smoke.text ?? '').slice(0, 40))} (R4)${diag}`,
    });
  }
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
  if (verdict.pass) return `WORKS-CHECK PASS: ${verdict.scope ?? 'stt + tts'} — real backends, non-empty smoke output`;
  const byStage = new Map();
  for (const f of verdict.failures) {
    if (!byStage.has(f.stage)) byStage.set(f.stage, []);
    byStage.get(f.stage).push(f.reason);
  }
  const parts = [...byStage.entries()].map(([stage, reasons]) => `${stage} (${reasons.join('; ')})`);
  return `WORKS-CHECK REGRESSION: ${parts.join(', ')}`;
}
