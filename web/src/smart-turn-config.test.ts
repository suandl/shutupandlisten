// Tests for the live smart-turn config resolver (smart-turn-config.ts).
//
// Out-of-the-box the harness wires the self-hosted same-origin classifier (a
// provisioned deploy classifies immediately; an un-provisioned one degrades to the
// labelled duration heuristic inside the adapter). Before su-lou.10.1 NOTHING wired
// a model URL at all, so the heuristic ran in every session — the default-on wiring
// asserted here is the fix, and this is where a regression to "no model configured"
// gets caught headlessly.
//
// The guarantees under test:
//   1. default (no query) → the self-hosted model, resolved same-origin
//   2. `?smartTurn=off` (and aliases) → {} → the heuristic kill-switch
//   3. a remote `?smartTurnModel=` is rejected back to the safe default — the model
//      is fetched and run on mic audio, so it is held to the engine-URL rule
//   4. a same-origin override retunes without a code edit; empty falls back
//   5. off short-circuits before any model override

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSmartTurnOptions } from './smart-turn-config.ts';
import { DEFAULT_SMART_TURN_MODEL_URL } from './smart-turn.ts';

const PAGE = 'https://app.example/turn-detector/index.html';
const DEFAULT_MODEL_RESOLVED = new URL(DEFAULT_SMART_TURN_MODEL_URL, PAGE).href;
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

test('default (no query) → the self-hosted model, resolved same-origin', () => {
  const opts = resolveSmartTurnOptions('', PAGE);
  assert.equal(opts.modelUrl, DEFAULT_MODEL_RESOLVED);
  assert.equal(new URL(opts.modelUrl!).origin, new URL(PAGE).origin);
});

test('?smartTurn=off (and aliases) → no model, so the adapter uses the heuristic', () => {
  for (const v of ['off', 'heuristic', 'none', '0', 'false', 'no', 'OFF', ' Off ']) {
    const opts = resolveSmartTurnOptions(qs({ smartTurn: v }), PAGE);
    assert.equal(opts.modelUrl, undefined, `?smartTurn=${v} should not configure a model`);
  }
});

test('a same-origin ?smartTurnModel= override is honoured', () => {
  const opts = resolveSmartTurnOptions(qs({ smartTurnModel: '/smart-turn/experimental.onnx' }), PAGE);
  assert.equal(opts.modelUrl, new URL('/smart-turn/experimental.onnx', PAGE).href);
});

test('a cross-origin ?smartTurnModel= is rejected back to the safe default, with a warning', () => {
  for (const bad of ['https://evil.example/model.onnx', 'blob:https://app.example/abc', 'data:application/octet-stream,x']) {
    const { result, warnings } = captureWarn(() => resolveSmartTurnOptions(qs({ smartTurnModel: bad }), PAGE));
    assert.equal(result.modelUrl, DEFAULT_MODEL_RESOLVED, `${bad} must not be loaded`);
    assert.equal(warnings.length, 1, `${bad} should warn exactly once`);
    assert.match(warnings[0], /same-origin/);
  }
});

test('an empty ?smartTurnModel= falls back to the default rather than disabling', () => {
  const opts = resolveSmartTurnOptions('smartTurnModel=', PAGE);
  assert.equal(opts.modelUrl, DEFAULT_MODEL_RESOLVED);
});

test('?smartTurn=off wins over a model override', () => {
  const opts = resolveSmartTurnOptions(qs({ smartTurn: 'off', smartTurnModel: '/smart-turn/other.onnx' }), PAGE);
  assert.equal(opts.modelUrl, undefined);
});
