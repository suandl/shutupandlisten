// Tests for the live VAD-knob resolver (knobs.ts: resolveVadKnobs).
//
// Increment-1 café feel-test contract: the browser APM (noiseSuppression /
// echoCancellation / autoGainControl) is already forced on by @ricky0123/vad-web
// (see vad.ts), so the remaining zero-rebuild lever is Silero's speech on/off
// thresholds + redemption frames. resolveVadKnobs exposes those as ?vad* URL
// knobs so the operator retunes a noisy room live. The logic is pure (takes the
// page's `location.search` as a string) so these guarantees are headless-testable.
//
// Guarantees under test:
//   1. no query → the vad-web defaults (DEFAULT_VAD_KNOBS), as a fresh object
//   2. a ?vad<Knob>= override retunes exactly that knob; the others stay default
//   3. out-of-range values clamp to the knob's [min,max]
//   4. blank / non-numeric / non-finite / unknown params fall back to the default
//   5. minSpeechFrames (not a UI knob) is never read from the URL
//   6. a real `location.search` (leading `?`) is accepted

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveVadKnobs, vadKnobParam, DEFAULT_VAD_KNOBS, VAD_KNOBS } from './knobs.ts';

// Match the other config tests: build the query WITHOUT a leading `?`
// (URLSearchParams accepts both; a dedicated test covers the `?`-prefixed form).
const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

test('no query → the vad-web defaults, as a fresh (non-shared) object', () => {
  assert.deepEqual(resolveVadKnobs(''), DEFAULT_VAD_KNOBS);
  assert.deepEqual(resolveVadKnobs('other=1'), DEFAULT_VAD_KNOBS);
  // Must be a fresh object — the UI mutates it via the sliders, so returning the
  // shared DEFAULT_VAD_KNOBS constant would corrupt the module default.
  assert.notEqual(resolveVadKnobs(''), DEFAULT_VAD_KNOBS);
});

test('?vad<Knob>= retunes exactly that knob; the others stay default', () => {
  const k = resolveVadKnobs(qs({ vadPositiveSpeechThreshold: '0.7' }));
  assert.equal(k.positiveSpeechThreshold, 0.7);
  assert.equal(k.negativeSpeechThreshold, DEFAULT_VAD_KNOBS.negativeSpeechThreshold);
  assert.equal(k.redemptionFrames, DEFAULT_VAD_KNOBS.redemptionFrames);
  assert.equal(k.minSpeechFrames, DEFAULT_VAD_KNOBS.minSpeechFrames);
});

test('all three exposed knobs resolve together', () => {
  const k = resolveVadKnobs(
    qs({
      vadPositiveSpeechThreshold: '0.6',
      vadNegativeSpeechThreshold: '0.25',
      vadRedemptionFrames: '20',
    }),
  );
  assert.equal(k.positiveSpeechThreshold, 0.6);
  assert.equal(k.negativeSpeechThreshold, 0.25);
  assert.equal(k.redemptionFrames, 20);
});

test('out-of-range values clamp to the knob [min,max]', () => {
  // thresholds: [0.1, 0.9]
  assert.equal(resolveVadKnobs(qs({ vadPositiveSpeechThreshold: '5' })).positiveSpeechThreshold, 0.9);
  assert.equal(resolveVadKnobs(qs({ vadPositiveSpeechThreshold: '-1' })).positiveSpeechThreshold, 0.1);
  // redemptionFrames: [1, 40]
  assert.equal(resolveVadKnobs(qs({ vadRedemptionFrames: '999' })).redemptionFrames, 40);
  assert.equal(resolveVadKnobs(qs({ vadRedemptionFrames: '0' })).redemptionFrames, 1);
});

test('blank / non-numeric / non-finite / unknown params fall back to the default', () => {
  const def = DEFAULT_VAD_KNOBS.positiveSpeechThreshold;
  assert.equal(resolveVadKnobs(qs({ vadPositiveSpeechThreshold: '' })).positiveSpeechThreshold, def);
  assert.equal(resolveVadKnobs(qs({ vadPositiveSpeechThreshold: '   ' })).positiveSpeechThreshold, def);
  assert.equal(resolveVadKnobs(qs({ vadPositiveSpeechThreshold: 'abc' })).positiveSpeechThreshold, def);
  assert.equal(resolveVadKnobs(qs({ vadPositiveSpeechThreshold: 'Infinity' })).positiveSpeechThreshold, def);
  // an unknown ?vad* param touches nothing
  assert.deepEqual(resolveVadKnobs(qs({ vadNotAKnob: '1' })), DEFAULT_VAD_KNOBS);
});

test('minSpeechFrames is not URL-exposed (it is not one of the UI VAD_KNOBS)', () => {
  assert.ok(!VAD_KNOBS.some((s) => s.key === 'minSpeechFrames'));
  assert.equal(
    resolveVadKnobs(qs({ vadMinSpeechFrames: '9' })).minSpeechFrames,
    DEFAULT_VAD_KNOBS.minSpeechFrames,
  );
});

test('accepts a real location.search (leading `?`)', () => {
  assert.equal(resolveVadKnobs('?vadRedemptionFrames=18').redemptionFrames, 18);
});

test('vadKnobParam builds the ?vad<Knob> name from a knob key', () => {
  assert.equal(vadKnobParam('positiveSpeechThreshold'), 'vadPositiveSpeechThreshold');
  assert.equal(vadKnobParam('redemptionFrames'), 'vadRedemptionFrames');
});
