// The works-gate command (su-ljrb.6): `npm run works-check`.
//
// Proves, headlessly and standalone (origin R6 — nothing needs to be running
// first, everything it starts is torn down), that the pure-WASM voice stages a
// deploy would ship actually WORK: build the probe entry, serve the built output
// with `vite preview`, drive a headless Chromium through the adapter-import probe
// page (src/probe.ts), assert each stage loads its REAL backend — not a labelled
// stub — and smoke-run each on the committed speech fixture for non-empty output.
// The su-lou.8 lesson, mechanized: the node test suite was 25/25 green while a
// real browser degraded 3 of 5 stages, because nothing loaded the real provisioned
// pipeline; this command is the "operator stops being the integration test" gate.
//
// Exit codes (origin KTD4 — see scripts/works-verdict.mjs, which owns the rules):
//   0   pass · 100  real regression (summary names the stage) · anything else
//   infra-flake (build/server/browser/fixture/provisioning — retryable, not a
//   verdict about the code).
//
// Serving model: vite build with copyPublicDir OFF (the provisioned model trees
// are multi-GB), then HARDLINK the needed public/ subtrees into the outDir —
// instant, no byte copies — and `vite preview` serves the result same-origin with
// the base config's provisionedAsset404 guard active (missing optional model
// files must 404 clean, the contract the TTS load path depends on — su-lou.7).
//
// Prerequisite: provisioned assets (`npm run provision:stt` + `provision:tts`)
// and a Playwright browser (`npx playwright install chromium-headless-shell`).
// Both are checked up front and reported as INFRA with the remedy, never as a
// regression — "not provisioned" and "broken" must not be confusable.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, linkSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { DEFAULT_MOONSHINE_MODEL, DEFAULT_WHISPER_MODEL } from '../src/stt.ts';
import { DEFAULT_TTS_MODEL } from '../src/tts.ts';
import { WORKS_CHECK_PORT, WORKS_CHECK_OUT_DIR } from '../vite.works-check.config.ts';
import { parseWavPcm16 } from './wav.mjs';
import { EXIT_INFRA, evaluateReport, exitCodeFor, summarizeVerdict } from './works-verdict.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(WEB_DIR, WORKS_CHECK_OUT_DIR);
const WORK_DIR = path.dirname(OUT_DIR); // .works-check/ — report.json lands here
const FIXTURE = path.join(WEB_DIR, 'test', 'fixtures', 'utterance.wav');
const CONFIG = path.join(WEB_DIR, 'vite.works-check.config.ts');

const SERVER_UP_TIMEOUT_MS = 20000;
const PROBE_READY_TIMEOUT_MS = 20000;
/** Outer watchdog on the probe run. The adapters carry their own (much tighter)
 *  init/synthesis budgets and degrade to stubs the verdict then FAILS — so a slow
 *  model is a regression, and this deadline only catches a dead page, which is
 *  infra. Worst healthy run in the su-ljrb.1 spike was ~15s; 240s is pure slack. */
const PROBE_RUN_TIMEOUT_MS = 240000;
/** Cap on the retained browser-console ring. Only the last 100 lines are ever
 *  persisted or tailed, so a chatty model load must not grow the buffer for the
 *  whole run — hold a little headroom over what's written and drop the rest. */
const CONSOLE_LINES_MAX = 200;

/** The provisioned trees each stage needs, with the remedy to name when absent. */
const REQUIRED_ASSETS = [
  { rel: 'public/stt/transformers/transformers.min.js', remedy: 'npm run provision:stt' },
  { rel: `public/models/${DEFAULT_MOONSHINE_MODEL}`, remedy: 'npm run provision:stt' },
  { rel: 'public/tts/transformers/transformers.min.js', remedy: 'npm run provision:tts' },
  { rel: `public/models/${DEFAULT_TTS_MODEL}`, remedy: 'npm run provision:tts' },
];

/** public/ subtrees materialized (hardlinked) into the served outDir. The whisper
 *  fallback model ships when present so the check observes the app's real
 *  fallback behaviour, but only moonshine is REQUIRED provisioning. */
const SERVED_ASSETS = [
  { rel: 'stt-engine.js', required: true },
  { rel: 'tts-engine.js', required: true },
  { rel: 'stt', required: true },
  { rel: 'tts', required: true },
  { rel: `models/${DEFAULT_MOONSHINE_MODEL}`, required: true },
  { rel: `models/${DEFAULT_WHISPER_MODEL}`, required: false },
  { rel: `models/${DEFAULT_TTS_MODEL}`, required: true },
];

const log = (m) => console.log(m);

function parseArgs(argv) {
  const opts = { port: WORKS_CHECK_PORT, timeoutMs: PROBE_RUN_TIMEOUT_MS };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (flag) => {
      const v = args[++i];
      if (!v || v.startsWith('-')) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (a === '--port') opts.port = Number(value(a));
    else if (a === '--timeout') opts.timeoutMs = Number(value(a));
    else throw new Error(`unknown flag: ${a} (usage: works-check [--port N] [--timeout MS])`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0) throw new Error('--port must be a positive integer');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout must be positive ms');
  return opts;
}

/** An infra failure: the check could not reach a verdict. Thrown (never
 *  process.exit — that would skip the finally teardown and leak the preview
 *  server on the pinned port); main's catch prints it and exits 2. */
class InfraError extends Error {
  constructor(step, message, hints = []) {
    super(message);
    this.step = step;
    this.hints = hints;
  }
}

function infra(step, message, hints = []) {
  throw new InfraError(step, message, hints);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp(url) {
  try {
    // Bounded probe: without the abort, something else squatting the pinned port
    // and never answering would hang this fetch — and with it the whole up-loop,
    // sailing past SERVER_UP_TIMEOUT_MS (found live, not hypothetically).
    return (await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** Run a command to completion, capturing output. Never throws — returns status. */
function runStep(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: `${out}\n${e.message}` }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Hardlink a file or directory tree from public/ into the outDir (copy on a
 *  cross-device link failure — correctness over speed, but same-repo is same-fs). */
function linkTree(src, dst) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) linkTree(path.join(src, entry), path.join(dst, entry));
    return;
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  try {
    linkSync(src, dst);
  } catch (e) {
    if (e.code === 'EXDEV') copyFileSync(src, dst);
    else throw e;
  }
}

/** Kill a detached child's whole process group (vite preview + its children). */
function stopServer(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const baseUrl = `http://localhost:${opts.port}`;
  const probeUrl = `${baseUrl}/probe.html`;

  // ── preflight: fixture + provisioned assets (absence = INFRA, not regression) ──
  if (!existsSync(FIXTURE)) {
    infra('preflight', `speech fixture missing: ${path.relative(WEB_DIR, FIXTURE)}`, [
      'the fixture is committed (web/test/fixtures/) — a missing file means a broken checkout',
    ]);
  }
  let fixture;
  try {
    const parsed = parseWavPcm16(readFileSync(FIXTURE));
    fixture = { samples: Array.from(parsed.samples), sampleRate: parsed.sampleRate };
  } catch (e) {
    infra('preflight', `speech fixture unreadable: ${e.message}`);
  }
  log(`works-check: fixture ${path.basename(FIXTURE)} — ${(fixture.samples.length / fixture.sampleRate).toFixed(2)}s @ ${fixture.sampleRate}Hz`);

  const missing = REQUIRED_ASSETS.filter((a) => !existsSync(path.join(WEB_DIR, a.rel)));
  if (missing.length > 0) {
    infra(
      'preflight',
      `provisioned assets missing:\n${missing.map((a) => `    ${a.rel}`).join('\n')}`,
      [...new Set(missing.map((a) => a.remedy))].map((r) => `run: ${r}`),
    );
  }

  // ── build the probe entry ──
  // Wipe the outDir first: linkTree tolerates only EXDEV, so a pre-populated
  // outDir makes linkSync throw EEXIST and surface as a confusing INFRA('assets').
  // vite's emptyOutDir already does this today (the outDir sits inside the web
  // root), but that is an implicit default the works-check config never states —
  // state it here instead. OUT_DIR only: report.json lands in WORK_DIR above it.
  rmSync(OUT_DIR, { recursive: true, force: true });
  log('works-check: building the probe entry (vite build)…');
  const build = await runStep('npx', ['vite', 'build', '--config', CONFIG], WEB_DIR);
  if (build.code !== 0) {
    infra('build', `vite build failed (exit ${build.code})\n${build.out.split('\n').slice(-15).join('\n')}`);
  }

  // ── materialize the provisioned assets into the served outDir ──
  log('works-check: hardlinking provisioned assets into the outDir…');
  for (const asset of SERVED_ASSETS) {
    const src = path.join(WEB_DIR, 'public', asset.rel);
    if (!existsSync(src)) {
      if (asset.required) infra('assets', `expected provisioned path vanished mid-run: public/${asset.rel}`);
      continue;
    }
    try {
      linkTree(src, path.join(OUT_DIR, asset.rel));
    } catch (e) {
      infra('assets', `could not link public/${asset.rel} into the outDir: ${e.message}`);
    }
  }

  // ── serve + drive ──
  let server = null;
  let serverOut = '';
  let browser = null;
  const consoleLines = [];
  const recordConsole = (line) => {
    consoleLines.push(line);
    if (consoleLines.length > CONSOLE_LINES_MAX) consoleLines.shift();
  };
  // Tear the detached preview server down even on Ctrl-C, so an interrupted run
  // never squats on the pinned port (capture.ts's discipline — su-lou.4.1).
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopServer(server);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
  try {
    log(`works-check: starting vite preview on :${opts.port}…`);
    server = spawn('npx', ['vite', 'preview', '--config', CONFIG, '--port', String(opts.port), '--strictPort'], {
      cwd: WEB_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    server.stdout.on('data', (d) => (serverOut += d));
    server.stderr.on('data', (d) => (serverOut += d));
    server.unref();

    const deadline = Date.now() + SERVER_UP_TIMEOUT_MS;
    let up = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) break; // strictPort clash exits fast — don't spin the full timeout
      if (await serverUp(probeUrl)) {
        up = true;
        break;
      }
      await sleep(250);
    }
    if (!up) {
      infra('serve', `vite preview did not serve ${probeUrl} within ${SERVER_UP_TIMEOUT_MS / 1000}s`, [
        `server output tail:\n${serverOut.split('\n').slice(-8).join('\n')}`,
        `a port clash on :${opts.port} (strictPort) is retryable — rerun, or pass --port`,
      ]);
    }
    log(`works-check: serving on :${opts.port}`);

    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    } catch (e) {
      infra('browser', `could not launch a browser (${e.message.split('\n')[0]})`, [
        'install one with: npx playwright install chromium-headless-shell   (add --with-deps on a bare host)',
      ]);
    }
    const page = await browser.newPage();
    page.on('console', (m) => recordConsole(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => recordConsole(`[pageerror] ${e.message}`));

    try {
      await page.goto(probeUrl, { waitUntil: 'load', timeout: 15000 });
      await page.waitForFunction(() => window.__worksCheck?.version === 1, undefined, { timeout: PROBE_READY_TIMEOUT_MS });
    } catch {
      infra('probe', 'the probe page never initialized (module import failed?)', [
        `browser console tail:\n${consoleLines.slice(-8).join('\n')}`,
      ]);
    }

    log('works-check: probe ready — loading stages + smoke-running (this loads real models; expect ~15-30s)…');
    let report;
    let watchdog;
    try {
      report = await Promise.race([
        page.evaluate((f) => window.__worksCheck.run(f), fixture),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error(`probe run exceeded ${opts.timeoutMs}ms`)), opts.timeoutMs);
        }),
      ]);
    } catch (e) {
      infra('probe', `the probe run did not complete: ${e.message.split('\n')[0]}`, [
        `browser console tail:\n${consoleLines.slice(-8).join('\n')}`,
      ]);
    } finally {
      clearTimeout(watchdog); // a settled race must not leave a live timer holding the event loop open
    }

    // ── verdict ──
    const verdict = evaluateReport(report);
    mkdirSync(WORK_DIR, { recursive: true });
    const reportPath = path.join(WORK_DIR, 'report.json');
    writeFileSync(
      reportPath,
      JSON.stringify({ when: new Date().toISOString(), url: probeUrl, report, verdict, console: consoleLines.slice(-100) }, null, 2),
    );

    // Optional-chained to match evaluateReport, which accepts a null/undefined/{}
    // report and FAILS both stages (works-verdict.test.mjs:139 locks that in). An
    // unguarded deref here would throw before the summary printed, land in
    // main().catch, and reclassify that loud failure as a retryable EXIT_INFRA.
    const stt = report?.stt ?? {};
    const tts = report?.tts ?? {};
    log('');
    log(`  stt: load=${stt.loadMode} (${stt.loadMs}ms) smoke=${stt.smoke ? `${stt.smoke.mode} "${(stt.smoke.text ?? '').slice(0, 60)}" (${stt.smoke.ms}ms)` : 'none'}`);
    log(`  tts: load=${tts.loadMode} (${tts.loadMs}ms) smoke=${tts.smoke ? `${tts.smoke.mode} ${tts.smoke.samples} samples @${tts.smoke.sampleRate}Hz rms=${tts.smoke.rms} (${tts.smoke.ms}ms)` : 'none'}`);
    for (const d of tts.diagnostics ?? []) log(`       ${d}`);
    log('');
    log(summarizeVerdict(verdict));
    log(`  full report: ${path.relative(WEB_DIR, reportPath)}`);
    process.exitCode = exitCodeFor(verdict);
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer(server);
  }
}

main().catch((e) => {
  // Reached AFTER the finally teardown ran. An InfraError is the check saying
  // "no verdict"; any other throw is equally not a code verdict — both exit 2.
  if (e instanceof InfraError) {
    console.error(`\nWORKS-CHECK INFRA (${e.step}): ${e.message}`);
    for (const h of e.hints) console.error(`  → ${h}`);
  } else {
    console.error(`\nWORKS-CHECK INFRA (unexpected): ${e.stack ?? e.message}`);
  }
  process.exitCode = EXIT_INFRA;
});
