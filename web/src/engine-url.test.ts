// Regression: the STT engine module URL must be restricted to same-origin /
// self-hosted assets. The worker dynamic-import()s this URL and then feeds it
// live microphone audio, so a remote ?sttEngine= (a shared / mistyped link)
// must be rejected before it can run as code on real speech. (su-0hi #1)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeEngineUrl } from './engine-url.ts';

const PAGE = 'https://app.example/turn-detector/index.html';

test('rejects a remote-origin engine URL', () => {
  assert.equal(sanitizeEngineUrl('https://evil.example/engine.js', PAGE), undefined);
  assert.equal(sanitizeEngineUrl('http://evil.example/engine.js', PAGE), undefined);
  // Same host but a different scheme or port is still a different origin.
  assert.equal(sanitizeEngineUrl('http://app.example/engine.js', PAGE), undefined);
  assert.equal(sanitizeEngineUrl('https://app.example:8443/engine.js', PAGE), undefined);
});

test('rejects non-http(s) and opaque-origin schemes', () => {
  assert.equal(sanitizeEngineUrl('data:text/javascript,postMessage(0)', PAGE), undefined);
  assert.equal(sanitizeEngineUrl('blob:https://app.example/abc-123', PAGE), undefined);
  assert.equal(sanitizeEngineUrl('file:///etc/passwd', PAGE), undefined);
  assert.equal(sanitizeEngineUrl('javascript:postMessage(0)', PAGE), undefined);
});

test('accepts a same-origin absolute URL, normalised', () => {
  assert.equal(
    sanitizeEngineUrl('https://app.example/vendor/engine.js', PAGE),
    'https://app.example/vendor/engine.js',
  );
});

test('accepts a relative path, resolved against the page origin', () => {
  assert.equal(
    sanitizeEngineUrl('./vendor/engine.js', PAGE),
    'https://app.example/turn-detector/vendor/engine.js',
  );
  assert.equal(sanitizeEngineUrl('/vendor/engine.js', PAGE), 'https://app.example/vendor/engine.js');
});

test('empty / nullish input yields no engine (degrades to stub)', () => {
  assert.equal(sanitizeEngineUrl(undefined, PAGE), undefined);
  assert.equal(sanitizeEngineUrl(null, PAGE), undefined);
  assert.equal(sanitizeEngineUrl('', PAGE), undefined);
});

test('fails closed when the base origin is untrustworthy', () => {
  assert.equal(sanitizeEngineUrl('/engine.js', ''), undefined);
  assert.equal(sanitizeEngineUrl('/engine.js', 'not a url'), undefined);
});
