// Main-thread occupancy — does a stage BLOCK the thread the UI runs on?
//
// A latency number says how long the operator waits. It says nothing about whether
// the page was frozen while they waited, and those are different defects with
// different fixes: 270ms of waiting is a tuning question, 270ms of frozen UI on
// every pause is jank the operator feels as the app stuttering, and no amount of
// knob-tuning removes it — only moving the work off the thread does.
//
// smart-turn's verdict is the live instance of that question (su-lou.10.5). Its
// ~270ms warm cost is comfortable inside a 2000ms floor and a real constraint on a
// 500ms one — but ONLY if it is off-thread. The code shape suggests an answer
// (vad.ts awaits `smartTurn.predict()`, whose ORT session is created with
// `executionProviders:['wasm']` and no `env.wasm.proxy`), and a suggestion is not
// evidence. This module measures it.
//
// HOW: a heartbeat. Reschedule a short timer in a chain and record when each
// callback actually runs. Timers only fire between tasks, so a task that occupies
// the thread for N ms shows up as an N-ms hole in the heartbeat — no cooperation
// needed from the code under test, and it works identically for a synchronous
// block, a wasm call, and a JS hot loop. Where the browser exposes them, Long Tasks
// entries are collected too, as a second, independent witness with the browser's
// own attribution.
//
// A chain of `setTimeout`, not `setInterval`: a blocked `setInterval` coalesces its
// missed firings and then resumes on the original phase, which paints over exactly
// the hole we are trying to see. Each callback in a chain schedules the next only
// once it has run, so a stall moves every later tick and cannot be hidden.
//
// PURE-ISH: timers and a clock, no DOM and no knowledge of what it is measuring —
// so the same monitor wraps the EOU verdict in the probe page and a deliberate
// busy-loop in the unit test that proves the instrument can see blocking at all.

/** One Long Tasks entry, as the browser attributed it. */
export interface LongTaskRecord {
  /** `performance.now()` at the task's start. */
  startMs: number;
  /** How long the task held the thread. */
  durationMs: number;
}

export interface OccupancyReport {
  /** Wall-clock span observed, start of monitoring → `stop()`. */
  windowMs: number;
  /** Requested heartbeat cadence — the resolution of the measurement. */
  intervalMs: number;
  /** Heartbeat callbacks actually delivered inside the window. */
  ticks: number;
  /**
   * THE HEADLINE NUMBER: the longest the thread went without running our heartbeat.
   * At/near `intervalMs` the thread stayed free; near the stage's own duration the
   * stage held it for that whole time.
   */
  maxGapMs: number;
  /** Median gap — the cadence when nothing is blocking, for contrast with the max. */
  medianGapMs: number;
  /**
   * Total time charged as blocked: the part of every gap beyond `STALL_FLOOR_MS`.
   * A gap a little over the cadence is ordinary timer slop on a busy machine, not a
   * stall, so only the excess past the Long Tasks threshold counts.
   */
  blockedMs: number;
  /** Long Tasks the browser attributed to this thread during the window. */
  longTasks: LongTaskRecord[];
  /** False where `longtask` is not observable (Node, non-Chromium) — then the
   *  heartbeat is the only witness, which is why it is measured independently. */
  longTasksObservable: boolean;
}

export interface MainThreadMonitor {
  /** Stop monitoring and return what was observed. Idempotent. */
  stop(): OccupancyReport;
}

export interface MonitorOptions {
  /** Heartbeat cadence in ms (default 8 — well under the 50ms stall floor). */
  intervalMs?: number;
  /** Clock, injectable for tests. Defaults to `performance.now()`. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 8;

/**
 * Gap length at/below which a late tick is scheduling slop rather than a stall.
 *
 * 50ms is the Long Tasks threshold — the point at which browsers themselves call a
 * task long — so `blockedMs` and the `longTasks` witness are charged off the same
 * definition instead of an invented one.
 */
export const STALL_FLOOR_MS = 50;

/**
 * Start watching the current thread. Call `stop()` around the work under test:
 *
 *   const mon = startMainThreadMonitor();
 *   await stage.doSomething();
 *   const occupancy = mon.stop();
 */
export function startMainThreadMonitor(opts: MonitorOptions = {}): MainThreadMonitor {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? (() => performance.now());

  // Every entry is a moment the thread was demonstrably running ours: the start,
  // each heartbeat, and `stop()` itself.
  const marks: number[] = [now()];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    marks.push(now());
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);

  const longTasks: LongTaskRecord[] = [];
  let observer: PerformanceObserver | null = null;
  let longTasksObservable = false;
  const collect = (entries: ArrayLike<{ startTime: number; duration: number }>): void => {
    for (let i = 0; i < entries.length; i++) {
      longTasks.push({ startMs: entries[i].startTime, durationMs: entries[i].duration });
    }
  };
  try {
    const Observer = globalThis.PerformanceObserver as (typeof PerformanceObserver & { supportedEntryTypes?: string[] }) | undefined;
    if (Observer?.supportedEntryTypes?.includes('longtask')) {
      observer = new Observer((list) => collect(list.getEntries()));
      observer.observe({ entryTypes: ['longtask'] });
      longTasksObservable = true;
    }
  } catch {
    // A runtime that has the constructor but rejects the type: fall back to the
    // heartbeat alone rather than failing the measurement.
    observer = null;
    longTasksObservable = false;
  }

  let report: OccupancyReport | null = null;

  return {
    stop(): OccupancyReport {
      if (report) return report;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      // `stop()` is itself proof the thread is running us now, and it is usually the
      // FIRST such proof after a block: an awaited stage resolves into a microtask,
      // and microtasks run ahead of timers, so the heartbeat has not necessarily
      // ticked yet. Without this mark the final stall — the one we came to measure —
      // would be missing from the record entirely.
      marks.push(now());
      try {
        // The observer callback is a task of its own, so a stall's own entry can
        // still be queued at this instant. Drain before disconnecting.
        collect(observer?.takeRecords() ?? []);
      } catch {
        /* nothing buffered / already gone */
      }
      observer?.disconnect();

      const gaps: number[] = [];
      for (let i = 1; i < marks.length; i++) gaps.push(marks[i] - marks[i - 1]);

      report = {
        windowMs: marks[marks.length - 1] - marks[0],
        intervalMs,
        ticks: Math.max(0, marks.length - 2), // minus the start mark and the stop mark
        maxGapMs: gaps.length ? Math.max(...gaps) : 0,
        medianGapMs: median(gaps),
        blockedMs: gaps.reduce((sum, g) => sum + Math.max(0, g - STALL_FLOOR_MS), 0),
        longTasks,
        longTasksObservable,
      };
      return report;
    },
  };
}

/** Run `fn` with the thread under observation. Returns its value and the occupancy. */
export async function measureOccupancy<T>(
  fn: () => Promise<T>,
  opts: MonitorOptions = {},
): Promise<{ value: T; occupancy: OccupancyReport }> {
  const monitor = startMainThreadMonitor(opts);
  try {
    const value = await fn();
    return { value, occupancy: monitor.stop() };
  } catch (e) {
    monitor.stop();
    throw e;
  }
}

/** Observe an idle window of `ms` — the monitor's noise floor on THIS machine. */
export async function measureIdle(ms: number, opts: MonitorOptions = {}): Promise<OccupancyReport> {
  const { occupancy } = await measureOccupancy(() => new Promise<void>((r) => setTimeout(r, ms)), opts);
  return occupancy;
}

/**
 * Observe a deliberate `ms` block — the POSITIVE CONTROL. Without it, a quiet
 * `maxGapMs` is ambiguous: it could mean the stage is off-thread, or that the
 * monitor cannot see blocking in this context at all. Sitting next to a control
 * that DID show up, a quiet measurement means what it says.
 */
export async function measureBusyControl(ms: number, opts: MonitorOptions = {}): Promise<OccupancyReport> {
  const now = opts.now ?? (() => performance.now());
  const { occupancy } = await measureOccupancy(async () => {
    const until = now() + ms;
    // Deliberately synchronous: this must hold the thread, not await it away.
    while (now() < until) {
      /* spin */
    }
  }, opts);
  return occupancy;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
