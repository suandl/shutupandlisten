// The PR-level demo-capture engine — the driver half (su-lou.4.1).
//
// One command turns a markdown demo script into a narrated MP4 that PROVES a PR's
// behaviour against the harness's deterministic sim mode:
//
//   node e2e/capture.ts e2e/demos/u6-warmed-loop.md
//
// Flow (signal-loom's demo-capture, made self-contained + deterministic for su):
//   parse script (demo-script.ts) → ensure the pinned :5173 dev server → drive a
//   headless browser through each step: run its actions, CHECK its `_Prove:_` /
//   `_Fail if:_` assertion against the live DOM (a real machine check, not an LLM
//   judgement), burn the caption in as a DOM overlay, screenshot the proof frame →
//   write manifest.json + issues.json → assemble the MP4 (assemble.ts).
//
// Browser driving uses the Playwright LIBRARY directly (not the MCP server) so the
// engine is self-contained and reproducible in CI — the bead's "run the browser
// driver however is lowest-friction for su". The one prerequisite is a Playwright
// browser: `npx playwright install chromium-headless-shell` (or `--with-deps` on a
// bare host); the engine fails with that exact hint if it's absent.
//
// Exit code: non-zero if any step's proof failed — a committed demo is a regression
// test, not just a recording — but the video/manifest/issues are still written so
// the failure is visible in the frames.

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDemoScript, slugify, type Demo, type DemoStep, type Assertion } from './demo-script.ts';
import { assembleVideo, type Frame, type Manifest } from './assemble.ts';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 5173;
const VIEWPORT = { width: 1280, height: 900 };
const ACTION_TIMEOUT = 15000; // per waitFor/waitForText/click
const PROVE_TIMEOUT = 10000; // how long a `_Prove:_` assertion is polled before failing
const POLL_MS = 200;

interface Options {
  scriptPath: string;
  baseUrl: string | null; // reuse a running server; null → spawn `npm run dev`
  outputPath: string | null;
  noNarrate: boolean;
  keep: boolean; // keep the .captures/<ts> working dir
}

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  let scriptPath = '';
  const opts: Options = { scriptPath: '', baseUrl: null, outputPath: null, noNarrate: false, keep: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--base-url') opts.baseUrl = args[++i];
    else if (a === '--output' || a === '-o') opts.outputPath = args[++i];
    else if (a === '--no-narrate') opts.noNarrate = true;
    else if (a === '--keep') opts.keep = true;
    else if (!a.startsWith('-')) scriptPath = a;
  }
  if (!scriptPath) {
    throw new Error('usage: node e2e/capture.ts <demo-script.md> [--base-url URL] [--output FILE.mp4] [--no-narrate] [--keep]');
  }
  opts.scriptPath = path.resolve(scriptPath);
  return opts;
}

/** True once the dev server answers on `url`. */
async function serverUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverUp(url)) return true;
    await sleep(250);
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Spawn `npm run dev` (pinned :5173) and resolve once it serves. Returns the child so it can be torn down. */
async function startDevServer(port: number, log: (m: string) => void): Promise<ChildProcess> {
  const base = `http://localhost:${port}/`;
  if (await serverUp(base)) {
    log(`server: reusing what is already serving on :${port}`);
    return { kill: () => true } as unknown as ChildProcess; // nothing we own to tear down
  }
  log(`server: starting \`npm run dev\` on :${port}…`);
  const child = spawn('npm', ['run', 'dev'], { cwd: WEB_DIR, stdio: 'ignore', detached: true });
  child.unref(); // don't let the (explicitly torn-down) server keep node alive if a kill is missed
  const ok = await waitForServer(base, 30000);
  if (!ok) {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      /* ignore */
    }
    throw new Error(`server: dev server did not come up on :${port} within 30s`);
  }
  log(`server: ready on :${port}`);
  return child;
}

function stopDevServer(child: ChildProcess): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // kill the process group (vite + esbuild children)
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

function joinUrl(base: string, pathAndQuery: string): string {
  return base.replace(/\/$/, '') + (pathAndQuery.startsWith('/') ? '' : '/') + pathAndQuery;
}

function compare(actual: number, op: string, n: number): boolean {
  switch (op) {
    case '>=':
      return actual >= n;
    case '>':
      return actual > n;
    case '==':
      return actual === n;
    case '<=':
      return actual <= n;
    case '<':
      return actual < n;
    default:
      return false;
  }
}

/** Evaluate one assertion against the live page (single check, no polling). */
async function checkAssertion(page: Page, a: Assertion): Promise<boolean> {
  try {
    switch (a.kind) {
      case 'visible':
        return await page.locator(a.selector as string).first().isVisible();
      case 'hidden': {
        const c = await page.locator(a.selector as string).count();
        if (c === 0) return true;
        return !(await page.locator(a.selector as string).first().isVisible());
      }
      case 'count': {
        const c = await page.locator(a.selector as string).count();
        return compare(c, a.op as string, a.n as number);
      }
      case 'text': {
        const t = (await page.locator(a.selector as string).first().textContent()) ?? '';
        return a.matcher?.type === 'regex' ? new RegExp(a.matcher.value).test(t) : t.includes(a.matcher?.value ?? '');
      }
      case 'eval':
        return Boolean(await page.evaluate(a.expr as string));
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** Poll an assertion until it holds or the timeout elapses. */
async function awaitAssertion(page: Page, a: Assertion, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await checkAssertion(page, a)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

async function runAction(page: Page, base: string, verb: string, target: string, text: string | undefined, ms: number | undefined, log: (m: string) => void): Promise<void> {
  try {
    switch (verb) {
      case 'goto':
        await page.goto(joinUrl(base, target), { waitUntil: 'load', timeout: ACTION_TIMEOUT });
        return;
      case 'wait':
        await page.waitForTimeout(ms ?? 0);
        return;
      case 'waitFor':
        await page.waitForSelector(target, { state: 'visible', timeout: ACTION_TIMEOUT });
        return;
      case 'waitForText':
        await page.waitForFunction(
          ({ sel, sub }) => (document.querySelector(sel)?.textContent ?? '').includes(sub),
          { sel: target, sub: text ?? '' },
          { timeout: ACTION_TIMEOUT },
        );
        return;
      case 'click':
        await page.click(target, { timeout: ACTION_TIMEOUT });
        return;
      case 'scroll':
        // Centre the element in the viewport so the proof frame actually SHOWS it
        // (a panel below the fold passes its DOM assertion but is off-screen).
        await page.locator(target).first().evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await page.waitForTimeout(150);
        return;
    }
  } catch (e) {
    // An action timeout is not fatal on its own — the step's `_Prove:_` is the real
    // gate. Log it so a genuinely stuck step is visible in the run output.
    log(`  · action \`${verb} ${target}\` did not settle: ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Burn the step caption into the page as a DOM overlay, so the screenshot carries it in the app's own font. */
async function injectCaption(page: Page, idx: number, total: number, text: string, failed: boolean): Promise<void> {
  await page.evaluate(
    ({ idx, total, text, failed }) => {
      const ID = '__demo_caption__';
      document.getElementById(ID)?.remove();
      const bar = document.createElement('div');
      bar.id = ID;
      const accent = failed ? '#e0554e' : '#6ad08a';
      Object.assign(bar.style, {
        position: 'fixed',
        left: '0',
        right: '0',
        bottom: '0',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '16px 22px',
        background: 'rgba(9, 11, 15, 0.86)',
        borderTop: `3px solid ${accent}`,
        color: '#e7e9ee',
        font: '18px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        boxShadow: '0 -10px 30px rgba(0,0,0,0.35)',
      });
      const counter = document.createElement('span');
      Object.assign(counter.style, {
        flex: '0 0 auto',
        color: accent,
        fontWeight: '700',
        fontVariantNumeric: 'tabular-nums',
        fontSize: '15px',
        border: `1px solid ${accent}`,
        borderRadius: '6px',
        padding: '2px 8px',
      });
      counter.textContent = `${idx} / ${total}`;
      const label = document.createElement('span');
      label.textContent = text;
      bar.append(counter, label);
      if (failed) {
        const badge = document.createElement('span');
        Object.assign(badge.style, {
          marginLeft: 'auto',
          flex: '0 0 auto',
          color: '#0b0e12',
          background: accent,
          fontWeight: '700',
          fontSize: '12px',
          letterSpacing: '0.06em',
          borderRadius: '6px',
          padding: '3px 8px',
        });
        badge.textContent = 'PROOF FAILED';
        bar.appendChild(badge);
      }
      document.body.appendChild(bar);
    },
    { idx, total, text, failed },
  );
}

async function removeCaption(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('__demo_caption__')?.remove());
}

interface StepResult {
  frame: Frame;
  issue: { severity: 'error' | 'warning'; step: number; description: string; screenshot: string } | null;
}

async function runStep(page: Page, base: string, step: DemoStep, total: number, capturesDir: string, log: (m: string) => void): Promise<StepResult> {
  log(`step ${step.index}/${total}: ${step.narration}`);
  for (const act of step.actions) {
    await runAction(page, base, act.verb, act.target, act.text, act.ms, log);
  }

  // Evaluate the proof. A prove-assertion must become true; a failIf-assertion
  // becoming true overrides it to a failure.
  let proved = true;
  let reason = '';
  if (step.prove?.assertion) {
    proved = await awaitAssertion(page, step.prove.assertion, PROVE_TIMEOUT);
    if (!proved) reason = `_Prove:_ did not hold: \`${step.prove.assertion.raw}\``;
  }
  if (proved && step.failIf?.assertion) {
    const failMatched = await checkAssertion(page, step.failIf.assertion);
    if (failMatched) {
      proved = false;
      reason = `_Fail if:_ condition matched: \`${step.failIf.assertion.raw}\``;
    }
  }
  const manual = !step.prove?.assertion && !step.failIf?.assertion;
  log(proved ? (manual ? '  ✓ (manual — no machine assertion)' : '  ✓ proof held') : `  ✗ ${reason}`);

  const file = `${String(step.index).padStart(2, '0')}-${slugify(step.narration).slice(0, 40)}.png`;
  await injectCaption(page, step.index, total, step.narration, !proved);
  await page.screenshot({ path: path.join(capturesDir, file) });
  await removeCaption(page);

  const frame: Frame = {
    file,
    narration: step.narration,
    duration: 3.5,
    observation: proved ? (manual ? 'manual proof (no machine assertion)' : null) : reason,
    proof: proved ? 'passed' : 'failed',
    severity: proved ? null : 'error',
  };
  const issue = proved ? null : ({ severity: 'error' as const, step: step.index, description: `${step.prove?.prose ?? step.narration} — ${reason}`, screenshot: file });
  return { frame, issue };
}

/** A dark title card matching the harness theme, rendered in-browser and screenshotted as the cover frame. */
async function captureCover(page: Page, demo: Demo, stepCount: number, capturesDir: string): Promise<Frame> {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  await page.setContent(
    `<!doctype html><html><body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;gap:20px;padding:0 8vw;
       background:#0f1115;color:#e7e9ee;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
       <div style="color:#6ad08a;font-size:14px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;">shutupandlisten · demo capture</div>
       <div style="font-size:44px;font-weight:700;line-height:1.15;">${esc(demo.title)}</div>
       <div style="font-size:20px;color:#9aa3b2;max-width:60ch;line-height:1.5;">${esc(demo.description)}</div>
       <div style="font-size:15px;color:#9aa3b2;">${stepCount} proof steps · driven against deterministic sim mode</div>
     </body></html>`,
  );
  await page.waitForTimeout(150);
  const file = '00-cover.png';
  await page.screenshot({ path: path.join(capturesDir, file) });
  return { file, narration: demo.title, duration: 5, observation: null, proof: 'passed', severity: null };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const log = (m: string): void => console.log(m);

  if (!existsSync(opts.scriptPath)) throw new Error(`demo script not found: ${opts.scriptPath}`);
  const demo = parseDemoScript(readFileSync(opts.scriptPath, 'utf8'));
  log(`demo: "${demo.title}" — ${demo.steps.length} steps`);

  // Output + captures dir are keyed off the SCRIPT filename (stable + predictable —
  // one script → one <name>.mp4); the title is only for the cover/caption text.
  const slug = slugify(path.basename(opts.scriptPath, path.extname(opts.scriptPath)));
  const capturesDir = path.join(WEB_DIR, 'e2e', '.captures', `${slug}-${Date.now()}`);
  mkdirSync(capturesDir, { recursive: true });
  const outputPath = opts.outputPath ? path.resolve(opts.outputPath) : path.join(WEB_DIR, 'e2e', 'demos', `${slug}.mp4`);
  mkdirSync(path.dirname(outputPath), { recursive: true });

  const base = opts.baseUrl ?? `http://localhost:${DEFAULT_PORT}`;
  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    if (!opts.baseUrl) server = await startDevServer(DEFAULT_PORT, log);
    else log(`server: using --base-url ${base}`);

    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    } catch (e) {
      throw new Error(
        `Could not launch a browser (${(e as Error).message.split('\n')[0]}).\n` +
          `Install one with:  npx playwright install chromium-headless-shell   (add --with-deps on a bare host).`,
      );
    }
    const page = await browser.newPage({ viewport: VIEWPORT });
    // Land on the start URL first so every step operates on the harness.
    await page.goto(joinUrl(base, demo.start), { waitUntil: 'load', timeout: ACTION_TIMEOUT });

    const frames: Frame[] = [];
    const issues: StepResult['issue'][] = [];
    let failures = 0;
    for (const step of demo.steps) {
      const { frame, issue } = await runStep(page, base, step, demo.steps.length, capturesDir, log);
      frames.push(frame);
      if (issue) {
        issues.push(issue);
        failures++;
      }
    }

    const cover = await captureCover(page, demo, demo.steps.length, capturesDir);
    const manifest: Manifest = { title: demo.title, frames: [cover, ...frames] };
    writeFileSync(path.join(capturesDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(path.join(capturesDir, 'issues.json'), JSON.stringify(issues.filter(Boolean), null, 2));

    await browser.close();
    browser = null;

    const result = await assembleVideo({ capturesDir, outputPath, noNarrate: opts.noNarrate, log });
    log('');
    log(`✅ ${result.narrated ? 'narrated' : 'silent'} demo → ${path.relative(WEB_DIR, result.outputPath)}`);
    log(`   frames + manifest: ${path.relative(WEB_DIR, capturesDir)}`);
    if (failures > 0) log(`   ⚠️  ${failures} step(s) failed their proof — see issues.json`);

    if (!opts.keep) rmSync(capturesDir, { recursive: true, force: true });
    process.exitCode = failures > 0 ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) stopDevServer(server);
  }
}

main().catch((e) => {
  console.error(`\n✖ ${(e as Error).message}`);
  process.exitCode = 1;
});
