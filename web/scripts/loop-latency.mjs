// `npm run measure:loop` — read the warmed loop's per-stage latency out of a real
// browser run, as a table (su-lou.10.5).
//
// WHY THIS EXISTS. main.ts has recorded per-stage loop latency since U6 and RENDERED
// it in a panel; nothing could ever READ it. So the one number that decides whether
// the deferred stage 2 is worth building — how long the listener LLM takes to
// generate — was obtainable only by a human squinting at a panel. Stage 2 would let
// a confident `complete` verdict shorten the silence floor, buying perhaps 250ms; if
// generation alone costs the better part of a second, that saving is noise and stage
// 2 stays deferred. That is a decision that should rest on a measurement anyone can
// re-run, which is what this is.
//
// HOW: spawn the dev server (which serves the provisioned model trees from public/
// as-is — no build, no hardlinking), drive the mic-less loop-driving demo the
// capture engine already uses (?demo=, su-lou.4.1), and read `window.__loopMetrics`.
// Same shape as the works-check: navigate, wait for a page hook, evaluate, report.
//
// Usage:
//   npm run measure:loop                      real provisioned models
//   npm run measure:loop -- --query llm=off   the stub substrate (fast; structure only)
//   npm run measure:loop -- --base-url http://localhost:5173   reuse a running server
//   npm run measure:loop -- --json            machine-readable, for pasting into a bead
//
// READ THE SUBSTRATE LINE BEFORE THE NUMBERS. The demo's turns are spaced for the
// STUB response length (floor 2s + 1.5s reply). A real listener on the single-
// threaded WASM rung takes far longer than that gap, so later turns can overlap the
// one before them — which is why this prints EVERY turn rather than only the mean,
// and prints which backends were actually live. Turn 1 is always clean: nothing
// precedes it. A mean over turns that overlapped is a number about the demo's
// pacing, not about the pipeline.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Not vite's default 5173: this app is routinely being served from several
 *  worktrees at once, and a port collision here means measuring another checkout. */
const DEFAULT_PORT = 5178;
const DEFAULT_DEMO = 'u6-warmed-loop';
/** Turns the default demo drives — the poll target. */
const DEFAULT_TURNS = 3;
const SERVER_UP_TIMEOUT_MS = 30000;
const PAGE_READY_TIMEOUT_MS = 30000;
/** Generous: a cold listener load on the WASM rung is minutes, not seconds. */
const DEFAULT_RUN_TIMEOUT_MS = 900000;
const POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    baseUrl: null,
    demo: DEFAULT_DEMO,
    query: '',
    turns: DEFAULT_TURNS,
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--demo') opts.demo = argv[++i];
    else if (a === '--query') opts.query = argv[++i].replace(/^\?/, '');
    else if (a === '--turns') opts.turns = Number(argv[++i]);
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
    else {
      console.error(`loop-latency: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

async function serverUp(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await serverUp(url)) return true;
    await sleep(200);
  }
  return false;
}

/** Round to whole ms for display; the sub-ms digits are noise at this scale. */
const ms = (n) => (n === null || n === undefined ? '—' : `${Math.round(n)}ms`);

function formatTable(result) {
  const lines = [];
  const { summary, turns, knobs, modes } = result;

  lines.push('');
  lines.push(`  substrate: ${modes.source}`);
  lines.push(
    `  backends:  listener=${modes.listener ?? 'not loaded'}${modes.listenerDtype ? `/${modes.listenerDtype}` : ''} · tts=${modes.speaker ?? 'not loaded'}`,
  );
  // A latency table without the knobs it was taken under is unreadable — the floor
  // is literally one of the legs (turn-end fires when it expires).
  lines.push(
    `  knobs:     floor=${knobs.silenceFloorMs}ms · extension=${knobs.incompleteExtensionMs}ms · threshold=${knobs.completionThreshold} · smart-turn=${knobs.useSmartTurn ? 'on' : 'off'}`,
  );
  lines.push('');

  const LEG_MEANING = {
    'turn-end→transcript': 'STT (sim: scripted)',
    'transcript→gate': 'response-hierarchy gate',
    'gate→reply': 'LISTENER LLM GENERATION',
    'reply→speech-start': 'TTS synthesis + playback start',
  };
  // THE CONFOUND, named where the number is read rather than in a doc nobody opens.
  // The listener and the voice are created lazily, inside the first reply that needs
  // them — so the first `gate→reply` carries the MODEL LOAD as well as the
  // generation, and on this demo (all three turns inside 16s) a load measured in
  // minutes swallows every turn's leg, not just turn 1's. For a clean load-vs-
  // generate split, `npm run works-check -- --with-listener` times them separately.
  if (modes.listener && modes.listener !== 'stub') {
    lines.push('  NOTE: gate→reply includes the lazy model LOAD, not generation alone —');
    lines.push('        the demo fires all three turns inside 16s, long before a cold load finishes.');
    lines.push('        Use `works-check -- --with-listener` for load and generate timed apart.');
    lines.push('');
  }
  lines.push('  mean per leg:');
  for (const [key, meaning] of Object.entries(LEG_MEANING)) {
    const v = summary.meanLegMs[key];
    lines.push(`    ${key.padEnd(22)} ${ms(v).padStart(8)}   ${meaning}`);
  }
  lines.push(`    ${'turn-end→speech-start'.padEnd(22)} ${ms(summary.meanTotalMs).padStart(8)}   whole loop (${summary.completed} spoken of ${summary.turns})`);
  lines.push('');

  // Per turn, because the mean hides both the cold first turn and any overlap the
  // demo's stub-sized pacing causes on a slow rung.
  lines.push('  per turn:');
  for (const t of turns) {
    const legs = Object.fromEntries(t.legs.map((l) => [`${l.from}→${l.to}`, l.ms]));
    lines.push(
      `    turn ${String(t.turn).padStart(2)}  total ${ms(t.totalMs).padStart(9)}  ` +
        Object.keys(LEG_MEANING)
          .map((k) => `${k.split('→')[1]}:${ms(legs[k])}`)
          .join('  '),
    );
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(m);

  let server = null;
  let base = opts.baseUrl;
  if (!base) {
    base = `http://localhost:${opts.port}`;
    // NEVER adopt a server that happens to be listening. It is very likely THIS app
    // — served from a different checkout — and the numbers would silently describe
    // someone else's working tree. (That is not hypothetical: it is what happened
    // the first time this script was run, against a sibling worktree's `npm run dev`
    // on vite's default port.) Reuse is an explicit `--base-url` and nothing else.
    if (await serverUp(base)) {
      console.error(
        `loop-latency: something is already serving :${opts.port}. Refusing to adopt it — it may be a different\n` +
          '  checkout of this same app, which would measure the wrong code. Pass --port N for a free port,\n' +
          '  or --base-url URL if you really do mean to drive that server.',
      );
      process.exit(1);
    }
    log(`loop-latency: starting the dev server on :${opts.port}…`);
    server = spawn('npm', ['run', 'dev', '--', '--port', String(opts.port), '--strictPort'], {
      cwd: WEB_DIR,
      stdio: 'ignore',
      detached: true,
    });
    if (!(await waitForServer(base, SERVER_UP_TIMEOUT_MS))) {
      stopServer(server);
      console.error('loop-latency: the dev server never came up');
      process.exit(1);
    }
  }

  const query = [`demo=${encodeURIComponent(opts.demo)}`, opts.query].filter(Boolean).join('&');
  const url = `${base}/?${query}`;

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    // The models are loud on load (device-ladder diagnostics); keep them, they are
    // the only explanation for a rung that quietly degraded.
    page.on('console', (m) => {
      const t = m.text();
      if (/\[(listener|tts|smart-turn|stt|denoise)\]/.test(t)) log(`    ${t}`);
    });

    log(`loop-latency: driving ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: PAGE_READY_TIMEOUT_MS });
    await page.waitForFunction(() => window.__loopMetrics?.version === 1, undefined, {
      timeout: PAGE_READY_TIMEOUT_MS,
    });

    // Poll until every expected turn has been SPOKEN (not merely started): the last
    // leg is reply→speech-start, so a turn that has not spoken has no total.
    const until = Date.now() + opts.timeoutMs;
    let last = -1;
    while (Date.now() < until) {
      const completed = await page.evaluate(() => window.__loopMetrics.summary().completed);
      if (completed !== last) {
        log(`loop-latency: ${completed}/${opts.turns} turns spoken…`);
        last = completed;
      }
      if (completed >= opts.turns) break;
      await sleep(POLL_MS);
    }

    const result = await page.evaluate(() => ({
      summary: window.__loopMetrics.summary(),
      turns: window.__loopMetrics.turns(),
      knobs: window.__loopMetrics.knobs(),
      modes: window.__loopMetrics.modes(),
    }));

    if (result.summary.completed < opts.turns) {
      // Not a failure: a partial run still carries turn 1, which is the clean one.
      // Say so loudly rather than letting a short table read as a complete one.
      log(`loop-latency: TIMED OUT with ${result.summary.completed}/${opts.turns} spoken — the table below is partial`);
    }

    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else log(formatTable(result));
  } finally {
    await browser?.close();
    if (server) stopServer(server);
  }
}

function stopServer(child) {
  try {
    // Detached → kill the whole process group; `npm run dev` spawns vite as a child.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

main().catch((e) => {
  console.error(`loop-latency: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
