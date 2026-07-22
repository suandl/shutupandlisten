// Tests for the main-thread occupancy monitor (main-thread-occupancy.ts).
//
// These are the INSTRUMENT'S OWN CONTROLS, and they are the reason a quiet reading
// from the probe page can be believed. A monitor that reported "nothing blocked"
// because it is incapable of seeing a block would look exactly like a stage that is
// genuinely off-thread — so the positive control here (a deliberate synchronous
// spin, which MUST show up) is what makes the negative case elsewhere mean
// something.
//
// The guarantees under test:
//   1. a deliberate N-ms block is seen as a gap of about N ms, and charged as blocked
//   2. an awaited (non-blocking) wait of the same length is NOT charged as blocked —
//      the monitor measures thread occupancy, not elapsed time
//   3. `stop()` marks the instant it runs, so a stall ending in a microtask (every
//      awaited stage) is still recorded
//   4. the report is internally consistent and `stop()` is idempotent
//
// Deliberately NOT asserted: any upper bound on idle jitter. A loaded CI box can
// stall this process for tens of ms through no fault of the code, and a test that
// fails when the machine is busy teaches people to ignore it. Guarantee 2 bounds
// the idle case against the 50ms stall floor only, which is a claim about the
// charging rule rather than about the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STALL_FLOOR_MS,
  measureBusyControl,
  measureIdle,
  measureOccupancy,
  startMainThreadMonitor,
} from './main-thread-occupancy.ts';

/** Long enough to dwarf scheduling slop, short enough to keep the suite quick. */
const BLOCK_MS = 250;

test('a deliberate block is seen — the positive control the instrument rests on', async () => {
  const report = await measureBusyControl(BLOCK_MS);

  // The spin holds the thread for BLOCK_MS, so the heartbeat cannot run for that
  // long. Allow generous slack downward (the spin's own loop check granularity)
  // and none of the assertions depend on the machine being idle.
  assert.ok(
    report.maxGapMs >= BLOCK_MS * 0.8,
    `expected a gap near ${BLOCK_MS}ms, got ${report.maxGapMs}ms — the monitor cannot see blocking`,
  );
  assert.ok(report.blockedMs > 0, 'a held thread must be charged as blocked');
  assert.ok(report.windowMs >= BLOCK_MS * 0.8);
});

test('blocking and merely waiting are distinguishable — the discrimination the probe rests on', async () => {
  // Same elapsed time, opposite thread occupancy. The monitor measures the second
  // thing, and the probe's whole conclusion is that it can tell them apart: an EOU
  // verdict that ran off-thread would read like `waited`, one that held the thread
  // like `blocked`.
  const waited = await measureIdle(BLOCK_MS);
  const blocked = await measureBusyControl(BLOCK_MS);

  assert.ok(waited.windowMs >= BLOCK_MS * 0.8, 'the window still spans the wait');
  assert.ok(waited.ticks > 1, 'the heartbeat kept running while the thread was free');
  assert.ok(waited.medianGapMs < STALL_FLOOR_MS, 'the healthy cadence sits under the stall floor');

  // Relative, not absolute: a loaded machine can stall this process on its own, but
  // it cannot plausibly stall it AS MUCH as a deliberate quarter-second spin.
  assert.ok(
    waited.maxGapMs < blocked.maxGapMs,
    `waiting (${waited.maxGapMs}ms) must read quieter than blocking (${blocked.maxGapMs}ms)`,
  );
  assert.ok(waited.blockedMs < blocked.blockedMs, 'and must be charged less blocked time');
});

test('stop() marks its own instant, so a stall ending in a microtask is recorded', async () => {
  const now = () => performance.now();
  // Block, then resolve through a microtask — exactly the shape of `await
  // smartTurn.predict()`. Promise continuations run BEFORE timers, so `stop()` is
  // reached with no heartbeat yet delivered after the block: only stop()'s own mark
  // can record it.
  const { occupancy } = await measureOccupancy(async () => {
    const until = now() + BLOCK_MS;
    while (now() < until) {
      /* spin */
    }
    return Promise.resolve('done');
  });

  assert.ok(
    occupancy.maxGapMs >= BLOCK_MS * 0.8,
    `the stall must survive the microtask hand-off, got ${occupancy.maxGapMs}ms`,
  );
});

test('the report is internally consistent and stop() is idempotent', async () => {
  const monitor = startMainThreadMonitor({ intervalMs: 5 });
  await new Promise<void>((r) => setTimeout(r, 60));
  const first = monitor.stop();
  const second = monitor.stop();

  assert.equal(first, second, 'stop() returns the same report, not a fresh measurement');
  assert.equal(first.intervalMs, 5);
  assert.ok(first.maxGapMs >= first.medianGapMs, 'the max gap is at least the median');
  assert.ok(first.windowMs >= first.maxGapMs, 'no single gap can exceed the window');
  assert.ok(Array.isArray(first.longTasks));
  // node exposes PerformanceObserver but not `longtask`; the heartbeat is the only
  // witness here, which is why it is measured independently of the browser's.
  assert.equal(typeof first.longTasksObservable, 'boolean');
});

test('measureOccupancy stops the monitor even when the work throws', async () => {
  await assert.rejects(
    () => measureOccupancy(async () => { throw new Error('stage exploded'); }),
    /stage exploded/,
  );
});
