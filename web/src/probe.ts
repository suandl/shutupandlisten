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
//
// The LISTENER stage (su-lou.9) is split in two because its halves cost four orders
// of magnitude apart: a per-rung weight-availability check that always runs, and an
// opt-in load+generate. See runListenerAssets / loadListener for why each is shaped
// that way. Denoise stays unguarded here, deliberately: it is an AudioWorklet over a
// live mic MediaStream (no mic, no Web Audio graph, headless).

import {
  INLINE_WEIGHTS_MIN_BYTES,
  LISTENER_CANDIDATES,
  listenerCandidateLabel,
  listenerExternalWeightFile,
  listenerWeightFile,
} from './listener-backends.ts';
import { resolveListenerOptions } from './listener-config.ts';
import { resolveSttOptions } from './stt-config.ts';
import { resolveTtsOptions } from './tts-config.ts';
import { resolveSmartTurnOptions } from './smart-turn-config.ts';
import { createListener } from './listener.ts';
import { createTranscriber } from './stt.ts';
import { createSpeaker } from './tts.ts';
import { createSmartTurn } from './smart-turn.ts';
import {
  measureBusyControl,
  measureIdle,
  measureOccupancy,
  type OccupancyReport,
} from './main-thread-occupancy.ts';

/** PCM fixture handed in by the driver (decoded from web/test/fixtures/*.wav). */
export interface ProbeFixture {
  samples: number[];
  sampleRate: number;
}

/** What `run` is asked to do. The listener's deep check is opt-in — see loadListener. */
export interface ProbeOptions {
  /** Load the listener model and generate, not just check its weights are served. */
  withListener?: boolean;
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
  /**
   * MAIN-THREAD OCCUPANCY of the warm verdict (su-lou.10.5) — the question the
   * latency numbers above cannot answer. ~270ms of waiting is a tuning question;
   * ~270ms of FROZEN PAGE on every pause is jank the operator feels, and no floor
   * value fixes it. Null when the smoke-run never ran.
   *
   * Three readings, because one alone proves nothing:
   *   `idle`   — an equally long window with the thread free. The noise floor of
   *              this machine and this page.
   *   `busy`   — a deliberate `busyMs` synchronous block. Proves the instrument can
   *              see blocking HERE, so a quiet `predictRuns` means off-thread rather
   *              than blind.
   *   `predictRuns` — the real measurement, one entry per warm `smartTurn.predict()`.
   *              Several, not one: this number is the pivot for how far the silence
   *              floor can drop, and a single sample on a shared box is not evidence.
   *              Each entry's `windowMs` IS that call's wall time, so duration and
   *              occupancy are read off the same record and cannot disagree.
   *
   * Reported, never gated — same rule as the latency numbers: this is evidence for
   * a design decision, and a slow or contended CI box is not a regression.
   */
  occupancy: {
    idle: OccupancyReport;
    busy: OccupancyReport;
    /** Length of the deliberate block in the `busy` control. */
    busyMs: number;
    predictRuns: OccupancyReport[];
  } | null;
  error: string | null;
}

/** One rung's weight file, as the SERVER answers for it. */
export interface ListenerAssetReport {
  /** The rung that needs it — `webgpu/q4f16`. */
  rung: string;
  /** Same-origin URL the engine would resolve for that rung's weights. */
  url: string;
  status: number;
  /** Response content-type, so an SPA-fallback `text/html` names itself (su-lou.7). */
  contentType: string;
  bytes: number | null;
  /** A fetch that never got a response at all (offline, CORS, aborted). */
  error: string | null;
}

export interface ListenerStageReport {
  /** Adapter mode after init: 'webgpu' | 'wasm' | 'stub'; null when not loaded. */
  loadMode: string | null;
  /** Weight variant of the live rung ('q4f16' | 'q4'), null in stub mode. */
  dtype: string | null;
  loadMs: number;
  /** The adapter's onDiagnostic lines — names WHY the listener degraded (su-lou.9). */
  diagnostics: string[];
  /** Result of generating a reply; null when the smoke-run never ran. */
  smoke: { mode: string; text: string; ms: number } | null;
  /** Per-rung weight availability. Checked ALWAYS — it is the only assertion that
   *  covers a rung this browser cannot load (see runListenerAssets). */
  assets: ListenerAssetReport[];
  /** False when the deep load+generate half was not requested. */
  loaded: boolean;
  /** Whether the page got SharedArrayBuffer — i.e. whether ORT could thread its WASM
   *  backend. Reported, never judged: it is the difference between a 52s load and a
   *  228s one, so a load time is unreadable without it. */
  crossOriginIsolated: boolean;
  error: string | null;
}

export interface ProbeReport {
  version: 1;
  stt: SttStageReport;
  tts: TtsStageReport;
  smartTurn: SmartTurnStageReport;
  listener: ListenerStageReport;
}

/** What the TTS smoke-run speaks. Content is irrelevant — liveness, not accuracy. */
export const TTS_SMOKE_TEXT = 'The works check confirms the voice pipeline is alive.';

/** What the listener smoke-run is asked. Short and concrete: the gate reads the
 *  reply for LIVENESS (real words came back), never for quality. */
export const LISTENER_SMOKE_TURN = 'I have been turning the same problem over all week and I am tired of it.';

/** Tokens the smoke-run asks for. Small ON PURPOSE: this decides only whether real
 *  language comes back, and every token costs ~2.5s on the single-threaded WASM rung
 *  the gate lands on (see LISTENER_INIT_TIMEOUT_MS). A 48-token smoke blew a 120s
 *  budget and reported a stub for a listener that had loaded perfectly well. */
const LISTENER_SMOKE_TOKENS = 16;

/** The listener model load is far heavier than STT/TTS (1.09-1.69G of weights) and
 *  the gate's page is not cross-origin isolated, so ORT runs the WASM backend
 *  single-threaded: 228s to load, measured. These budgets are sized from that
 *  measurement so a SLOW load reads as slow, not as a broken stage — the adapter's
 *  own defaults are tuned for the app, not for this. */
const LISTENER_INIT_TIMEOUT_MS = 420000;
const LISTENER_GENERATE_TIMEOUT_MS = 240000;

/** Idle window for the occupancy noise floor — a little longer than a warm verdict
 *  (~270ms measured), so the control and the measurement span comparable spans. */
const OCCUPANCY_IDLE_MS = 300;
/** The deliberate block in the positive control. Long enough to be unmistakable
 *  against timer slop, short enough to be free next to a 21MB model load. */
const OCCUPANCY_BUSY_MS = 150;
/** Warm verdicts measured. Enough to see the spread on a shared box — the floor
 *  arithmetic turns on this number — without adding seconds to the gate. */
const OCCUPANCY_WARM_RUNS = 3;

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
  const report: SmartTurnStageReport = {
    loadMode: 'heuristic',
    loadMs: 0,
    diagnostics: [],
    smoke: null,
    occupancy: null,
    error: null,
  };
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

      // The controls run BETWEEN the cold and warm verdicts, not before the load:
      // the idle floor has to be measured with the page in the state the real
      // measurement will see it in (session created, wasm heap resident), or it
      // would be a noise floor for a different page.
      const idle = await measureIdle(OCCUPANCY_IDLE_MS);
      const busy = await measureBusyControl(OCCUPANCY_BUSY_MS);

      const predictRuns: OccupancyReport[] = [];
      for (let i = 0; i < OCCUPANCY_WARM_RUNS; i++) {
        const { occupancy } = await measureOccupancy(() => smartTurn.predict(samples, fixture.sampleRate));
        predictRuns.push(occupancy);
      }
      report.smoke = {
        mode: result.mode,
        completionProb: Number(result.completionProb.toFixed(4)),
        ms,
        // The first warm run's own window — the same number the previous shape
        // reported, now read off the measured record instead of a second clock.
        warmMs: Math.round(predictRuns[0].windowMs),
      };
      report.occupancy = { idle, busy, busyMs: OCCUPANCY_BUSY_MS, predictRuns };
    } finally {
      smartTurn.close();
    }
  } catch (e) {
    report.error = errText(e);
  }
  return report;
}

/**
 * Ask the SERVER for each rung's weight file, without downloading it.
 *
 * This is the half of the listener check that runs on EVERY works-check, and the
 * only assertion that covers a rung this browser cannot execute: the gate runs
 * headless with no WebGPU adapter, so it can never load the `webgpu/q4f16` rung the
 * operator actually uses — but it can still prove those weights are served. A
 * provisioner that stops shipping a variant, or a rung that starts asking for one
 * nobody ships, is exactly the drift su-lou.9 was filed about (and, wrongly, was
 * believed to be). It is also where su-lou.7's SPA fallback would resurface: a
 * `200 text/html` for a missing model file, which transformers.js JSON.parse()s and
 * dies on, so the content-type is reported and checked, not just the status.
 *
 * HEAD, not GET: the answer is in the status line and headers, and a GET here would
 * pull 1.09-1.69G per rung. The provisionedAsset404 guard handles HEAD (it accepts
 * GET and HEAD alike), so a missing file answers a real 404.
 */
async function runListenerAssets(engineUrl: string | undefined, model: string | undefined): Promise<ListenerAssetReport[]> {
  const out: ListenerAssetReport[] = [];
  if (!engineUrl || !model) return out;
  // Mirror how public/llm-engine.js resolves weights: `./models/` RELATIVE TO THE
  // ENGINE MODULE, so a `?llmEngine=` override is checked where it really looks.
  const modelsBase = new URL('./models/', new URL(engineUrl, location.href));
  const head = async (rel: string, rung: string): Promise<ListenerAssetReport> => {
    const url = new URL(`${model}/${rel}`, modelsBase).href;
    const entry: ListenerAssetReport = {
      rung,
      url: new URL(url).pathname,
      status: 0,
      contentType: '',
      bytes: null,
      error: null,
    };
    try {
      const res = await fetch(url, { method: 'HEAD' });
      entry.status = res.status;
      entry.contentType = res.headers.get('content-type') ?? '';
      const len = res.headers.get('content-length');
      entry.bytes = len === null ? null : Number(len);
    } catch (e) {
      entry.error = errText(e);
    }
    return entry;
  };

  for (const c of LISTENER_CANDIDATES) {
    const rung = listenerCandidateLabel(c);
    const graph = await head(listenerWeightFile(c.dtype), rung);
    out.push(graph);
    // The `.onnx` above is the GRAPH; for a model this size the weights are all in
    // the `_data` sibling. Only demand it when the graph is too small to hold them
    // — a smaller model swapped in via `?llmModel=` keeps its weights inline and
    // ships no sibling at all (see INLINE_WEIGHTS_MIN_BYTES).
    const inlineWeights = graph.bytes !== null && graph.bytes >= INLINE_WEIGHTS_MIN_BYTES;
    if (graph.status === 200 && !inlineWeights) {
      out.push(await head(listenerExternalWeightFile(c.dtype), `${rung} weights`));
    }
  }
  return out;
}

/**
 * The deep half: load the real listener model and generate a reply.
 *
 * OPT-IN (`works-check --with-listener`), because it is the one stage whose cost is
 * out of scale with the rest — 1.69G of weights onto the WASM heap for ~50s+ on a
 * warm host, every run, to exercise the fallback rung rather than the operator's GPU
 * one. Making it default-on is how a gate becomes the thing everyone skips; making
 * it unavailable is how a stage stays unguarded. So the cheap contract check above
 * always runs, this runs when asked, and works-check.mjs prints loudly which of the
 * two it did (a silently-skipped check reads as a passed one).
 */
async function baseListenerReport(): Promise<ListenerStageReport> {
  const opts = resolveListenerOptions(location.search, location.href);
  const report: ListenerStageReport = {
    loadMode: null,
    dtype: null,
    loadMs: 0,
    diagnostics: [],
    smoke: null,
    assets: await runListenerAssets(opts.engineUrl, opts.model),
    loaded: false,
    crossOriginIsolated: Boolean(self.crossOriginIsolated),
    error: null,
  };
  return report;
}

async function loadListener(report: ListenerStageReport): Promise<ListenerStageReport> {
  const opts = resolveListenerOptions(location.search, location.href);
  report.loaded = true;
  try {
    const t0 = performance.now();
    const listener = await createListener({
      ...opts,
      initTimeoutMs: LISTENER_INIT_TIMEOUT_MS,
      timeoutMs: LISTENER_GENERATE_TIMEOUT_MS,
      onDiagnostic: (m) => report.diagnostics.push(m),
    });
    report.loadMode = listener.mode;
    report.dtype = listener.dtype ?? null;
    report.loadMs = Math.round(performance.now() - t0);
    try {
      const t1 = performance.now();
      const result = await listener.respond({
        messages: [{ role: 'user', content: LISTENER_SMOKE_TURN }],
        tier: 'reflection',
        maxNewTokens: LISTENER_SMOKE_TOKENS,
      });
      report.smoke = { mode: result.mode, text: result.text, ms: Math.round(performance.now() - t1) };
    } finally {
      listener.close();
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
async function run(fixture: ProbeFixture, options: ProbeOptions = {}): Promise<ProbeReport> {
  const listener = await baseListenerReport();
  const report: ProbeReport = {
    version: 1,
    stt: await runStt(fixture),
    tts: await runTts(),
    smartTurn: await runSmartTurn(fixture),
    // Loaded LAST: it is by far the largest heap allocation of the run, so leaving
    // it until stt, tts and smart-turn have closed their sessions keeps it from
    // crowding them.
    listener: options.withListener ? await loadListener(listener) : listener,
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
    __worksCheck: { version: 1; run: (fixture: ProbeFixture, options?: ProbeOptions) => Promise<ProbeReport> };
  }
}

window.__worksCheck = { version: 1, run };
document.getElementById('probe-log')!.textContent = 'probe ready — waiting for the driver.';
