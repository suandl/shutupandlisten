// Tests for the live listener-LLM config resolver (listener-config.ts) — the U5
// mirror of stt-config.test.ts.
//
// The guarantees under test:
//   1. default (no query) → self-hosted engine + the model default (real listener on)
//   2. `?llm=off` (and aliases) → {} → the labelled stub (operator A/B kill-switch)
//   3. a remote `?llmEngine=` is rejected back to the safe default, never imported
//      as code on the thinker's words (su-0hi #1)
//   4. model/engine query overrides retune without a code edit; empty falls back

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveListenerOptions } from './listener-config.ts';
import { DEFAULT_LLM_ENGINE_URL, DEFAULT_LLM_MODEL } from './listener.ts';

const PAGE = 'https://app.example/turn-detector/index.html';
const DEFAULT_ENGINE_RESOLVED = new URL(DEFAULT_LLM_ENGINE_URL, PAGE).href;

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

test('default (no query) → self-hosted engine + model default (real listener on)', () => {
  assert.deepEqual(resolveListenerOptions('', PAGE), {
    engineUrl: DEFAULT_ENGINE_RESOLVED,
    model: DEFAULT_LLM_MODEL,
  });
});

test('the engine default resolves to the committed same-origin wrapper', () => {
  const { engineUrl } = resolveListenerOptions('', PAGE);
  assert.equal(new URL(engineUrl!).origin, new URL(PAGE).origin);
  assert.equal(new URL(engineUrl!).pathname, '/llm-engine.js');
});

test('?llm=off and its aliases force the labelled stub ({})', () => {
  for (const v of ['off', 'stub', 'none', '0', 'false', 'no', 'OFF', ' Off ', 'NONE']) {
    assert.deepEqual(
      resolveListenerOptions(qs({ llm: v }), PAGE),
      {},
      `llm=${JSON.stringify(v)} should degrade to the stub`,
    );
  }
});

test('a non-off ?llm= value leaves the real listener enabled', () => {
  assert.deepEqual(resolveListenerOptions(qs({ llm: 'on' }), PAGE), {
    engineUrl: DEFAULT_ENGINE_RESOLVED,
    model: DEFAULT_LLM_MODEL,
  });
});

test('a same-origin ?llmEngine= override is honoured (resolved absolute)', () => {
  const { result, warnings } = captureWarn(() =>
    resolveListenerOptions(qs({ llmEngine: '/vendor/llm.js' }), PAGE),
  );
  assert.equal(result.engineUrl, 'https://app.example/vendor/llm.js');
  assert.deepEqual(warnings, [], 'a safe override must not warn');
});

test('a remote ?llmEngine= override is rejected back to the safe default and warns', () => {
  const { result, warnings } = captureWarn(() =>
    resolveListenerOptions(qs({ llmEngine: 'https://evil.example/llm.js' }), PAGE),
  );
  assert.equal(result.engineUrl, DEFAULT_ENGINE_RESOLVED);
  assert.equal(warnings.length, 1, 'an unsafe override must warn exactly once');
  assert.match(warnings[0], /same-origin/);
});

test('the model override retunes without a code edit', () => {
  const o = resolveListenerOptions(qs({ llmModel: 'org/my-tiny-instruct' }), PAGE);
  assert.equal(o.model, 'org/my-tiny-instruct');
});

test('an empty model query value falls back to the default (|| not ??)', () => {
  const o = resolveListenerOptions(qs({ llmModel: '' }), PAGE);
  assert.equal(o.model, DEFAULT_LLM_MODEL);
});

test('off short-circuits before any engine/model override is considered', () => {
  assert.deepEqual(
    resolveListenerOptions(qs({ llm: 'off', llmEngine: '/vendor/llm.js', llmModel: 'x' }), PAGE),
    {},
  );
});
