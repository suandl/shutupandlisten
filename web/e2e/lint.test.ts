// Tests for the demo-script linter (lint.ts).
//
// The rules exist to make the gap between a GENERATED draft and a PROVING demo
// explicit before a capture run, so they are pinned against two fixtures: a raw
// gc-demo-script draft (should light up) and an adapted script (should be quiet).
// The environment is passed in explicitly, so nothing here shells out to git.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDemoScript } from './demo-script.ts';
import { lintDemo, demoScenarioOf, looksLikeDirective, type LintEnv } from './lint.ts';

/** A well-adapted script: sim scenario, directives, machine assertions everywhere. */
const ADAPTED_SCRIPT = `# Demo: Adapted

**Start:** \`/?demo=u6-warmed-loop&llm=off&tts=off\`

## Steps

${[1, 2, 3, 4, 5]
  .map(
    (i) => `${i}. **Step ${i} does something observable**
   \`waitFor #state-badge\`
   _Prove:_ the badge shows — \`visible #state-badge\`
`,
  )
  .join('\n')}`;

/** A raw gc-demo-script draft: generic route, prose proofs, no directives, 2 steps. */
const DRAFT = `# Demo: Draft

**Start:** /
**Auth:** yes

## Steps

1. **A first thing happens**
   Navigate to the app.
   _Prove:_ The stage panel is visible
   _Fail if:_ The page is blank

2. **A second thing happens**
   Wait a bit.
   _Prove:_ A reply appears
`;

const ENV: LintEnv = { scenarios: ['u6-warmed-loop'], lfsInstalled: true, lfsTracked: true, narration: false };

const messagesFor = (md: string, env: Partial<LintEnv> = {}) =>
  lintDemo(parseDemoScript(md), { ...ENV, ...env });

test('demoScenarioOf pulls the scenario out of the start URL', () => {
  assert.equal(demoScenarioOf('/?demo=u6-warmed-loop&llm=off'), 'u6-warmed-loop');
  assert.equal(demoScenarioOf('/?llm=off&demo=x'), 'x');
  assert.equal(demoScenarioOf('/'), null);
});

test('an adapted script produces no errors and no warnings', () => {
  const findings = messagesFor(ADAPTED_SCRIPT);
  assert.deepEqual(
    findings.filter((f) => f.severity !== 'info'),
    [],
  );
  // The info line always reports how the video will be produced.
  assert.equal(findings.filter((f) => f.severity === 'info').length, 1);
});

test('a raw draft is flagged: no sim scenario, thin step count, prose-only proofs', () => {
  const findings = messagesFor(DRAFT);
  assert.equal(findings.filter((f) => f.severity === 'error').length, 0); // nothing fatal — it WOULD run
  const warns = findings.filter((f) => f.severity === 'warn');
  assert.match(warns[0].message, /no `\?demo=<scenario>` and no step clicks anything/);
  assert.ok(warns.some((f) => /2 steps — under 5/.test(f.message)));
  assert.equal(warns.filter((f) => /`_Prove:_` is prose only/.test(f.message)).length, 2);
  assert.equal(warns.filter((f) => /`_Fail if:_` is prose only/.test(f.message)).length, 1);
});

test('a script with no ?demo= but a click on the sim controls is NOT flagged', () => {
  // The classic timing scripts have no `?demo=` entrypoint — clicking one in the sim
  // controls is the supported way to arm them, and a demo of the floor knob needs it.
  const md = `# Demo: X

**Start:** \`/?llm=off&tts=off\`

## Steps

1. **A scenario is played from the controls**
   \`click #sim-controls button:has-text("Thinking pause")\`
   _Prove:_ the window stayed open — \`count #log .evaluate == 0\`
`;
  assert.equal(
    messagesFor(md).filter((f) => /has no `\?demo=/.test(f.message)).length,
    0,
  );
});

test('an unregistered ?demo= scenario is an ERROR — the harness would boot unarmed', () => {
  const findings = messagesFor(ADAPTED_SCRIPT.replace('u6-warmed-loop&', 'typo-scenario&'));
  const errors = findings.filter((f) => f.severity === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not a registered sim scenario/);
  assert.match(errors[0].message, /u6-warmed-loop/); // names what IS available
});

test('a typo’d directive is reported, prose code spans are not', () => {
  const md = `# Demo: X

**Start:** \`/?demo=u6-warmed-loop\`

## Steps

1. **A step whose wait never happens**
   \`waitfor #state-badge\`
   Driven by the \`?demo=\` entrypoint against \`#loop-metrics\`, run with \`npm run dev\`.
   _Prove:_ the badge shows — \`visible #state-badge\`
`;
  const warns = messagesFor(md).filter((f) => f.severity === 'warn');
  const dropped = warns.filter((f) => /is not a known directive/.test(f.message));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].message, /waitfor #state-badge/);
});

test('a _Prove:_ whose assertion did not parse reads differently from honest prose', () => {
  const md = `# Demo: X

**Start:** \`/?demo=u6-warmed-loop\`

## Steps

1. **A step with a broken check**
   _Prove:_ three turns land — \`count #transcript .tx-turn\`
`;
  const warns = messagesFor(md).filter((f) => f.severity === 'warn' && f.step === 1);
  assert.ok(warns.some((f) => /not a recognised assertion — the step is NOT checked/.test(f.message)));
});

test('an over-long caption is flagged (it clips in the frame)', () => {
  const long = 'x'.repeat(81);
  const md = `# Demo: X\n\n**Start:** \`/?demo=u6-warmed-loop\`\n\n## Steps\n\n1. **${long}**\n   _Prove:_ shows — \`visible #a\`\n`;
  assert.ok(messagesFor(md).some((f) => /caption is 81 chars/.test(f.message)));
});

test('LFS findings: untracked output, and tracked-but-no-git-lfs', () => {
  const untracked = messagesFor(ADAPTED_SCRIPT, { lfsTracked: false });
  assert.ok(untracked.some((f) => /not matched by an LFS filter/.test(f.message)));

  const noBinary = messagesFor(ADAPTED_SCRIPT, { lfsTracked: true, lfsInstalled: false });
  assert.ok(noBinary.some((f) => /git-lfs is NOT installed/.test(f.message)));

  // Both true → neither finding; that is the healthy machine.
  assert.equal(
    messagesFor(ADAPTED_SCRIPT).filter((f) => /LFS|git-lfs/.test(f.message)).length,
    0,
  );
});

test('the info line reports whether the capture will narrate', () => {
  assert.match(messagesFor(ADAPTED_SCRIPT, { narration: true }).at(-1)?.message ?? '', /narrated MP4/);
  assert.match(messagesFor(ADAPTED_SCRIPT, { narration: false }).at(-1)?.message ?? '', /SILENT MP4/);
});

test('looksLikeDirective: case slips and Playwright habits yes, prose no', () => {
  assert.equal(looksLikeDirective('waitfor #x'), true);
  assert.equal(looksLikeDirective('Click #mic-start'), true);
  assert.equal(looksLikeDirective('fill #input hello'), true);
  assert.equal(looksLikeDirective('#loop-metrics'), false);
  assert.equal(looksLikeDirective('?demo=u6-warmed-loop'), false);
  assert.equal(looksLikeDirective('npm run dev'), false);
});
