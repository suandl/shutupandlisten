// Tests for the pure demo-script parser (demo-script.ts).
//
// Runs with the same zero-dependency discipline as the rest of the crux:
//   node --test 'e2e/**/*.test.ts'
// The parser is the contract between a human-legible proof narrative and the
// deterministic driver, so the grammar (actions, `_Prove:_`/`_Fail if:_`
// assertions, matchers) is pinned here rather than discovered at capture time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDemoScript,
  parseAction,
  parseAssertion,
  parseMatcher,
  slugify,
} from './demo-script.ts';

const SCRIPT = `# Demo: U6 Warmed Loop

**Start:** \`/?demo=u6-warmed-loop&llm=off&tts=off\`

Prove the end-to-end loop fires.
Second line of subtitle.

## Steps

1. **The harness boots in sim mode**
   \`waitFor #state-badge\`
   The page loads straight into simulation.
   _Prove:_ the stage panel is showing — \`visible #state-badge\`
   _Fail if:_ a mic prompt appears instead — \`visible #mic-controls\`

2. **A turn is transcribed and the gate reflects**
   \`waitForText #loop-metrics .lm-summary ~ spoken\`
   \`wait 500\`
   _Prove:_ a reflection renders — \`count #transcript .tx-response.reflection >= 1\`
`;

test('parses title, start (backticks stripped), and multi-line description', () => {
  const d = parseDemoScript(SCRIPT);
  assert.equal(d.title, 'U6 Warmed Loop');
  assert.equal(d.start, '/?demo=u6-warmed-loop&llm=off&tts=off');
  assert.equal(d.description, 'Prove the end-to-end loop fires. Second line of subtitle.');
  assert.equal(d.steps.length, 2);
});

test('step 1: narration, action, description, prove + failIf assertions', () => {
  const s = parseDemoScript(SCRIPT).steps[0];
  assert.equal(s.index, 1);
  assert.equal(s.narration, 'The harness boots in sim mode');
  assert.deepEqual(s.actions, [{ verb: 'waitFor', target: '#state-badge', raw: 'waitFor #state-badge' }]);
  assert.equal(s.description, 'The page loads straight into simulation.');
  assert.equal(s.prove?.assertion?.kind, 'visible');
  assert.equal(s.prove?.assertion?.selector, '#state-badge');
  assert.match(s.prove?.prose ?? '', /stage panel is showing/);
  assert.equal(s.failIf?.assertion?.kind, 'visible');
  assert.equal(s.failIf?.assertion?.selector, '#mic-controls');
});

test('step 2: multiple actions accumulate in order', () => {
  const s = parseDemoScript(SCRIPT).steps[1];
  assert.deepEqual(
    s.actions.map((a) => a.verb),
    ['waitForText', 'wait'],
  );
  assert.equal(s.actions[0].target, '#loop-metrics .lm-summary');
  assert.equal(s.actions[0].text, 'spoken');
  assert.equal(s.actions[1].ms, 500);
  assert.equal(s.prove?.assertion?.kind, 'count');
  assert.equal(s.prove?.assertion?.selector, '#transcript .tx-response.reflection');
  assert.equal(s.prove?.assertion?.op, '>=');
  assert.equal(s.prove?.assertion?.n, 1);
});

test('parseAction: each verb, and a non-verb rejected', () => {
  assert.deepEqual(parseAction('goto /?demo=x'), { verb: 'goto', target: '/?demo=x', raw: 'goto /?demo=x' });
  assert.deepEqual(parseAction('click #mic-start'), { verb: 'click', target: '#mic-start', raw: 'click #mic-start' });
  assert.equal(parseAction('wait 1200')?.ms, 1200);
  assert.equal(parseAction('waitForText #a .b ~ hi there')?.text, 'hi there');
  assert.deepEqual(parseAction('scroll #loop-metrics'), { verb: 'scroll', target: '#loop-metrics', raw: 'scroll #loop-metrics' });
  assert.equal(parseAction('#just-a-selector'), null);
  assert.equal(parseAction('frobnicate #x'), null);
});

test('parseAssertion: count parses right-to-left so selectors may contain spaces', () => {
  const a = parseAssertion('count #transcript .tx-turn >= 3');
  assert.equal(a?.selector, '#transcript .tx-turn');
  assert.equal(a?.op, '>=');
  assert.equal(a?.n, 3);
  assert.equal(parseAssertion('count #x'), null); // malformed → null
});

test('parseAssertion: text matcher (regex vs substring) and eval', () => {
  const re = parseAssertion('text #loop-metrics .lm-summary ~ /\\d+ spoken/');
  assert.equal(re?.kind, 'text');
  assert.equal(re?.selector, '#loop-metrics .lm-summary');
  assert.deepEqual(re?.matcher, { type: 'regex', value: '\\d+ spoken' });

  const sub = parseAssertion('text #badge ~ "LISTENING"');
  assert.deepEqual(sub?.matcher, { type: 'substr', value: 'LISTENING' });

  const ev = parseAssertion('eval document.querySelectorAll(".tx-turn").length === 3');
  assert.equal(ev?.kind, 'eval');
  assert.equal(ev?.expr, 'document.querySelectorAll(".tx-turn").length === 3');
});

test('parseMatcher: regex, quoted substring, bare substring', () => {
  assert.deepEqual(parseMatcher('/a.b/'), { type: 'regex', value: 'a.b' });
  assert.deepEqual(parseMatcher('"hi"'), { type: 'substr', value: 'hi' });
  assert.deepEqual(parseMatcher('plain words'), { type: 'substr', value: 'plain words' });
});

test('visible/hidden keep the whole remainder as the selector (spaces allowed)', () => {
  assert.equal(parseAssertion('visible #transcript .tx-response.question')?.selector, '#transcript .tx-response.question');
  assert.equal(parseAssertion('hidden .tx-empty')?.kind, 'hidden');
});

test('a prove line with no recognised assertion stays prose-only', () => {
  const d = parseDemoScript(`# Demo: X\n**Start:** /\n## Steps\n1. **s**\n   _Prove:_ just a human note with no check\n`);
  assert.equal(d.steps[0].prove?.assertion, undefined);
  assert.equal(d.steps[0].prove?.prose, 'just a human note with no check');
});

test('missing title / start / steps each throw', () => {
  assert.throws(() => parseDemoScript('**Start:** /\n## Steps\n1. **s**\n'), /missing "# Demo/);
  assert.throws(() => parseDemoScript('# Demo: X\n## Steps\n1. **s**\n'), /missing "\*\*Start/);
  assert.throws(() => parseDemoScript('# Demo: X\n**Start:** /\n'), /no steps/);
});

test('slugify', () => {
  assert.equal(slugify('U6 Warmed Loop — VAD → TTS'), 'u6-warmed-loop-vad-tts');
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
});

// ── The gc-toolkit generic dialect (su-lou.4.2) ──
//
// A raw `gc-demo-script` draft must parse and run unedited, so the per-PR flow can
// capture first and sharpen after. This fixture is deliberately written in the
// UNADAPTED upstream format: an `**Auth:**` line, prose-only proofs, no sim-mode
// query, no directives, and a trailing `## Scrutiny` section.
const GENERATED = `# Demo: Per-PR demo flow

**Start:** /
**Auth:** yes

## Steps

1. **The harness opens on the stage panel**
   Navigate to the app.
   _Prove:_ The stage panel is visible with a state badge
   _Fail if:_ The page is blank

2. **A turn lands in the transcript**
   Wait for the first scripted turn.
   _Prove:_ A reply is rendered under the turn
   _Fail if:_ The transcript is still empty

## Scrutiny

- Latency numbers are per-stage, not one lumped total
- No microphone permission is ever requested
`;

test('generic dialect: **Auth:** is accepted and kept out of the cover subtitle', () => {
  const d = parseDemoScript(GENERATED);
  assert.equal(d.title, 'Per-PR demo flow');
  assert.equal(d.start, '/');
  assert.equal(d.description, ''); // NOT "Auth: yes"
});

test('generic dialect: an unadapted draft still yields runnable steps (manual proofs)', () => {
  const d = parseDemoScript(GENERATED);
  assert.equal(d.steps.length, 2);
  assert.deepEqual(d.steps[0].actions, []);
  assert.equal(d.steps[0].prove?.assertion, undefined);
  assert.equal(d.steps[0].prove?.prose, 'The stage panel is visible with a state badge');
  assert.equal(d.steps[1].failIf?.prose, 'The transcript is still empty');
});

test('## Scrutiny parses into its own list, never into the last step', () => {
  const d = parseDemoScript(GENERATED);
  assert.deepEqual(d.scrutiny, [
    'Latency numbers are per-stage, not one lumped total',
    'No microphone permission is ever requested',
  ]);
  // The regression this guards: scrutiny bullets used to be appended as prose to
  // whichever step happened to be last.
  assert.equal(d.steps[1].description, 'Wait for the first scripted turn.');
});

test('scrutiny: wrapped bullets join their item, code spans keep their text', () => {
  const d = parseDemoScript(
    `# Demo: X\n**Start:** /\n## Steps\n1. **s**\n## Scrutiny\n- The \`#loop-metrics\` panel reports\n  every stage\n- Second item\n`,
  );
  assert.deepEqual(d.scrutiny, ['The #loop-metrics panel reports every stage', 'Second item']);
});

test('a section after ## Steps closes the steps block instead of leaking into a step', () => {
  const d = parseDemoScript(`# Demo: X\n**Start:** /\n## Steps\n1. **s**\n   real prose\n## Notes\nignored prose here\n`);
  assert.equal(d.steps.length, 1);
  assert.equal(d.steps[0].description, 'real prose');
  assert.deepEqual(d.scrutiny, []);
});

test('a script with no ## Scrutiny section yields an empty list', () => {
  assert.deepEqual(parseDemoScript(SCRIPT).scrutiny, []);
});
