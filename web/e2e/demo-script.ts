// The demo-script parser — the pure half of the PR-level capture engine (su-lou.4.1).
//
// A demo script is markdown that reads as a human-legible proof narrative AND
// carries machine-checkable directives, so the SAME file both documents the proof
// and drives it deterministically. This is the idea kept from signal-loom's
// demo-capture (`_Prove:_` / `_Fail if:_` — "prove the feature WORKS, not just show
// the screen"), made rigorous: instead of an LLM judging a natural-language proof,
// each `_Prove:_` carries a selector/text/eval assertion the engine literally checks
// against the live page, and records pass/fail. Demos exist to communicate to humans
// (they are not regression gates); the checks are there so a demo shows VERIFIED
// behaviour, not a screen tour.
//
// PURE — no Playwright, no ffmpeg, no I/O. Parsing is a `(markdown) -> Demo` function
// in the same discipline as turn-detection.ts / transcript.ts, so the grammar is
// pinned by unit tests (demo-script.test.ts) and capture.ts is the thin driver that
// executes the parsed structure.
//
// ── Grammar (see e2e/demos/u6-warmed-loop.md for a worked example) ──
//
//   # Demo: <title>            (or "# <title>")
//   **Start:** `<url path + query>`
//   **Auth:** yes|no           (optional; accepted and ignored — see below)
//   <free prose>               (becomes the cover subtitle / description)
//   ## Steps
//   1. **<narration>**         (numbered item; bold = the burned-in caption)
//      `<action>`              (0+ backtick directives: goto/wait/waitFor/waitForText/click/scroll)
//      <free prose>            (step description; ignored by the driver)
//      _Prove:_ <prose> `<assertion>`
//      _Fail if:_ <prose> `<assertion>`   (both optional; assertion optional)
//   ## Scrutiny                (optional)
//   - <thing a viewer should check critically>
//
// ── Superset of the gc-toolkit dialect (su-lou.4.2) ──
//
// The per-PR flow drafts a script with the gc-toolkit `gc-demo-script` skill,
// whose output is the generic `demo:capture` format: a `**Auth:**` line and a
// `## Scrutiny` section, and `_Prove:_`/`_Fail if:_` as PROSE with no machine
// assertion. This grammar is a strict superset, so a raw generated draft parses
// and runs as-is (its steps simply record manual proofs) and adapting it for this
// harness is additive — you add sim-mode actions and assertions, you never have to
// restructure the file. Two generic-dialect constructs are handled explicitly:
//
//   • `**Auth:**` is accepted and dropped. This harness has no auth (the demo
//     substrate is a local dev server), and the line is only in the format because
//     the upstream skill targets authenticated apps. Dropping it deliberately —
//     rather than letting it fall through as prose — keeps it out of the cover
//     subtitle.
//   • `## Scrutiny` bullets are parsed into `Demo.scrutiny` instead of being glued
//     onto the last step's description. capture.ts renders them as a closing card,
//     so the section a generated draft ships survives into the video rather than
//     being silently swallowed.
//
// Actions:     goto <path> · wait <ms> · waitFor <selector> · waitForText <selector> ~ <substr> · click <selector> · scroll <selector>
// Assertions:  visible <sel> · hidden <sel> · count <sel> <op> <n> · text <sel> ~ <matcher> · eval <js>
//   <op> ∈ >= > == <= <   ·   <matcher> = /regex/ or "substring" or bare substring

export type ActionVerb = 'goto' | 'wait' | 'waitFor' | 'waitForText' | 'click' | 'scroll';
export const ACTION_VERBS: readonly ActionVerb[] = ['goto', 'wait', 'waitFor', 'waitForText', 'click', 'scroll'];

export interface DemoAction {
  verb: ActionVerb;
  /** First selector/argument (for waitForText, the part before ` ~ `). */
  target: string;
  /** For waitForText: the substring after ` ~ `. For wait: unused. */
  text?: string;
  /** For wait: milliseconds. */
  ms?: number;
  raw: string;
}

export type AssertionKind = 'visible' | 'hidden' | 'count' | 'text' | 'eval';
export type CountOp = '>=' | '>' | '==' | '<=' | '<';
export const COUNT_OPS: readonly CountOp[] = ['>=', '>', '==', '<=', '<'];

export interface Matcher {
  type: 'regex' | 'substr';
  value: string;
}

export interface Assertion {
  kind: AssertionKind;
  /** Present for visible/hidden/count/text. */
  selector?: string;
  /** count only. */
  op?: CountOp;
  n?: number;
  /** text only. */
  matcher?: Matcher;
  /** eval only — a JS expression evaluated in the page; truthy = pass. */
  expr?: string;
  raw: string;
}

/** A `_Prove:_` / `_Fail if:_` contract line: human prose plus an optional machine assertion. */
export interface Contract {
  prose: string;
  assertion?: Assertion;
}

export interface DemoStep {
  /** 1-based step number, in document order (independent of the markdown list number). */
  index: number;
  /** The bold heading — the caption burned into the frame + spoken as narration. */
  narration: string;
  actions: DemoAction[];
  prove?: Contract;
  failIf?: Contract;
  /** Free prose under the step (context; not executed). */
  description: string;
}

export interface Demo {
  title: string;
  /** Start URL path (+ query). The driver joins it onto the base origin. */
  start: string;
  /** Free prose between the header and `## Steps` — the cover subtitle. */
  description: string;
  steps: DemoStep[];
  /** `## Scrutiny` bullets — what a viewer should check critically. Rendered as a closing card. */
  scrutiny: string[];
}

/** Pull every inline-code span `` `...` `` out of a line, in order. */
export function inlineCodes(line: string): string[] {
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1].trim());
  return out;
}

/** Strip every inline-code span and surrounding markdown emphasis from a line → plain prose. */
function proseOf(line: string): string {
  return line
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*/g, '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse one action directive (`goto /x`, `waitFor #y`, `waitForText #z ~ hi`, `wait 500`, `click #b`). */
export function parseAction(code: string): DemoAction | null {
  const raw = code.trim();
  const sp = raw.indexOf(' ');
  const verb = (sp === -1 ? raw : raw.slice(0, sp)) as string;
  if (!ACTION_VERBS.includes(verb as ActionVerb)) return null;
  const rest = sp === -1 ? '' : raw.slice(sp + 1).trim();
  if (verb === 'wait') {
    const ms = Number(rest);
    return { verb, target: rest, ms: Number.isFinite(ms) ? ms : 0, raw };
  }
  if (verb === 'waitForText') {
    const [sel, ...matchParts] = rest.split(' ~ ');
    return { verb, target: sel.trim(), text: matchParts.join(' ~ ').trim(), raw };
  }
  return { verb: verb as ActionVerb, target: rest, raw };
}

/** Parse the assertion code span from a `_Prove:_` / `_Fail if:_` line. Returns null if unrecognised. */
export function parseAssertion(code: string): Assertion | null {
  const raw = code.trim();
  const sp = raw.indexOf(' ');
  const kind = (sp === -1 ? raw : raw.slice(0, sp)) as string;
  const rest = sp === -1 ? '' : raw.slice(sp + 1).trim();

  switch (kind) {
    case 'visible':
    case 'hidden':
      return { kind, selector: rest, raw };
    case 'eval':
      return { kind, expr: rest, raw };
    case 'count': {
      // Parse from the right so the selector may contain spaces: `#a .b >= 2`.
      const toks = rest.split(/\s+/);
      const n = Number(toks.pop());
      const op = toks.pop() as CountOp;
      const selector = toks.join(' ');
      if (!COUNT_OPS.includes(op) || !Number.isFinite(n) || !selector) return null;
      return { kind, selector, op, n, raw };
    }
    case 'text': {
      const idx = rest.indexOf(' ~ ');
      if (idx === -1) return null;
      const selector = rest.slice(0, idx).trim();
      const rhs = rest.slice(idx + 3).trim();
      return { kind, selector, matcher: parseMatcher(rhs), raw };
    }
    default:
      return null;
  }
}

/** `/re/` → regex; `"str"` → substring; bare → substring. */
export function parseMatcher(rhs: string): Matcher {
  if (rhs.length >= 2 && rhs.startsWith('/') && rhs.endsWith('/')) {
    return { type: 'regex', value: rhs.slice(1, -1) };
  }
  if (rhs.length >= 2 && rhs.startsWith('"') && rhs.endsWith('"')) {
    return { type: 'substr', value: rhs.slice(1, -1) };
  }
  return { type: 'substr', value: rhs };
}

/** Parse a `_Prove:_` / `_Fail if:_` line into prose + (optional) machine assertion. */
function parseContract(body: string): Contract {
  const codes = inlineCodes(body);
  // The assertion is the LAST recognised code span; earlier spans stay in the prose.
  let assertion: Assertion | undefined;
  for (let i = codes.length - 1; i >= 0; i--) {
    const a = parseAssertion(codes[i]);
    if (a) {
      assertion = a;
      break;
    }
  }
  return { prose: proseOf(body), assertion };
}

const H1 = /^#\s+(?:Demo:\s*)?(.+)$/i;
const START = /^\*\*Start:\*\*\s*(.+)$/i;
/** Generic-dialect header line; accepted so it never lands in the cover subtitle. */
const AUTH = /^\*\*Auth:\*\*/i;
/** A `##` section heading (`###` and deeper stay prose). */
const SECTION = /^##\s+(.+?)\s*$/;
const STEPS_TITLE = /^Steps\b/i;
const SCRUTINY_TITLE = /^Scrutiny\b/i;
const STEP_ITEM = /^\d+\.\s+\*\*(.+?)\*\*\s*$/;
const BULLET = /^[-*]\s+(.+)$/;
const PROVE = /^_Prove:_\s*(.*)$/i;
const FAIL_IF = /^_Fail if:_\s*(.*)$/i;

/** A scrutiny bullet is read as human prose: markers and emphasis go, code-span TEXT stays. */
function bulletText(s: string): string {
  return s
    .replace(/^[-*]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a demo-script markdown string into a `Demo`. Tolerant: unknown lines become
 * step description prose; a `_Prove:_` without a recognised assertion is kept as a
 * prose-only (manual) contract. Throws only when the document has no title, no
 * `**Start:**`, or no steps — the three things the driver cannot run without.
 */
export function parseDemoScript(md: string): Demo {
  const lines = md.split(/\r?\n/);
  let title = '';
  let start = '';
  const descParts: string[] = [];
  const steps: DemoStep[] = [];
  const scrutiny: string[] = [];

  // `head` until `## Steps`; any later `##` heading closes the steps section, so a
  // trailing `## Scrutiny` (or any other section a generated draft carries) can
  // never leak into the last step's description.
  type Section = 'head' | 'steps' | 'scrutiny' | 'ignored';
  let section: Section = 'head';
  let cur: DemoStep | null = null;
  const pushDesc = (s: string): void => {
    if (!cur) return;
    cur.description = cur.description ? `${cur.description} ${s}` : s;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const sec = line.match(SECTION);
    if (sec) {
      const heading = sec[1].trim();
      section = STEPS_TITLE.test(heading) ? 'steps' : SCRUTINY_TITLE.test(heading) ? 'scrutiny' : 'ignored';
      cur = null;
      continue;
    }

    if (section === 'head') {
      if (!title) {
        const h = line.match(H1);
        if (h) {
          title = h[1].trim();
          continue;
        }
      }
      const s = line.match(START);
      if (s) {
        start = s[1].trim().replace(/^`|`$/g, '').trim();
        continue;
      }
      if (AUTH.test(line)) continue; // generic-dialect field; this harness has no auth
      // Prose between the header and ## Steps → the description (skip the title line).
      if (line && !H1.test(line)) descParts.push(line);
      continue;
    }

    if (section === 'scrutiny') {
      const b = line.match(BULLET);
      if (b) {
        scrutiny.push(bulletText(b[1]));
      } else if (line && scrutiny.length) {
        // A wrapped bullet continues the item above it.
        scrutiny[scrutiny.length - 1] = `${scrutiny[scrutiny.length - 1]} ${bulletText(line)}`.trim();
      }
      continue;
    }

    if (section === 'ignored') continue;

    // Inside the steps section.
    const item = line.match(STEP_ITEM);
    if (item) {
      cur = { index: steps.length + 1, narration: item[1].trim(), actions: [], description: '' };
      steps.push(cur);
      continue;
    }
    if (!cur || !line) continue;

    const pv = line.match(PROVE);
    if (pv) {
      cur.prove = parseContract(pv[1]);
      continue;
    }
    const fi = line.match(FAIL_IF);
    if (fi) {
      cur.failIf = parseContract(fi[1]);
      continue;
    }

    // Any inline-code action directives on this line?
    const codes = inlineCodes(line);
    const actions = codes.map(parseAction).filter((a): a is DemoAction => a !== null);
    if (actions.length) {
      cur.actions.push(...actions);
      // Keep any non-directive prose on the same line as description.
      const prose = proseOf(line);
      if (prose) pushDesc(prose);
      continue;
    }

    pushDesc(proseOf(line));
  }

  if (!title) throw new Error('demo script: missing "# Demo: <title>" heading');
  if (!start) throw new Error('demo script: missing "**Start:** <url>"');
  if (steps.length === 0) throw new Error('demo script: no steps found under "## Steps"');

  return { title, start, description: descParts.join(' ').replace(/\s+/g, ' ').trim(), steps, scrutiny };
}

/** URL/file-safe slug of a title: lowercased, non-alphanumeric runs → '-', trimmed. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
