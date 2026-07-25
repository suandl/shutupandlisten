// Fixture-replay provider — keyless, no model, no promptfoo runtime.
//
// Replay swaps the simulator for a captured session (fixtures/README.md), so
// the contract these tests pin is: the fixture drives every thinker turn
// verbatim, ZERO simulator calls happen, and the output is byte-compatible
// with the multi-turn transcript contract — THINKER/LISTENER lines, the
// landing marker at the fixture's landing index — so all four judges run
// unchanged. Gate mode must route with the same rules as reduced-role
// (lib/gate.js) and report listenerModelCalls the same way.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ReplayProvider = require('../providers/replay.js');
const { LANDING_MARKER } = require('../providers/multi-turn.js');
const { shouldEscalate } = require('../lib/gate.js');

const TARGET = 'anthropic:claude-haiku-4-5';
const ACK_SET = new Set(['mm', 'yeah', 'mhm', 'right', 'mm-hm']);
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

const READING_APP = JSON.parse(
  fs.readFileSync(path.join(FIXTURES_DIR, 'hand-authored-reading-app.json'), 'utf8'),
);

function makeProvider(config = {}) {
  const provider = new ReplayProvider({
    config: {
      targetModel: TARGET,
      fixturePath: 'fixtures/hand-authored-reading-app.json',
      basePath: path.resolve(__dirname, '..'),
      ...config,
    },
  });
  provider._ensureProviders = async () => {};
  return provider;
}

// A recording listener stub (same approach as reduced-role.test.js) plus a
// tripwire simulator: replay must never make a simulator call.
function wireStubs(provider, output = 'REFLECTION') {
  const calls = [];
  provider._listener = {
    calls,
    callApi: async (promptStr, context) => {
      calls.push({ promptStr, context });
      return { output, tokenUsage: { total: 7 }, cost: 0.001 };
    },
  };
  provider._simulator = {
    callApi: async () => {
      throw new Error('replay must NEVER call the simulator — the fixture is the thinker');
    },
  };
  return calls;
}

// The prompt template still carries the scenario starting_turn; replay must
// ignore it (the fixture replaces the whole thinker side).
const PROMPT = JSON.stringify([
  { role: 'system', content: 'LISTENER SYSTEM' },
  { role: 'user', content: 'SCENARIO STARTING TURN — MUST NOT APPEAR' },
]);

test('the fixture drives every thinker turn verbatim, with no simulator calls', async () => {
  const provider = makeProvider();
  const calls = wireStubs(provider);
  const resp = await provider.callApi(PROMPT, {});

  assert.ok(!resp.error, `replay should not error: ${resp.error}`);
  const thinkerLines = resp.output
    .split('\n\n')
    .filter((b) => b.startsWith('THINKER: '))
    .map((b) => b.slice('THINKER: '.length));
  assert.deepEqual(
    thinkerLines,
    READING_APP.utterances.map((u) => u.text),
    'thinker turns are the fixture utterances, in order, byte for byte',
  );
  assert.ok(
    !resp.output.includes('SCENARIO STARTING TURN'),
    'the scenario starting turn must not leak into a replay transcript',
  );
  // One listener response per utterance, each with full history.
  assert.equal(calls.length, READING_APP.utterances.length);
  const lastMessages = JSON.parse(calls.at(-1).promptStr);
  assert.equal(lastMessages[0].role, 'system');
  assert.equal(lastMessages[0].content, 'LISTENER SYSTEM');
});

test('the transcript matches the multi-turn contract: marker once, at the fixture landing', async () => {
  const provider = makeProvider();
  wireStubs(provider, 'What replaces the streak as the reason to come back?');
  const resp = await provider.callApi(PROMPT, {});
  const blocks = resp.output.split('\n\n');

  const markerAt = blocks.indexOf(LANDING_MARKER);
  assert.notEqual(markerAt, -1, 'transcript must carry the landing marker');
  assert.equal(blocks.filter((b) => b === LANDING_MARKER).length, 1, 'exactly one marker');
  // The fixture lands on its last utterance: the block before the marker is
  // that thinker turn, the block after is the listener's post-landing window.
  assert.equal(
    blocks[markerAt - 1],
    `THINKER: ${READING_APP.utterances.at(-1).text}`,
  );
  assert.match(blocks[markerAt + 1], /^LISTENER: /);
  assert.equal(
    blocks.slice(markerAt + 1).filter((b) => b.startsWith('THINKER: ')).length,
    0,
    'no thinker turn follows the landing when the fixture lands on its last utterance',
  );
});

test('an explicit landingIndex anchors the marker mid-session', async () => {
  const provider = makeProvider();
  wireStubs(provider);
  // Seam: inject a fixture that lands on utterance 1 of 3.
  provider._fixture = {
    schemaVersion: 1,
    session: { id: 's', date: '2026-07-25T00:00:00Z', source: 'hand-authored' },
    utterances: [{ text: 'first' }, { text: 'the landing turn' }, { text: 'a postscript' }],
    landingIndex: 1,
  };
  const resp = await provider.callApi(PROMPT, {});
  const blocks = resp.output.split('\n\n');
  const markerAt = blocks.indexOf(LANDING_MARKER);
  assert.equal(blocks[markerAt - 1], 'THINKER: the landing turn');
});

test('the marker never reaches the listener', async () => {
  const provider = makeProvider();
  const calls = wireStubs(provider);
  const resp = await provider.callApi(PROMPT, {});
  assert.ok(resp.output.includes(LANDING_MARKER), 'the judges do see it');
  for (const c of calls) {
    assert.ok(
      !c.promptStr.includes(LANDING_MARKER),
      'the marker is a format-time annotation — the listener must hear the landing in the thinker’s words',
    );
  }
});

test('metadata reports the loop like multi-turn, plus fixture provenance', async () => {
  const provider = makeProvider();
  wireStubs(provider);
  const resp = await provider.callApi(PROMPT, {});
  const n = READING_APP.utterances.length;
  assert.equal(resp.metadata.thinkerTurns, n);
  assert.equal(resp.metadata.listenerTurns, n);
  assert.equal(resp.metadata.turns, 2 * n);
  assert.equal(resp.metadata.listenerModelCalls, n, 'no gate → every turn hits the model');
  assert.deepEqual(resp.metadata.fixture, {
    path: 'fixtures/hand-authored-reading-app.json',
    id: READING_APP.session.id,
    source: READING_APP.session.source,
  });
});

test('gate mode: light captured turns are acked with NO model call', async () => {
  const provider = makeProvider({ gate: true });
  const calls = wireStubs(provider, 'a substantive reflection');
  const resp = await provider.callApi(PROMPT, {});
  assert.ok(!resp.error, `replay should not error: ${resp.error}`);

  // The reading-app fixture has exactly one light turn ("and uh," — trailing
  // comma, the gate's hold cue); every other utterance is substantive. This is
  // the point of replay + gate: real disfluent turns give the gate something
  // to ack, unlike the clean-prose simulator (the 4/4 finding).
  const light = READING_APP.utterances.filter((u) => !shouldEscalate(u.text));
  assert.equal(light.length, 1, 'fixture sanity: one gate-light utterance');
  assert.equal(
    resp.metadata.listenerModelCalls,
    READING_APP.utterances.length - 1,
    'the light turn records zero model calls',
  );
  assert.equal(calls.length, READING_APP.utterances.length - 1);

  const listenerLines = resp.output
    .split('\n\n')
    .filter((b) => b.startsWith('LISTENER: '))
    .map((b) => b.slice('LISTENER: '.length));
  assert.equal(listenerLines.filter((l) => ACK_SET.has(l)).length, 1, 'the acked turn is a minimal ack');
});

test('gate mode with an all-light fixture records zero model calls', async () => {
  const provider = makeProvider({ gate: true });
  const calls = wireStubs(provider);
  provider._fixture = {
    schemaVersion: 1,
    session: { id: 's', date: '2026-07-25T00:00:00Z', source: 'hand-authored' },
    utterances: [{ text: 'um so,' }, { text: 'yeah the thing is,' }, { text: 'hm' }],
  };
  const resp = await provider.callApi(PROMPT, {});
  assert.equal(resp.metadata.listenerModelCalls, 0, 'gate handled every turn');
  assert.equal(calls.length, 0, 'listener model never invoked');
});

test('a schema-invalid fixture fails loudly instead of replaying garbage', async () => {
  const provider = makeProvider({ fixturePath: 'does-not-exist.json' });
  wireStubs(provider);
  const missing = await provider.callApi(PROMPT, {});
  assert.ok(missing.error, 'a missing fixture file is an error result');

  const invalid = makeProvider();
  wireStubs(invalid);
  invalid._fixture = null;
  invalid._loadFixture = () => {
    throw new Error('replay provider: fixture x fails schema check:\n  utterances must be a non-empty array');
  };
  const resp = await invalid.callApi(PROMPT, {});
  assert.match(resp.error, /fails schema check/);
});

test('a prompt without a system message is an error; fixturePath is required', async () => {
  const provider = makeProvider();
  wireStubs(provider);
  const resp = await provider.callApi(JSON.stringify([{ role: 'user', content: 'hi' }]), {});
  assert.match(resp.error, /system message/);

  assert.throws(
    () => new ReplayProvider({ config: { targetModel: TARGET } }),
    /fixturePath is required/,
  );
});

// Guard: the module path is what the config references.
test('replay provider module is at the path the config loads', () => {
  const resolved = require.resolve('../providers/replay.js');
  assert.equal(path.basename(resolved), 'replay.js');
});
