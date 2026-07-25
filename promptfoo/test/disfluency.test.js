// Disfluency layer — keyless, no model, no promptfoo runtime.
//
// The layer exists to remove the clean-text upper bound (findings §5–6), and
// its whole value rests on two properties these tests pin:
//
//   * DETERMINISM — same (text, seed, level) → same output, byte for byte, so
//     a disfluent cell is reproducible and a score delta between runs can
//     never be "the noise rolled differently". No Math.random anywhere.
//   * NO SEMANTIC DAMAGE — noise only. Every original word survives, in
//     order; the judges score the listener against what the thinker SAID, so
//     a transform that changed the saying would make the scores unreadable.
//
// Plus the provider wiring contract: the option is opt-in, ABSENT MEANS OFF,
// and off is byte-for-byte identical to before the option existed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyDisfluency, resolveLevel, LEVELS } = require('../lib/disfluency.js');
const MultiTurnProvider = require('../providers/multi-turn.js');
const { THINKER_TURNS } = require('./fixtures/transcripts.js');

// A realistic multi-sentence paragraph (the grocery-app dictation) — long
// enough that two seeds colliding on identical output is effectively
// impossible, and punctuated enough to exercise every transformation.
const CLEAN = THINKER_TURNS.join(' ');

// Lowercase and strip punctuation so "Meals," and "meals" compare equal — the
// transform is allowed to touch case and punctuation, never the word.
function normalizedWords(text) {
  return String(text)
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}'’%-]/gu, ''))
    .filter(Boolean);
}

// Is `needle` a subsequence of `haystack`?
function isSubsequence(needle, haystack) {
  let i = 0;
  for (const w of haystack) {
    if (i < needle.length && w === needle[i]) i += 1;
  }
  return i === needle.length;
}

test('same (text, seed, level) → same output, byte for byte', () => {
  const a = applyDisfluency(CLEAN, { seed: 42, level: 'medium' });
  const b = applyDisfluency(CLEAN, { seed: 42, level: 'medium' });
  assert.equal(a, b);
});

test('a different seed rolls different noise', () => {
  const a = applyDisfluency(CLEAN, { seed: 42, level: 'medium' });
  const b = applyDisfluency(CLEAN, { seed: 43, level: 'medium' });
  assert.notEqual(a, b);
});

test('level 0 is the identity — the exact input string comes back', () => {
  assert.equal(applyDisfluency(CLEAN, { seed: 42, level: 0 }), CLEAN);
  // Empty/whitespace input passes through untouched at any level.
  assert.equal(applyDisfluency('', { seed: 1, level: 'heavy' }), '');
  assert.equal(applyDisfluency('   ', { seed: 1, level: 'heavy' }), '   ');
});

test('no semantic damage: every original word survives, in order', () => {
  for (const level of ['light', 'medium', 'heavy']) {
    for (const seed of [1, 42, 1337]) {
      const noisy = applyDisfluency(CLEAN, { seed, level });
      assert.ok(
        isSubsequence(normalizedWords(CLEAN), normalizedWords(noisy)),
        `original words must be a subsequence of the ${level}/seed=${seed} output`,
      );
    }
  }
});

test('heavy noise strips most terminal punctuation and lowers sentence starts', () => {
  const noisy = applyDisfluency(CLEAN, { seed: 7, level: 'heavy' });
  const countDots = (s) => (s.match(/\./g) || []).length;
  assert.ok(
    countDots(noisy) < countDots(CLEAN),
    `expected fewer periods after heavy noise (${countDots(noisy)} vs ${countDots(CLEAN)})`,
  );
  // The paragraph's original sentence-initial capitals mostly disappear —
  // check the very first word, which always starts a sentence.
  assert.match(noisy, /^[a-z]/, 'the opening sentence start should be lowercased at heavy');
  // And it got longer: fillers/restarts insert words, nothing deletes them.
  assert.ok(
    normalizedWords(noisy).length > normalizedWords(CLEAN).length,
    'noise inserts fillers/restarts, so the word count grows',
  );
});

test('level names resolve and typos fail loudly', () => {
  assert.equal(resolveLevel('light'), LEVELS.light);
  assert.equal(resolveLevel('MEDIUM'), LEVELS.medium);
  assert.equal(resolveLevel(0.4), 0.4);
  assert.equal(resolveLevel(undefined), LEVELS.medium, 'level defaults to medium');
  assert.throws(() => resolveLevel('mediun'), /unknown level/);
  assert.throws(() => resolveLevel(1.5), /must be in \[0, 1\]/);
});

// ---- provider wiring -------------------------------------------------------

// A stubbed multi-turn run (same approach as landing-phase.test.js): silent
// listener, fixed clean simulator turns, so the only variable is whether the
// disfluency layer touched the thinker text.
function stubRun(config = {}) {
  const provider = new MultiTurnProvider({
    config: { targetModel: 'openai:gpt-4o', maxTurns: 3, ...config },
  });
  provider._ensureProviders = async () => {};
  provider._loadSimulatorSystem = () => 'SIMULATOR SYSTEM';

  const listenerPrompts = [];
  provider._listener = {
    callApi: async (promptStr) => {
      listenerPrompts.push(promptStr);
      return { output: '', tokenUsage: { total: 1 }, cost: 0 };
    },
  };
  provider._simulator = {
    callApi: async () => ({
      output: 'The queue re-sorts overnight. Staples never move, only perishables do.',
      tokenUsage: { total: 1 },
      cost: 0,
    }),
  };

  const prompt = JSON.stringify([
    { role: 'system', content: 'LISTENER SYSTEM' },
    { role: 'user', content: THINKER_TURNS[0] },
  ]);
  return { provider, prompt, listenerPrompts };
}

function thinkerLines(output) {
  return output
    .split('\n\n')
    .filter((b) => b.startsWith('THINKER: '))
    .map((b) => b.slice('THINKER: '.length));
}

test('absent disfluency config leaves the transcript byte-for-byte untouched', async () => {
  const { provider, prompt } = stubRun();
  const resp = await provider.callApi(prompt, {});
  assert.ok(!resp.error, `loop should not error: ${resp.error}`);
  const lines = thinkerLines(resp.output);
  assert.equal(lines[0], THINKER_TURNS[0], 'starting turn is verbatim');
  assert.equal(
    lines[1],
    'The queue re-sorts overnight. Staples never move, only perishables do.',
    'simulator turns are verbatim',
  );
  assert.equal(resp.metadata.disfluency, undefined, 'no noise → no noise metadata');
});

test('with disfluency on, judges score exactly what the listener saw', async () => {
  const { provider, prompt, listenerPrompts } = stubRun({
    disfluency: { seed: 42, level: 'medium' },
  });
  const resp = await provider.callApi(prompt, {});
  assert.ok(!resp.error, `loop should not error: ${resp.error}`);

  const lines = thinkerLines(resp.output);
  // The starting turn is transformed too — a disfluent cell never shows the
  // listener a line of clean prose.
  assert.notEqual(lines[0], THINKER_TURNS[0], 'starting turn is transformed');
  assert.ok(
    isSubsequence(normalizedWords(THINKER_TURNS[0]), normalizedWords(lines[0])),
    'transformed starting turn keeps every original word in order',
  );

  // Every thinker message the listener actually received appears verbatim in
  // the transcript the judges read — one text, not two diverging copies.
  const lastListenerCall = JSON.parse(listenerPrompts.at(-1));
  const sentThinkerTexts = lastListenerCall
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content.split('\n\n'));
  for (const line of lines) {
    assert.ok(
      sentThinkerTexts.includes(line),
      'each transcript THINKER line must be exactly what the listener was sent',
    );
  }

  // The seed is reported, so the transcript is traceable back to its noise.
  assert.deepEqual(resp.metadata.disfluency, { seed: 42, level: 'medium' });
});

test('the same seed reproduces the same disfluent run end-to-end', async () => {
  const first = stubRun({ disfluency: { seed: 7, level: 'heavy' } });
  const second = stubRun({ disfluency: { seed: 7, level: 'heavy' } });
  const a = await first.provider.callApi(first.prompt, {});
  const b = await second.provider.callApi(second.prompt, {});
  assert.equal(a.output, b.output, 'identical seeds → identical transcripts');

  const third = stubRun({ disfluency: { seed: 8, level: 'heavy' } });
  const c = await third.provider.callApi(third.prompt, {});
  assert.notEqual(a.output, c.output, 'a different seed → a different transcript');
});

test('a typo’d level fails at construction, not mid-eval', () => {
  assert.throws(
    () =>
      new MultiTurnProvider({
        config: { targetModel: 'openai:gpt-4o', disfluency: { seed: 1, level: 'mediun' } },
      }),
    /unknown level/,
  );
});
