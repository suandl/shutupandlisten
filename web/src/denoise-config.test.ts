// Tests for the live denoise config resolver (denoise-config.ts).
//
// Out-of-the-box the harness wires the self-hosted same-origin engine (a
// provisioned deploy denoises immediately; an un-provisioned one degrades to
// passthrough inside the adapter). The logic was split out of the DOM-coupled
// main.ts precisely so these guarantees are unit-testable headlessly —
// `resolveDenoiseOptions` is pure, taking the page's `location.search` /
// `location.href` as arguments.
//
// The guarantees under test:
//   1. default (no query) → the self-hosted engine, resolved same-origin
//   2. `?denoise=off` (and aliases) → { disabled: true } → passthrough kill-switch
//   3. a remote `?denoiseEngine=` is rejected back to the safe default, never
//      imported as code on mic audio (same guard as ?sttEngine=)
//   4. a same-origin override retunes without a code edit; empty falls back
//   5. off short-circuits before any engine override

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDenoiseOptions } from './denoise-config.ts';
import { DEFAULT_DENOISE_ENGINE_URL } from './denoise.ts';

const PAGE = 'https://app.example/turn-detector/index.html';
const DEFAULT_ENGINE_RESOLVED = new URL(DEFAULT_DENOISE_ENGINE_URL, PAGE).href;
const qs = (params: Record<string, string>): string => new URLSearchParams(params).toString();

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

test('default (no query) → the self-hosted engine, resolved same-origin', () => {
  const opts = resolveDenoiseOptions('', PAGE);
  assert.equal(opts.engineUrl, DEFAULT_ENGINE_RESOLVED);
  assert.equal(opts.disabled, undefined);
});

test('the default engine resolves to an absolute same-origin URL', () => {
  const opts = resolveDenoiseOptions('', PAGE);
  assert.ok(opts.engineUrl);
  assert.equal(new URL(opts.engineUrl).origin, new URL(PAGE).origin);
});

test('?denoise=off (and aliases) → disabled passthrough, no engine', () => {
  for (const v of ['off', 'passthrough', 'none', '0', 'false', 'no', 'OFF', ' Off ']) {
    const opts = resolveDenoiseOptions(qs({ denoise: v }), PAGE);
    assert.equal(opts.disabled, true, `?denoise=${v} should disable`);
    assert.equal(opts.engineUrl, undefined, `?denoise=${v} should not set an engine`);
  }
});

test('a same-origin ?denoiseEngine= override is honored and resolved absolute', () => {
  const opts = resolveDenoiseOptions(qs({ denoiseEngine: '/custom/denoise.js' }), PAGE);
  assert.equal(opts.engineUrl, new URL('/custom/denoise.js', PAGE).href);
});

test('a remote ?denoiseEngine= override is rejected back to the safe default and warns', () => {
  const { result, warnings } = captureWarn(() =>
    resolveDenoiseOptions(qs({ denoiseEngine: 'https://evil.example/denoise.js' }), PAGE),
  );
  assert.equal(result.engineUrl, DEFAULT_ENGINE_RESOLVED);
  assert.equal(warnings.length, 1, 'an unsafe override must warn exactly once');
  assert.match(warnings[0], /same-origin/);
});

test('an empty ?denoiseEngine= falls back to the default without warning', () => {
  const { result, warnings } = captureWarn(() =>
    resolveDenoiseOptions(qs({ denoiseEngine: '' }), PAGE),
  );
  assert.equal(result.engineUrl, DEFAULT_ENGINE_RESOLVED);
  assert.equal(warnings.length, 0);
});

test('?denoise=off short-circuits before any engine override', () => {
  const opts = resolveDenoiseOptions(qs({ denoise: 'off', denoiseEngine: '/custom/denoise.js' }), PAGE);
  assert.equal(opts.disabled, true);
  assert.equal(opts.engineUrl, undefined, 'off wins: no engine is resolved');
});
