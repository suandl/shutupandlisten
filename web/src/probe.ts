// Page half of the works-check (su-ljrb.6) — the adapter-import probe.
//
// Imports the REAL production adapters (createTranscriber / createSpeaker) plus the
// app's OWN config resolvers, so a run exercises the exact worker-bundling,
// same-origin engine-import and wasm paths the shipped page uses — the spike
// (su-ljrb.1) picked this over DOM-scraping the app because it needs no mic, no
// LLM, and no string-parsing of UI text. The driver (scripts/works-check.mjs)
// navigates here, waits for `window.__worksCheck`, and calls `run(fixture)` with
// the committed speech fixture decoded to PCM.
//
// The probe NEVER throws out of `run`: each stage's outcome — including an adapter
// breaking its own never-throws contract — is captured in the report, so the
// driver can always classify (a page-level crash would be indistinguishable from
// infra). Verdicts live in scripts/works-verdict.mjs, not here: the page reports
// facts, the check decides.

import { resolveSttOptions } from './stt-config.ts';
import { resolveTtsOptions } from './tts-config.ts';
import { resolveSmartTurnOptions } from './smart-turn-config.ts';
import { createTranscriber } from './stt.ts';
import { createSpeaker } from './tts.ts';
import { createSmartTurn } from './smart-turn.ts';

/** PCM fixture handed in by the driver (decoded from web/test/fixtures/*.wav). */
export interface ProbeFixture {
  samples: number[];
  sampleRate: number;
}

export interface SttStageReport {
  /** Adapter mode after init: 'moonshine' | 'whisper' | 'stub' | 'sim'. */
  loadMode: string;
  loadMs: number;
  /** Result of transcribing the fixture; null when the smoke-run never ran. */
  smoke: { mode: string; text: string; ms: number } | null;
  /** An adapter throw (contract break) — captured, never propagated. */
  error: string | null;
}

export interface TtsStageReport {
  /** Adapter mode after init: 'webgpu' | 'wasm' | 'stub'. */
  loadMode: string;
  loadMs: number;
  /** The adapter's onDiagnostic lines — names WHY a voice degraded (su-lou.7). */
  diagnostics: string[];
  /** Result of synthesizing the smoke sentence; null when the smoke-run never ran. */
  smoke: { mode: string; samples: number; sampleRate: number; rms: number; ms: number } | null;
  error: string | null;
}

export interface SmartTurnStageReport {
  /** Adapter mode after init: 'model' | 'heuristic'. */
  loadMode: string;
  loadMs: number;
  /** The adapter's onDiagnostic lines — names WHY it fell back to the heuristic. */
  diagnostics: string[];
  /**
   * Result of classifying the fixture; null when the smoke-run never ran. `ms` is
   * the whole verdict (log-Mel front-end + inference) and `warmMs` the same again on
   * a second call — the steady-state cost a live turn actually pays, which is the
   * number su-lou.10.5 needs to decide how far the silence floor can drop. Reported,
   * never gated: a slow CI box is not a regression.
   */
  smoke: { mode: string; completionProb: number; ms: number; warmMs: number } | null;
  error: string | null;
}

export interface ProbeReport {
  version: 1;
  stt: SttStageReport;
  tts: TtsStageReport;
  smartTurn: SmartTurnStageReport;
}

/** What the TTS smoke-run speaks. Content is irrelevant — liveness, not accuracy. */
export const TTS_SMOKE_TEXT = 'The works check confirms the voice pipeline is alive.';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function rmsOf(audio: Float32Array): number {
  if (audio.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / audio.length);
}

async function runStt(fixture: ProbeFixture): Promise<SttStageReport> {
  const report: SttStageReport = { loadMode: 'stub', loadMs: 0, smoke: null, error: null };
  try {
    const t0 = performance.now();
    const transcriber = await createTranscriber(resolveSttOptions(location.search, location.href));
    report.loadMode = transcriber.mode;
    report.loadMs = Math.round(performance.now() - t0);
    try {
      const t1 = performance.now();
      const result = await transcriber.transcribe(Float32Array.from(fixture.samples), fixture.sampleRate);
      report.smoke = { mode: result.mode, text: result.text, ms: Math.round(performance.now() - t1) };
    } finally {
      transcriber.close();
    }
  } catch (e) {
    report.error = errText(e);
  }
  return report;
}

async function runTts(): Promise<TtsStageReport> {
  const report: TtsStageReport = { loadMode: 'stub', loadMs: 0, diagnostics: [], smoke: null, error: null };
  try {
    const t0 = performance.now();
    const speaker = await createSpeaker({
      ...resolveTtsOptions(location.search, location.href),
      onDiagnostic: (m) => report.diagnostics.push(m),
    });
    report.loadMode = speaker.mode;
    report.loadMs = Math.round(performance.now() - t0);
    try {
      const t1 = performance.now();
      const result = await speaker.synthesize(TTS_SMOKE_TEXT);
      report.smoke = {
        mode: result.mode,
        samples: result.audio.length,
        sampleRate: result.sampleRate,
        rms: Number(rmsOf(result.audio).toFixed(4)),
        ms: Math.round(performance.now() - t1),
      };
    } finally {
      speaker.close();
    }
  } catch (e) {
    report.error = errText(e);
  }
  return report;
}

/**
 * The end-of-utterance classifier (su-lou.10.1). It is in the works-check for the
 * same reason STT and TTS are: it degrades to a labelled fallback, and until this
 * unit it had degraded on EVERY run since the file was written because nothing
 * provisioned a model. The smoke-run classifies the same speech fixture — liveness
 * (a real model produced a real probability), never a claim about WHICH verdict is
 * correct, which is a tuning question for the operator feel-test.
 */
async function runSmartTurn(fixture: ProbeFixture): Promise<SmartTurnStageReport> {
  const report: SmartTurnStageReport = { loadMode: 'heuristic', loadMs: 0, diagnostics: [], smoke: null, error: null };
  try {
    const t0 = performance.now();
    const smartTurn = await createSmartTurn({
      ...resolveSmartTurnOptions(location.search, location.href),
      onDiagnostic: (m) => report.diagnostics.push(m),
    });
    report.loadMode = smartTurn.mode;
    report.loadMs = Math.round(performance.now() - t0);
    try {
      const samples = Float32Array.from(fixture.samples);
      const t1 = performance.now();
      const result = await smartTurn.predict(samples, fixture.sampleRate);
      const ms = Math.round(performance.now() - t1);
      const t2 = performance.now();
      await smartTurn.predict(samples, fixture.sampleRate);
      report.smoke = {
        mode: result.mode,
        completionProb: Number(result.completionProb.toFixed(4)),
        ms,
        warmMs: Math.round(performance.now() - t2),
      };
    } finally {
      smartTurn.close();
    }
  } catch (e) {
    report.error = errText(e);
  }
  return report;
}

/**
 * Run the stages sequentially (they share the CPU/WASM budget — parallel loads
 * would contend and distort the load-time numbers the report carries).
 */
async function run(fixture: ProbeFixture): Promise<ProbeReport> {
  const report: ProbeReport = {
    version: 1,
    stt: await runStt(fixture),
    tts: await runTts(),
    smartTurn: await runSmartTurn(fixture),
  };
  // Mirror for humans: the page keeps the full report on screen for anyone
  // driving the probe by hand, and the console line survives in the
  // driver-captured browser logs.
  const pretty = JSON.stringify(report, null, 2);
  document.getElementById('probe-log')!.textContent = pretty;
  console.log(`WORKS_CHECK_REPORT ${JSON.stringify(report)}`);
  return report;
}

declare global {
  interface Window {
    __worksCheck: { version: 1; run: (fixture: ProbeFixture) => Promise<ProbeReport> };
  }
}

window.__worksCheck = { version: 1, run };
document.getElementById('probe-log')!.textContent = 'probe ready — waiting for the driver.';
