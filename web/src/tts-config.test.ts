// Tests for the live TTS config resolver (tts-config.ts) — the U6 mirror of
// stt-config.test.ts / listener-config.test.ts.
//
// The guarantees under test:
//   1. default (no query) → self-hosted engine + the model default (real voice on)
//   2. `?tts=off` (and aliases) → {} → the placeholder tone (operator A/B kill-switch)
//   3. a remote `?ttsEngine=` is rejected back to the safe default, never imported
//      as code that voices the reply (su-0hi #1)
//   4. model/engine query overrides retune without a code edit; empty falls back

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTtsOptions } from './tts-config.ts';
import { DEFAULT_TTS_ENGINE_URL, DEFAULT_TTS_MODEL } from './tts.ts';

const PAGE = 'https://app.example/turn-detector/index.html';
const DEFAULT_ENGINE_RESOLVED = new URL(DEFAULT_TTS_ENGINE_URL, PAGE).href;

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** Run `fn` with console.warn captured (the resolver warns on an unsafe override). */
function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test('default (no query) → self-hosted engine + model default (real voice on)', () => {
  assert.deepEqual(resolveTtsOptions('', PAGE), {
    engineUrl: DEFAULT_ENGINE_RESOLVED,
    model: DEFAULT_TTS_MODEL,
  });
});

test('the engine default resolves to the committed same-origin wrapper', () => {
  const { engineUrl } = resolveTtsOptions('', PAGE);
  assert.equal(new URL(engineUrl!).origin, new URL(PAGE).origin);
  assert.equal(new URL(engineUrl!).pathname, '/tts-engine.js');
});

test('?tts=off and its aliases force the placeholder tone ({})', () => {
  for (const v of ['off', 'stub', 'none', '0', 'false', 'no', 'OFF', ' Off ', 'NONE']) {
    assert.deepEqual(
      resolveTtsOptions(qs({ tts: v }), PAGE),
      {},
      `tts=${JSON.stringify(v)} should degrade to the placeholder tone`,
    );
  }
});

test('a non-off ?tts= value leaves the real voice enabled', () => {
  assert.deepEqual(resolveTtsOptions(qs({ tts: 'on' }), PAGE), {
    engineUrl: DEFAULT_ENGINE_RESOLVED,
    model: DEFAULT_TTS_MODEL,
  });
});

test('a same-origin ?ttsEngine= override is honoured (resolved absolute)', () => {
  const { result, warnings } = captureWarn(() =>
    resolveTtsOptions(qs({ ttsEngine: '/vendor/tts.js' }), PAGE),
  );
  assert.equal(result.engineUrl, 'https://app.example/vendor/tts.js');
  assert.deepEqual(warnings, [], 'a safe override must not warn');
});

test('a remote ?ttsEngine= override is rejected back to the safe default and warns', () => {
  const { result, warnings } = captureWarn(() =>
    resolveTtsOptions(qs({ ttsEngine: 'https://evil.example/tts.js' }), PAGE),
  );
  assert.equal(result.engineUrl, DEFAULT_ENGINE_RESOLVED);
  assert.equal(warnings.length, 1, 'an unsafe override must warn exactly once');
  assert.match(warnings[0], /same-origin/);
});

test('the model override retunes without a code edit', () => {
  const o = resolveTtsOptions(qs({ ttsModel: 'org/my-tiny-voice' }), PAGE);
  assert.equal(o.model, 'org/my-tiny-voice');
});

test('an empty model query value falls back to the default (|| not ??)', () => {
  const o = resolveTtsOptions(qs({ ttsModel: '' }), PAGE);
  assert.equal(o.model, DEFAULT_TTS_MODEL);
});

test('off short-circuits before any engine/model override is considered', () => {
  assert.deepEqual(
    resolveTtsOptions(qs({ tts: 'off', ttsEngine: '/vendor/tts.js', ttsModel: 'x' }), PAGE),
    {},
  );
});
