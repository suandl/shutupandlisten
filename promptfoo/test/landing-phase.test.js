// The dictation has to END — keyless, no model, no promptfoo runtime.
//
// su-lou.12 defect 1: judges/restraint.txt scores a transition (silence while
// the idea is dictated, then one thread-pull once it lands), but the simulator
// dictated across every turn, so no conversation ever reached the state the
// rubric's top bands describe. Every cell was mid-dictation by construction and
// the column read 0-of-16 regardless of prompt, provider or model — which, since
// a cell passes only when every judge passes, forced 0-of-16 overall.
//
// These tests pin the fix's contract: the last simulator turn is a LANDING, the
// transcript marks where it happened, the marker stays out of the model-facing
// messages, and the restrained shape the rubric rewards is actually producible.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MultiTurnProvider = require('../providers/multi-turn.js');
const { LANDING_MARKER, phaseDirective } = MultiTurnProvider;

const RESTRAINT_JUDGE = path.resolve(__dirname, '..', 'judges', 'restraint.txt');

// A run wired to stubs: the simulator emits numbered thinker turns, the
// listener emits whatever `listenerText(turn)` returns. Both record the exact
// prompt strings they were handed, so the tests can inspect what the models
// actually saw.
function stubRun({ maxTurns = 5, listenerText = () => '', simText = (i) => `thinker turn ${i}` } = {}) {
  const provider = new MultiTurnProvider({ config: { targetModel: 'openai:gpt-4o', maxTurns } });
  provider._ensureProviders = async () => {};
  provider._loadSimulatorSystem = () => 'SIMULATOR SYSTEM';

  const listenerPrompts = [];
  const simulatorPrompts = [];
  provider._listener = {
    callApi: async (promptStr) => {
      listenerPrompts.push(promptStr);
      return { output: listenerText(listenerPrompts.length - 1), tokenUsage: { total: 1 }, cost: 0 };
    },
  };
  provider._simulator = {
    callApi: async (promptStr) => {
      simulatorPrompts.push(promptStr);
      return { output: simText(simulatorPrompts.length - 1), tokenUsage: { total: 1 }, cost: 0 };
    },
  };

  const prompt = JSON.stringify([
    { role: 'system', content: 'LISTENER SYSTEM' },
    { role: 'user', content: 'opening turn of the idea' },
  ]);
  return { provider, prompt, listenerPrompts, simulatorPrompts };
}

// The system prompt is the first message of the JSON chat array we send.
function systemOf(promptStr) {
  return JSON.parse(promptStr).find((m) => m.role === 'system').content;
}

test('the LAST simulator call lands the idea; earlier calls keep developing it', async () => {
  const { provider, prompt, simulatorPrompts } = stubRun({ maxTurns: 5 });
  const resp = await provider.callApi(prompt, {});
  assert.ok(!resp.error, `loop should not error: ${resp.error}`);

  // 5 listener turns → 4 simulator calls.
  assert.equal(simulatorPrompts.length, 4);
  const systems = simulatorPrompts.map(systemOf);
  for (const s of systems.slice(0, -1)) {
    assert.ok(!/PHASE — LANDING/.test(s), 'only the final simulator call may be told to land');
  }
  assert.match(systems.at(-1), /PHASE — LANDING/);
  assert.match(systems.at(-1), /LAST turn/);
  assert.match(systems[0], /PHASE — DEVELOPING/);
  // Every call is steered, so the thinker is never left to guess the phase.
  for (const s of systems) assert.match(s, /^PHASE — /m);
});

test('phaseDirective lands on the final call for any turn budget', () => {
  // maxTurns=2 → a single simulator call, which is both first and last.
  assert.match(phaseDirective(0, 1), /LANDING/);
  assert.match(phaseDirective(0, 4), /DEVELOPING/);
  assert.match(phaseDirective(2, 4), /CONVERGING/);
  assert.match(phaseDirective(3, 4), /LANDING/);
});

test('the transcript marks the landing exactly once, after the final thinker turn', async () => {
  const { provider, prompt } = stubRun({
    maxTurns: 4,
    listenerText: (i) => (i === 3 ? 'What breaks first when it scales?' : ''),
  });
  const resp = await provider.callApi(prompt, {});
  const blocks = resp.output.split('\n\n');

  const markerAt = blocks.indexOf(LANDING_MARKER);
  assert.notEqual(markerAt, -1, 'transcript must carry the landing marker');
  assert.equal(blocks.filter((b) => b === LANDING_MARKER).length, 1, 'exactly one marker');

  // The block before the marker is the last thinker turn; the block after is
  // the listener's post-landing window.
  assert.match(blocks[markerAt - 1], /^THINKER: /);
  assert.equal(
    blocks.slice(markerAt + 1).filter((b) => b.startsWith('THINKER: ')).length,
    0,
    'no thinker turn may follow the landing',
  );
  assert.match(blocks[markerAt + 1], /^LISTENER: /);
});

test('a restrained run has nothing above the marker and one thread-pull below it', async () => {
  // The listener stays silent for every turn but the last — the exact shape
  // restraint.txt's top band describes, and the one no transcript could reach
  // while the dictation never ended.
  const { provider, prompt } = stubRun({
    maxTurns: 5,
    listenerText: (i) => (i === 4 ? 'What decides which item wins when two expire together?' : ''),
  });
  const resp = await provider.callApi(prompt, {});
  const blocks = resp.output.split('\n\n');
  const markerAt = blocks.indexOf(LANDING_MARKER);

  const above = blocks.slice(0, markerAt).filter((b) => b.startsWith('LISTENER: '));
  const below = blocks.slice(markerAt + 1).filter((b) => b.startsWith('LISTENER: '));
  assert.equal(above.length, 0, 'restrained listener says nothing mid-dictation');
  assert.equal(below.length, 1, 'and pulls exactly one thread once the idea lands');
});

test('the marker never reaches the listener or the simulator', async () => {
  const { provider, prompt, listenerPrompts, simulatorPrompts } = stubRun({
    maxTurns: 3,
    listenerText: () => 'mm',
  });
  const resp = await provider.callApi(prompt, {});
  assert.ok(resp.output.includes(LANDING_MARKER), 'the judges do see it');
  for (const p of [...listenerPrompts, ...simulatorPrompts]) {
    assert.ok(
      !p.includes(LANDING_MARKER),
      'the marker is a format-time annotation — cueing the model would tell it when its window opened',
    );
  }
});

test('an empty landing turn still anchors the marker', async () => {
  // A simulator turn that comes back empty is dropped from the transcript text;
  // the boundary is positional, so it must survive that.
  const { provider, prompt } = stubRun({
    maxTurns: 3,
    listenerText: () => 'and then what?',
    simText: (i) => (i === 1 ? '' : `thinker turn ${i}`),
  });
  const resp = await provider.callApi(prompt, {});
  const blocks = resp.output.split('\n\n');
  assert.equal(blocks.filter((b) => b === LANDING_MARKER).length, 1);
  assert.equal(blocks.at(-1).startsWith('LISTENER: '), true, 'the post-landing turn is last');
});

test('a run with no simulator calls still has a landing point', async () => {
  const { provider, prompt, simulatorPrompts } = stubRun({ maxTurns: 1, listenerText: () => 'mm' });
  const resp = await provider.callApi(prompt, {});
  assert.equal(simulatorPrompts.length, 0);
  const blocks = resp.output.split('\n\n');
  assert.equal(blocks[0].startsWith('THINKER: '), true);
  assert.equal(blocks[1], LANDING_MARKER, 'the opening turn is the landing when nothing follows it');
});

// Sync guard, in the spirit of banned-phrase-sync.test.js: the rubric anchors
// its mid-dictation/post-landing split on this exact line. If the provider's
// marker drifts from the judge's copy, restraint silently goes back to scoring
// a boundary it can no longer find.
test('judges/restraint.txt anchors on the marker the provider emits', () => {
  const rubric = fs.readFileSync(RESTRAINT_JUDGE, 'utf8');
  assert.ok(
    rubric.includes(LANDING_MARKER),
    'restraint.txt must quote providers/multi-turn.js LANDING_MARKER verbatim',
  );
  assert.match(rubric, /If no marker is present/, 'and must define the fallback when it is absent');
});
