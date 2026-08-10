// Tests for the works-check CLI argument parser (works-check.mjs's parseArgs).
//
// parseArgs is the one half of the driver that needs no browser, no server and
// none of the 3.3G of provisioned weights the rest of it exists to exercise, so it
// is the half a node-suite test can actually hold. Same pure-halves convention as
// wav.test.mjs and works-verdict.test.mjs.
//
// It was untestable until this bead: importing works-check.mjs ran main() at module
// scope, so the import alone would have launched a full check run inside the suite.
// The driver now guards that call (`import.meta.url === pathToFileURL(argv[1])`,
// the shape provision-llm.mjs already uses) and exports parseArgs — and this file
// is the thing that keeps the guard honest. If the guard is ever removed, these
// tests do not fail politely; they hang building a vite bundle.
//
// The guarantees under test:
//   1. the defaults are the shipped ones, and the default timeout is DERIVED from
//      the probe budgets rather than hand-picked (works-check.mjs explains why the
//      watchdog must be sized above the stage budgets it wraps)
//   2. --port / --timeout round-trip the value they were given
//   3. --with-listener switches the default timeout to the listener budget
//   4. --headed / --keep are recognized and default to off
//   5. every malformed invocation THROWS rather than silently degrading — a gate
//      that quietly ran with a nonsense timeout would report an infra flake and
//      send someone hunting a bug in the app

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_PROBE_BUDGET_MS, LISTENER_PROBE_BUDGET_MS, PROBE_WATCHDOG_SLACK_MS } from '../src/probe-budgets.ts';
import { WORKS_CHECK_PORT } from './works-check.constants.mjs';
import { parseArgs } from './works-check.mjs';

/** parseArgs reads process.argv, so every case carries the two leading entries
 *  node supplies (the executable and the script path) before the real flags. */
const argv = (...flags) => ['node', 'works-check.mjs', ...flags];

test('defaults: pinned port, no listener, no debug flags, watchdog derived from the base budget', () => {
  const opts = parseArgs(argv());
  assert.equal(opts.port, WORKS_CHECK_PORT);
  assert.equal(opts.withListener, false);
  assert.equal(opts.headed, false);
  assert.equal(opts.keep, false);
  // Derived, not hand-picked: the outer watchdog must always fire AFTER the
  // per-stage budgets, or a wedged stage collapses into one unclassifiable answer.
  assert.equal(opts.timeoutMs, BASE_PROBE_BUDGET_MS + PROBE_WATCHDOG_SLACK_MS);
});

test('--port and --timeout round-trip', () => {
  const opts = parseArgs(argv('--port', '4700', '--timeout', '90000'));
  assert.equal(opts.port, 4700);
  assert.equal(opts.timeoutMs, 90000);
});

test('--with-listener switches the default timeout to the listener budget', () => {
  const opts = parseArgs(argv('--with-listener'));
  assert.equal(opts.withListener, true);
  assert.equal(opts.timeoutMs, LISTENER_PROBE_BUDGET_MS + PROBE_WATCHDOG_SLACK_MS);
  // ...and an explicit --timeout still wins over it.
  assert.equal(parseArgs(argv('--with-listener', '--timeout', '1000')).timeoutMs, 1000);
});

test('--headed and --keep are recognized, independently', () => {
  assert.deepEqual(
    [parseArgs(argv('--headed')).headed, parseArgs(argv('--headed')).keep],
    [true, false],
  );
  assert.deepEqual(
    [parseArgs(argv('--keep')).headed, parseArgs(argv('--keep')).keep],
    [false, true],
  );
  const both = parseArgs(argv('--headed', '--keep'));
  assert.equal(both.headed, true);
  assert.equal(both.keep, true);
});

test('a flag missing its value is rejected, at the end of argv and before another flag', () => {
  assert.throws(() => parseArgs(argv('--port')), /--port requires a value/);
  assert.throws(() => parseArgs(argv('--timeout')), /--timeout requires a value/);
  // The next token being a flag must not be swallowed as this flag's value —
  // otherwise `--port --timeout 5` would silently parse the port as NaN.
  assert.throws(() => parseArgs(argv('--port', '--timeout', '5')), /--port requires a value/);
});

test('a non-integer port is rejected', () => {
  assert.throws(() => parseArgs(argv('--port', 'abc')), /--port must be a positive integer/);
  assert.throws(() => parseArgs(argv('--port', '4650.5')), /--port must be a positive integer/);
  assert.throws(() => parseArgs(argv('--port', '0')), /--port must be a positive integer/);
});

test('a negative or zero timeout is rejected', () => {
  // A leading '-' is caught one guard earlier, by the missing-value check, since
  // the parser has no `--flag=value` form and cannot tell `-5` from a flag. The
  // message differs from the positivity guard's; what matters is that neither a
  // negative timeout nor a negative port can reach the run.
  assert.throws(() => parseArgs(argv('--timeout', '-5')), /--timeout requires a value/);
  assert.throws(() => parseArgs(argv('--port', '-1')), /--port requires a value/);
  // Everything non-positive that IS reachable lands on the positivity guard.
  assert.throws(() => parseArgs(argv('--timeout', '0')), /--timeout must be positive ms/);
  assert.throws(() => parseArgs(argv('--timeout', 'abc')), /--timeout must be positive ms/);
});

test('an unknown flag is rejected and the error carries the usage line', () => {
  assert.throws(() => parseArgs(argv('--nope')), /unknown flag: --nope/);
  // The usage string is the only place a caller learns the real flag set, so a
  // flag added to the parser without being added there is a bug this catches.
  assert.throws(() => parseArgs(argv('--nope')), /--headed/);
  assert.throws(() => parseArgs(argv('--nope')), /--keep/);
  // A bare positional is not a flag either — works-check takes none.
  assert.throws(() => parseArgs(argv('probe.html')), /unknown flag: probe\.html/);
});
