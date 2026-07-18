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
import { createTranscriber } from './stt.ts';
import { createSpeaker } from './tts.ts';

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

export interface ProbeReport {
  version: 1;
  stt: SttStageReport;
  tts: TtsStageReport;
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
 * Run both stages sequentially (they share the CPU/WASM budget — parallel loads
 * would contend and distort the load-time numbers the report carries).
 */
async function run(fixture: ProbeFixture): Promise<ProbeReport> {
  const report: ProbeReport = {
    version: 1,
    stt: await runStt(fixture),
    tts: await runTts(),
  };
  // Mirror for humans: a headed/`--keep` inspection can read the page, and the
  // console line survives in driver-captured browser logs.
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
