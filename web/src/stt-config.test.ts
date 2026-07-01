// Tests for the live STT config resolver (stt-config.ts).
//
// This is the U4 tuning-pass contract: out-of-the-box the harness wires the
// self-hosted same-origin engine + the Moonshine/Whisper defaults (a provisioned
// deploy transcribes immediately; an un-provisioned one degrades to the labelled
// stub). The logic was split out of the DOM-coupled main.ts precisely so these
// guarantees are unit-testable headlessly — `resolveSttOptions` is pure, taking
// the page's `location.search` / `location.href` as arguments.
//
// The guarantees under test:
//   1. default (no query) → self-hosted engine + both model defaults (real STT on)
//   2. `?stt=off` (and aliases) → {} → the labelled stub (operator A/B kill-switch)
//   3. a remote `?sttEngine=` is rejected back to the safe default, never imported
//      as code on mic audio (su-0hi #1)
//   4. model/engine query overrides retune without a code edit; empty falls back

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSttOptions } from './stt-config.ts';
import {
  DEFAULT_STT_ENGINE_URL,
  DEFAULT_MOONSHINE_MODEL,
  DEFAULT_WHISPER_MODEL,
} from './stt.ts';

const PAGE = 'https://app.example/turn-detector/index.html';
// The default engine path resolved against the page origin — what the same-origin
// guard returns for the (already same-origin) default. Computed, not hardcoded, so
// the test tracks DEFAULT_STT_ENGINE_URL if it moves.
const DEFAULT_ENGINE_RESOLVED = new URL(DEFAULT_STT_ENGINE_URL, PAGE).href;

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

test('default (no query) → self-hosted engine + Moonshine/Whisper defaults (real STT on)', () => {
  assert.deepEqual(resolveSttOptions('', PAGE), {
    engineUrl: DEFAULT_ENGINE_RESOLVED,
    moonshineModel: DEFAULT_MOONSHINE_MODEL,
    whisperModel: DEFAULT_WHISPER_MODEL,
  });
});

test('the engine default resolves to the committed same-origin wrapper', () => {
  // Guards the no-egress posture: the default engine module is served from the
  // app's own origin, never a third party.
  const { engineUrl } = resolveSttOptions('', PAGE);
  assert.equal(new URL(engineUrl!).origin, new URL(PAGE).origin);
  assert.equal(new URL(engineUrl!).pathname, '/stt-engine.js');
});

test('?stt=off and its aliases force the labelled stub ({})', () => {
  for (const v of ['off', 'stub', 'none', '0', 'false', 'no', 'OFF', ' Off ', 'NONE']) {
    assert.deepEqual(
      resolveSttOptions(qs({ stt: v }), PAGE),
      {},
      `stt=${JSON.stringify(v)} should degrade to the stub`,
    );
  }
});

test('a non-off ?stt= value leaves real STT enabled', () => {
  // Only the explicit kill-switch values stub it out; anything else stays on.
  assert.deepEqual(resolveSttOptions(qs({ stt: 'on' }), PAGE), {
    engineUrl: DEFAULT_ENGINE_RESOLVED,
    moonshineModel: DEFAULT_MOONSHINE_MODEL,
    whisperModel: DEFAULT_WHISPER_MODEL,
  });
});

test('a same-origin ?sttEngine= override is honoured (resolved absolute)', () => {
  const { result, warnings } = captureWarn(() =>
    resolveSttOptions(qs({ sttEngine: '/vendor/engine.js' }), PAGE),
  );
  assert.equal(result.engineUrl, 'https://app.example/vendor/engine.js');
  assert.deepEqual(warnings, [], 'a safe override must not warn');
});

test('a remote ?sttEngine= override is rejected back to the safe default and warns', () => {
  // The worker import()s this URL and feeds it live mic audio — a cross-origin
  // module would run attacker code on user speech (su-0hi #1). It must NOT
  // silently disable STT either: fall back to the same-origin default.
  const { result, warnings } = captureWarn(() =>
    resolveSttOptions(qs({ sttEngine: 'https://evil.example/engine.js' }), PAGE),
  );
  assert.equal(result.engineUrl, DEFAULT_ENGINE_RESOLVED);
  assert.equal(warnings.length, 1, 'an unsafe override must warn exactly once');
  assert.match(warnings[0], /same-origin/);
});

test('model overrides retune without a code edit (sttModel/sttFallback + aliases)', () => {
  const o = resolveSttOptions(
    qs({ sttModel: 'org/my-moonshine', sttFallback: 'org/my-whisper' }),
    PAGE,
  );
  assert.equal(o.moonshineModel, 'org/my-moonshine');
  assert.equal(o.whisperModel, 'org/my-whisper');
  // Aliases.
  const a = resolveSttOptions(qs({ moonshine: 'org/m2', whisper: 'org/w2' }), PAGE);
  assert.equal(a.moonshineModel, 'org/m2');
  assert.equal(a.whisperModel, 'org/w2');
});

test('the primary param wins over its alias', () => {
  const o = resolveSttOptions(
    qs({ sttModel: 'primary', moonshine: 'alias', sttFallback: 'primaryF', whisper: 'aliasF' }),
    PAGE,
  );
  assert.equal(o.moonshineModel, 'primary');
  assert.equal(o.whisperModel, 'primaryF');
});

test('an empty model query value falls back to the default (|| not ??)', () => {
  const o = resolveSttOptions(qs({ sttModel: '', sttFallback: '' }), PAGE);
  assert.equal(o.moonshineModel, DEFAULT_MOONSHINE_MODEL);
  assert.equal(o.whisperModel, DEFAULT_WHISPER_MODEL);
});

test('off short-circuits before any engine/model override is considered', () => {
  // Even with overrides present, the kill-switch yields the bare stub.
  assert.deepEqual(
    resolveSttOptions(qs({ stt: 'off', sttEngine: '/vendor/engine.js', sttModel: 'x' }), PAGE),
    {},
  );
});
