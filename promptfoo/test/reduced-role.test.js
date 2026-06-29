// Reduced-role gate behaviour — keyless, no model, no promptfoo runtime.
//
// Covers the U2 test scenario: "a turn the gate answers with a natural ack
// makes no model call" (and, structurally, why restraint.txt scores that turn
// at max — the ack is a short, minimal acknowledgment). Also pins the
// escalation path and the loop-level "model stays out of most turns" signal.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ReducedRoleProvider = require('../providers/reduced-role.js');

const TARGET = 'ollama:chat:llama3.2:3b';
const ACK_SET = new Set(['mm', 'yeah', 'mhm', 'right', 'mm-hm']);

function makeProvider(config = {}) {
  return new ReducedRoleProvider({ config: { targetModel: TARGET, ...config } });
}

// A recording listener stub: counts calls and returns a fixed reflection.
function recordingListener(output = 'REFLECTION') {
  const calls = [];
  return {
    calls,
    callApi: async (promptStr, context) => {
      calls.push({ promptStr, context });
      return { output, tokenUsage: { total: 7 }, cost: 0.001 };
    },
  };
}

test('light turns are answered by a minimal ack with NO model call', async () => {
  const provider = makeProvider();
  // If the gate ever reached the model, this stub would record a call.
  const listener = recordingListener();
  provider._listener = listener;

  const lightTurns = ['…yeah', 'mm, I don’t know', 'and then,', 'huh'];
  for (let i = 0; i < lightTurns.length; i += 1) {
    const result = await provider._listenerTurn({
      listenerSystem: 'SYS',
      transcript: [{ role: 'user', content: lightTurns[i] }],
      context: {},
      turn: i,
    });
    assert.equal(result.modelCalled, false, `turn ${i} should not call the model`);
    assert.ok(ACK_SET.has(result.text), `"${result.text}" should be a known minimal ack`);
    // Max-restraint material: restraint.txt scores 5 for short, minimal
    // acknowledgment. Acks are <= 5 chars and carry no banned-phrase prose.
    assert.ok(result.text.length <= 5, `ack "${result.text}" should be short`);
  }
  assert.equal(listener.calls.length, 0, 'no model calls for any light turn');
});

test('an explicit question escalates to the model', async () => {
  const provider = makeProvider();
  const listener = recordingListener('a brief reflection');
  provider._listener = listener;

  const result = await provider._listenerTurn({
    listenerSystem: 'SYS',
    transcript: [{ role: 'user', content: 'but it’s not that bad, right?' }],
    context: {},
    turn: 1,
  });
  assert.equal(result.modelCalled, true);
  assert.equal(result.text, 'a brief reflection');
  assert.equal(listener.calls.length, 1, 'exactly one model call for the substantive turn');
});

test('a substantive (long, non-trailing) turn escalates to the model', async () => {
  const provider = makeProvider();
  const listener = recordingListener();
  provider._listener = listener;

  const longThought =
    'I keep coming back to this one decision and I genuinely cannot tell ' +
    'if I am avoiding it or just being careful about it';
  const result = await provider._listenerTurn({
    listenerSystem: 'SYS',
    transcript: [{ role: 'user', content: longThought }],
    context: {},
    turn: 0,
  });
  assert.equal(result.modelCalled, true);
  assert.equal(listener.calls.length, 1);
});

test('the gateSubstantiveWords threshold is honoured and configurable', () => {
  const text = 'one two three four five six seven eight'; // 8 words, no '?'
  assert.equal(makeProvider()._shouldEscalate(text), false, '8 words < default 12 → ack');
  assert.equal(
    makeProvider({ gateSubstantiveWords: 5 })._shouldEscalate(text),
    true,
    '8 words >= configured 5 → escalate',
  );
});

test('full loop: reduced-role keeps the model out of light turns', async () => {
  const provider = makeProvider({ maxTurns: 3 });
  // Hermetic: stub provider wiring and the simulator-system file read.
  provider._ensureProviders = async () => {};
  provider._loadSimulatorSystem = () => 'SIMULATOR SYSTEM';

  const listener = recordingListener('REFLECTION');
  // Simulator always emits a short trailing-off turn → every listener turn acks.
  const simulator = {
    callApi: async () => ({ output: '…hm', tokenUsage: { total: 3 }, cost: 0 }),
  };
  provider._listener = listener;
  provider._simulator = simulator;

  const prompt = JSON.stringify([
    { role: 'system', content: 'LISTENER SYSTEM' },
    { role: 'user', content: 'short start' }, // 2 words → ack
  ]);
  const resp = await provider.callApi(prompt, {});

  assert.ok(!resp.error, `loop should not error: ${resp.error}`);
  assert.equal(resp.metadata.listenerTurns, 3, 'three listener turns');
  assert.equal(resp.metadata.listenerModelCalls, 0, 'zero model calls — gate handled all');
  assert.equal(listener.calls.length, 0, 'listener model never invoked');
  // Transcript is well-formed and every LISTENER line is a minimal ack.
  const listenerLines = resp.output
    .split('\n\n')
    .filter((l) => l.startsWith('LISTENER: '))
    .map((l) => l.slice('LISTENER: '.length));
  assert.equal(listenerLines.length, 3);
  for (const line of listenerLines) {
    assert.ok(ACK_SET.has(line), `"${line}" should be a minimal ack`);
  }
});

test('full loop: a substantive thinker turn does reach the model', async () => {
  const provider = makeProvider({ maxTurns: 2 });
  provider._ensureProviders = async () => {};
  provider._loadSimulatorSystem = () => 'SIMULATOR SYSTEM';

  const listener = recordingListener('a momentum-preserving reflection');
  provider._listener = listener;
  provider._simulator = {
    callApi: async () => ({ output: '…yeah', tokenUsage: { total: 2 }, cost: 0 }),
  };

  // Starting turn is a real, substantive thought (>= 12 words) → escalates.
  const prompt = JSON.stringify([
    { role: 'system', content: 'LISTENER SYSTEM' },
    {
      role: 'user',
      content:
        'I think the thing I am circling is that I already know the answer ' +
        'and I am stalling because saying it makes it real',
    },
  ]);
  const resp = await provider.callApi(prompt, {});

  assert.ok(!resp.error, `loop should not error: ${resp.error}`);
  assert.ok(resp.metadata.listenerModelCalls >= 1, 'at least one model call');
  assert.ok(listener.calls.length >= 1, 'listener model invoked for the substantive turn');
});

// Guard: the module path is what the config references.
test('reduced-role provider module is at the path the config loads', () => {
  const resolved = require.resolve('../providers/reduced-role.js');
  assert.equal(path.basename(resolved), 'reduced-role.js');
});
