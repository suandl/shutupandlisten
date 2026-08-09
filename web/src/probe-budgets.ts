// Time budgets the works-check grants each adapter half (su-ucww).
//
// Shared by the two halves of the gate that have to agree about them:
//   src/probe.ts             hands them to the adapters and ECHOES them into the
//                            report, so the verdict can compare what a half spent
//                            against what it was allowed
//   scripts/works-check.mjs  sizes its outer watchdogs ABOVE their sum, so a
//                            stage's own budget always fires first — a wedged
//                            stage must name itself, never die as the watchdog's
//                            unclassifiable "the probe run did not complete"
//
// ── WHY THE GATE OVERRIDES THE APP'S BUDGETS ─────────────────────────────────
//
// Every adapter degrades to a labelled fallback when its budget runs out — that IS
// the contract — and the app's budgets are deliberately TIGHT, because a live UI
// must never block on a model download (stt.ts: "the harness never blocks on a
// model download"). A gate has the opposite requirement: it can afford to wait,
// and the one thing it must not do is call a slow box a broken stage.
//
// su-ucww is that failure, measured. On a box at load average 72 the STT init
// spent its whole 15s app budget and the TTS smoke-run its whole 30s; both
// adapters degraded exactly as designed; the gate called it REGRESSION. It called
// it on the branch under test AND on origin/main, byte-identically (15001ms vs
// 15006ms), so the run discriminated nothing at all — it reported the machine's
// state as a verdict about the code.
//
// The listener already had gate-sized budgets for exactly this reason ("the
// adapter's own defaults are tuned for the app, not for this"). This module is
// that decision, applied to every stage and written down once.
//
// ── SIZING ───────────────────────────────────────────────────────────────────
//
// Against the uncontended measurements for this host class in
// docs/findings/reply-latency-baseline.md (8-core headless Chromium, WASM
// single-threaded because `vite preview` sends no COOP/COEP):
//
//   half                measured     budget   headroom
//   stt load             8,113ms     90,000ms    11x
//   stt transcribe         638ms     90,000ms     —    (stt.ts has ONE knob — see below)
//   tts load             9,558ms    120,000ms    12x
//   tts synthesize      15,231ms    150,000ms    10x
//   eou load             1,446ms     60,000ms    41x
//   eou predict            244ms     20,000ms    82x
//   listener load      156,606ms    420,000ms     2.7x
//   listener generate   43,347ms    240,000ms     5.5x
//
// The two arms su-ucww watched blow are precisely the two the app left under 2x
// headroom over those numbers (15s over an 8.1s load, 30s over a 15.2s synthesis).
// The ~9x CPU oversubscription of a load-72 box on 8 cores eats 2x instantly and
// does not reach 10x, which is where these sit.
//
// A budget that runs out ANYWAY is still not a verdict about the code:
// works-verdict.mjs classifies budget exhaustion as INFRA (exit 2, retryable),
// never as a regression. Generous budgets and honest classification are two halves
// of one fix — the budgets are what let the gate answer on a busy box, the
// classification is what keeps it from lying when it cannot.

/**
 * STT, both halves. stt.ts exposes a SINGLE `timeoutMs` covering the init
 * handshake and each `transcribe()` call, so one number is both budgets — sized
 * for the load, which is the expensive half by an order of magnitude.
 */
export const STT_TIMEOUT_MS = 90_000;

/** TTS init handshake (`initTimeoutMs`) — the worker's engine import + model load. */
export const TTS_INIT_TIMEOUT_MS = 120_000;
/** TTS per-`synthesize()` budget. The smoke sentence is ~4.3s of audio and this
 *  rung runs ~3.6x slower than realtime, so the CALL is the costly half here. */
export const TTS_SYNTHESIZE_TIMEOUT_MS = 150_000;

/**
 * Smart-turn's load-side warmup (`initTimeoutMs`): the worker's first inference,
 * which compiles and specializes the graph.
 *
 * The EARLIER of the stage's two load-side budgets, and therefore the one the
 * report carries as `budgets.initMs`: whichever of the two fires, the load has by
 * then spent at least this long, and the verdict's test is `>=`.
 */
export const SMART_TURN_INIT_TIMEOUT_MS = 60_000;
/** Backstop for a smart-turn worker that never answers `init` at all
 *  (`loadTimeoutMs`). Above the warmup budget on purpose — set at or below it and
 *  it would preempt the warmup, which is the whole reason the adapter splits the two. */
export const SMART_TURN_LOAD_TIMEOUT_MS = 90_000;
/** Smart-turn per-`predict()` budget. */
export const SMART_TURN_PREDICT_TIMEOUT_MS = 20_000;
/**
 * How many `predict()` calls the probe makes: one cold verdict plus the warm runs
 * the occupancy measurement needs. probe.ts derives its warm-run count from this
 * rather than the other way round, so the ceiling below cannot drift away from the
 * number of calls actually made.
 */
export const SMART_TURN_PREDICT_CALLS = 4;

/**
 * Listener init. The listener adds a 1.69G weight load onto the WASM heap,
 * single-threaded because the page is not cross-origin isolated — 156s measured
 * here, 228s on a slower run of the same shape (the same model loads in ~52s
 * served cross-origin-isolated). Unchanged by su-ucww: it was already gate-sized.
 */
export const LISTENER_INIT_TIMEOUT_MS = 420_000;
/** Listener generate, for the 16-token smoke reply (~2.7s per token on this rung). */
export const LISTENER_GENERATE_TIMEOUT_MS = 240_000;

/**
 * Worst case for a plain `works-check` run: every base half spending its whole
 * budget. A PATHOLOGICAL ceiling, not an expectation — a healthy run is ~25-30s —
 * and the outer watchdog is derived from it so that a stage's own budget always
 * fires first. A watchdog that preempted a stage budget would trade a verdict that
 * names a stage for one that names nothing, which is the ambiguity su-ucww exists
 * to remove.
 */
export const BASE_PROBE_BUDGET_MS =
  2 * STT_TIMEOUT_MS +
  TTS_INIT_TIMEOUT_MS +
  TTS_SYNTHESIZE_TIMEOUT_MS +
  SMART_TURN_LOAD_TIMEOUT_MS +
  SMART_TURN_PREDICT_CALLS * SMART_TURN_PREDICT_TIMEOUT_MS;

/** The same ceiling for `--with-listener`, which adds the deep half's two budgets. */
export const LISTENER_PROBE_BUDGET_MS =
  BASE_PROBE_BUDGET_MS + LISTENER_INIT_TIMEOUT_MS + LISTENER_GENERATE_TIMEOUT_MS;

/** Slack over the stage budgets for the page's own work — module evaluation, the
 *  weight-asset HEADs, the occupancy controls, teardown between stages. */
export const PROBE_WATCHDOG_SLACK_MS = 60_000;

/**
 * What the probe reports it was GRANTED for a stage, alongside what the stage
 * spent. Both numbers, in the same record, are what let works-verdict.mjs tell a
 * broken backend from a machine that ran out of time.
 */
export interface StageBudgets {
  /**
   * Earliest a LOAD-side budget can fire. Where a stage has more than one (see
   * SMART_TURN_INIT_TIMEOUT_MS) this is the smaller: the load cannot have degraded
   * on a timeout without having spent at least this long.
   */
  initMs: number;
  /** Per smoke-call budget. */
  callMs: number;
}

export const STT_BUDGETS: StageBudgets = { initMs: STT_TIMEOUT_MS, callMs: STT_TIMEOUT_MS };
export const TTS_BUDGETS: StageBudgets = { initMs: TTS_INIT_TIMEOUT_MS, callMs: TTS_SYNTHESIZE_TIMEOUT_MS };
export const SMART_TURN_BUDGETS: StageBudgets = {
  initMs: SMART_TURN_INIT_TIMEOUT_MS,
  callMs: SMART_TURN_PREDICT_TIMEOUT_MS,
};
export const LISTENER_BUDGETS: StageBudgets = {
  initMs: LISTENER_INIT_TIMEOUT_MS,
  callMs: LISTENER_GENERATE_TIMEOUT_MS,
};
