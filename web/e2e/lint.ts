// Demo-script linter — the pre-flight for the per-PR demo flow (su-lou.4.2).
//
//   npm run demo:lint -- e2e/demos/<script>.md
//
// The flow drafts a script with the gc-toolkit `gc-demo-script` skill (which reads
// a closed bead + its PR diff) and then ADAPTS it to this harness. A raw draft is
// written for a generic web app: it has prose proofs, no sim-mode entrypoint, and
// no directives. It parses and runs — by design, the grammar is a superset — but it
// captures a SCREEN TOUR: frames that show pages without proving anything.
//
// That failure is invisible until you have watched the video, and a capture run
// costs a dev server, a browser and an encode. So the gap is made explicit here
// instead: the linter reads a script exactly as the driver will and reports what
// the driver will silently do nothing about.
//
// It checks the things that actually go wrong when adapting a draft:
//   • a `?demo=` scenario that does not exist in the simulator's registry (the
//     capture would run against an unarmed harness and every proof would fail);
//   • steps whose `_Prove:_` carries no machine assertion (the frame is a manual
//     proof — fine deliberately, fatal by accident);
//   • directives with a typo (`waitfor #x`), which the tolerant parser DROPS
//     silently, so the step just never waits for anything;
//   • captions too long to read burned into a frame;
//   • whether a captured MP4 could even be committed correctly (git-LFS).
//
// PURE CORE, thin CLI — same split as demo-script.ts: `lintDemo()` takes an already
// parsed Demo plus an explicit environment snapshot and returns findings, so the
// rules are unit-tested (lint.test.ts) without git, a browser or a network.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDemoScript, ACTION_VERBS, ASSERTION_KINDS, slugify, type Demo } from './demo-script.ts';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Step-count window from the gc-demo-script contract: under 5 is thin, over 12 spans too much. */
const MIN_STEPS = 5;
const MAX_STEPS = 12;
/** A caption is burned into the frame as one line; past this it wraps or clips. */
const MAX_NARRATION = 80;

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  severity: Severity;
  /** Step number the finding belongs to, or null for script-level findings. */
  step: number | null;
  message: string;
}

/** Everything outside the script that the rules need — passed in so the core stays pure. */
export interface LintEnv {
  /** Scenario names the simulator actually registers (`DEMO_SCRIPTS`). */
  scenarios: string[];
  /** `git lfs` available on this machine. */
  lfsInstalled: boolean;
  /** The MP4 this script would produce is matched by an LFS filter attribute. */
  lfsTracked: boolean;
  /** OPENAI_API_KEY present → the capture will narrate; absent → silent MP4. */
  narration: boolean;
}

/** The scenario named by a `?demo=` query, or null when the start URL has none. */
export function demoScenarioOf(start: string): string | null {
  const m = start.match(/[?&]demo=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Verbs that mean "I meant to drive the browser here". A dropped span is only worth
 * reporting when it looks like an attempted directive — prose legitimately cites
 * selectors (`#loop-metrics`), URLs (`?demo=`) and commands (`npm run dev`) in
 * backticks, and flagging those would bury the real finding in noise. So: the real
 * verbs (to catch case slips like `waitfor`) plus the plausible-wrong ones an author
 * reaches for out of Playwright habit.
 */
const DIRECTIVE_WORDS = new Set([
  ...ACTION_VERBS.map((v) => v.toLowerCase()),
  'waitforselector',
  'waitforelement',
  'waitfortext',
  'sleep',
  'pause',
  'type',
  'fill',
  'press',
  'hover',
  'select',
  'check',
  'navigate',
  'open',
  'screenshot',
  'expect',
  'assert',
  'scrollto',
  'scrollintoview',
]);

/** First bare word of a code span, lowercased — '' when it does not start with one. */
function leadWord(code: string): string {
  const first = code.trim().split(/\s+/)[0] ?? '';
  return /^[A-Za-z]+$/.test(first) ? first.toLowerCase() : ''; // selectors, URLs, flags → prose
}

/** True when a dropped code span reads as an attempted directive rather than prose. */
export function looksLikeDirective(code: string): boolean {
  // An exact-case real verb never reaches here (it parsed); a case slip does.
  return DIRECTIVE_WORDS.has(leadWord(code));
}

/**
 * True when a code span on a `_Prove:_` / `_Fail if:_` line reads as an attempted
 * ASSERTION — e.g. `count #x` (missing its operator) or `Visible #x`. Separate from
 * the directive test because assertion kinds are a different vocabulary from action
 * verbs, and a malformed assertion is the more common adaptation slip.
 */
export function looksLikeAssertion(code: string): boolean {
  const lead = leadWord(code);
  return ASSERTION_KINDS.some((k) => k === lead) || DIRECTIVE_WORDS.has(lead);
}

/** Apply every rule to a parsed script. Order: script-level findings first, then per step. */
export function lintDemo(demo: Demo, env: LintEnv): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Severity, step: number | null, message: string): void => {
    out.push({ severity, step, message });
  };

  // ── Substrate: is this driven against the deterministic sim scenario? ──
  const scenario = demoScenarioOf(demo.start);
  if (!scenario) {
    add(
      'warn',
      null,
      `**Start:** \`${demo.start}\` has no \`?demo=<scenario>\` — the capture will open the harness idle, ` +
        `with nothing to observe. Point it at a loop-driving sim scenario (${env.scenarios.join(', ') || 'none registered'}).`,
    );
  } else if (!env.scenarios.includes(scenario)) {
    add(
      'error',
      null,
      `\`?demo=${scenario}\` is not a registered sim scenario (have: ${env.scenarios.join(', ') || 'none'}) — ` +
        `the harness would boot unarmed and every proof would fail.`,
    );
  }

  // ── Shape: the step-count window the draft generator targets ──
  if (demo.steps.length < MIN_STEPS) {
    add('warn', null, `${demo.steps.length} steps — under ${MIN_STEPS}. Add context-setting steps, or fold this into another demo.`);
  } else if (demo.steps.length > MAX_STEPS) {
    add('warn', null, `${demo.steps.length} steps — over ${MAX_STEPS}. Split it, or narrow to the PR's highest-impact behaviour.`);
  }

  // ── Per step ──
  for (const step of demo.steps) {
    if (step.narration.length > MAX_NARRATION) {
      add('warn', step.index, `caption is ${step.narration.length} chars (max ${MAX_NARRATION}) — it will wrap or clip in the frame.`);
    }

    if (!step.prove) {
      add('warn', step.index, `no \`_Prove:_\` line — this frame shows a screen without claiming anything about it.`);
    } else if (!step.prove.assertion) {
      // An unparsed span on the line is a different bug from honest prose: the author
      // wrote a check and it did not take.
      const attempted = step.prove.codes.filter(looksLikeAssertion);
      add(
        'warn',
        step.index,
        attempted.length
          ? `\`_Prove:_\` carries \`${attempted[0]}\`, which is not a recognised assertion — the step is NOT checked. Assertions are visible/hidden/count/text/eval.`
          : `\`_Prove:_\` is prose only — nothing is checked against the page. ` +
            `Add an assertion (\`visible\`/\`hidden\`/\`count\`/\`text\`/\`eval\`) to make the frame a proof.`,
      );
    }
    if (step.failIf && !step.failIf.assertion) {
      add('warn', step.index, `\`_Fail if:_\` is prose only — the condition is never evaluated.`);
    }

    // Directives the parser dropped. A typo'd verb is the nastiest failure here: the
    // step silently loses its wait/click and the proof then fails for a reason that
    // has nothing to do with the feature under demo.
    for (const code of step.droppedCodes.filter(looksLikeDirective)) {
      add('warn', step.index, `\`${code}\` is not a known directive — it is IGNORED at capture time (verbs: ${ACTION_VERBS.join(', ')}).`);
    }
  }

  // ── Publishing: can the artifact this produces actually be committed? ──
  if (!env.lfsTracked) {
    add('warn', null, `the MP4 this script produces is not matched by an LFS filter in .gitattributes — committing it would put raw video bytes in git history.`);
  } else if (!env.lfsInstalled) {
    add(
      'warn',
      null,
      `git-lfs is NOT installed but .gitattributes claims LFS for this MP4 — a commit here silently stores the raw bytes. ` +
        `Install it first: sudo apt install git-lfs && git lfs install.`,
    );
  }

  add('info', null, env.narration ? `OPENAI_API_KEY is set — the capture will produce a narrated MP4 alongside the silent one.` : `no OPENAI_API_KEY — the capture will produce a SILENT MP4 (narration is best-effort).`);

  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** The MP4 path capture.ts would write for this script (same derivation: script filename, slugified). */
export function outputPathFor(scriptPath: string): string {
  const slug = slugify(path.basename(scriptPath, path.extname(scriptPath)));
  return path.join(WEB_DIR, 'e2e', 'demos', `${slug}.mp4`);
}

function gitOk(args: string[]): boolean {
  const r = spawnSync('git', args, { cwd: WEB_DIR, encoding: 'utf8' });
  return r.status === 0;
}

/** Does an LFS filter attribute apply to `file`? (`git check-attr filter -- <file>`) */
function lfsTracked(file: string): boolean {
  const r = spawnSync('git', ['check-attr', 'filter', '--', file], { cwd: WEB_DIR, encoding: 'utf8' });
  return r.status === 0 && /filter:\s*lfs/.test(r.stdout ?? '');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const scriptArg = args.find((a) => !a.startsWith('-'));
  if (!scriptArg) throw new Error('usage: node e2e/lint.ts <demo-script.md> [--strict]');
  const scriptPath = path.resolve(scriptArg);
  if (!existsSync(scriptPath)) throw new Error(`demo script not found: ${scriptPath}`);

  let demo: Demo;
  try {
    demo = parseDemoScript(readFileSync(scriptPath, 'utf8'));
  } catch (e) {
    // A parse failure is terminal: the driver would refuse the same file.
    console.error(`✖ ${path.relative(WEB_DIR, scriptPath)} — ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // The registry is the simulator's own, imported rather than duplicated, so a
  // scenario added or renamed there can never drift from what the linter accepts.
  const { DEMO_SCRIPTS } = await import('../src/simulator.ts');
  const out = outputPathFor(scriptPath);
  const findings = lintDemo(demo, {
    scenarios: DEMO_SCRIPTS.map((s) => s.name),
    lfsInstalled: gitOk(['lfs', 'version']),
    lfsTracked: lfsTracked(out),
    narration: Boolean(process.env.OPENAI_API_KEY),
  });

  console.log(`${path.relative(WEB_DIR, scriptPath)} → ${path.relative(WEB_DIR, out)}`);
  console.log(`"${demo.title}" — ${demo.steps.length} steps, ${demo.scrutiny.length} scrutiny item(s)`);
  console.log('');
  const mark = { error: '✖', warn: '⚠', info: 'ℹ' } as const;
  for (const f of findings) {
    console.log(`${mark[f.severity]} ${f.step === null ? 'script' : `step ${f.step}`}: ${f.message}`);
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  console.log('');
  console.log(errors || warns ? `${errors} error(s), ${warns} warning(s)` : '✅ clean');
  process.exitCode = errors > 0 || (strict && warns > 0) ? 1 : 0;
}

// Only run the CLI when executed directly — importing this module (tests) must not
// parse argv or touch git.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n✖ ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
