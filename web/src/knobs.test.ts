// Tests for the live knob resolvers (knobs.ts) — the VAD ones, and the turn knobs +
// floor-sweep ladder the su-lou.10.5 harness added.
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

import {
  resolveVadKnobs,
  vadKnobParam,
  resolveTurnKnobs,
  gateConfigFromTurnKnobs,
  defaultTurnKnobs,
  FLOOR_SWEEP_MS,
  DEFAULT_VAD_KNOBS,
  VAD_KNOBS,
  TURN_KNOBS,
} from './knobs.ts';
import { DEFAULT_KNOBS } from './turn-detection.ts';
import { DEFAULT_GATE_CONFIG } from './response-hierarchy.ts';
import { DEFAULT_COMPLETION_THRESHOLD } from './completion-threshold.ts';

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

// ── the floor-sweep harness (su-lou.10.5) ──
//
// Guarantees under test:
//   7.  no query → DEFAULT_KNOBS, unchanged and as a fresh object
//   8.  ?silenceFloorMs= (and the rest) retune exactly that knob
//   9.  values clamp to the knob's [min,max] rather than being rejected
//   10. blank / non-numeric / non-finite / unknown params keep the default
//   11. the toggle reads on/off (not just true/false)
//   12. every rung of the sweep ladder is reachable through the slider's own range
//   13. THIS UNIT CHANGES NO DEFAULT — silenceFloorMs is still 2000

test('no query → DEFAULT_KNOBS, as a fresh (non-shared) object', () => {
  assert.deepEqual(resolveTurnKnobs(''), DEFAULT_KNOBS);
  assert.deepEqual(resolveTurnKnobs('other=1'), DEFAULT_KNOBS);
  // Fresh: the UI hands this object to the detector, which mutates it via setKnobs.
  assert.notEqual(resolveTurnKnobs(''), DEFAULT_KNOBS);
});

test('?silenceFloorMs= retunes exactly that knob; the others stay default', () => {
  const k = resolveTurnKnobs(qs({ silenceFloorMs: '750' }));
  assert.equal(k.silenceFloorMs, 750);
  assert.equal(k.incompleteExtensionMs, DEFAULT_KNOBS.incompleteExtensionMs);
  assert.equal(k.completionThreshold, DEFAULT_KNOBS.completionThreshold);
  assert.equal(k.useSmartTurn, DEFAULT_KNOBS.useSmartTurn);
});

test('the whole sweep configuration resolves from one URL', () => {
  const k = resolveTurnKnobs(
    qs({
      silenceFloorMs: '500',
      incompleteExtensionMs: '2000',
      completionThreshold: '0.65',
      responseDurationMs: '900',
      useSmartTurn: 'off',
    }),
  );
  assert.equal(k.silenceFloorMs, 500);
  assert.equal(k.incompleteExtensionMs, 2000);
  assert.equal(k.completionThreshold, 0.65);
  assert.equal(k.responseDurationMs, 900);
  assert.equal(k.useSmartTurn, false);
});

test('out-of-range values clamp rather than reverting to the default', () => {
  // A fat-fingered floor should give the most patient harness the slider can
  // express — silently reverting to 2000 would look like the URL was ignored.
  assert.equal(resolveTurnKnobs(qs({ silenceFloorMs: '50000' })).silenceFloorMs, 6000);
  assert.equal(resolveTurnKnobs(qs({ silenceFloorMs: '0' })).silenceFloorMs, 200);
  assert.equal(resolveTurnKnobs(qs({ completionThreshold: '2' })).completionThreshold, 1);
  assert.equal(resolveTurnKnobs(qs({ completionThreshold: '-3' })).completionThreshold, 0);
});

test('blank / non-numeric / non-finite / unknown params keep the default', () => {
  const def = DEFAULT_KNOBS.silenceFloorMs;
  assert.equal(resolveTurnKnobs(qs({ silenceFloorMs: '' })).silenceFloorMs, def);
  assert.equal(resolveTurnKnobs(qs({ silenceFloorMs: '   ' })).silenceFloorMs, def);
  assert.equal(resolveTurnKnobs(qs({ silenceFloorMs: 'abc' })).silenceFloorMs, def);
  assert.equal(resolveTurnKnobs(qs({ silenceFloorMs: 'Infinity' })).silenceFloorMs, def);
  assert.deepEqual(resolveTurnKnobs(qs({ notAKnob: '1' })), DEFAULT_KNOBS);
});

test('the smart-turn toggle reads on/off, and garbage keeps the default', () => {
  assert.equal(resolveTurnKnobs(qs({ useSmartTurn: 'off' })).useSmartTurn, false);
  assert.equal(resolveTurnKnobs(qs({ useSmartTurn: 'false' })).useSmartTurn, false);
  assert.equal(resolveTurnKnobs(qs({ useSmartTurn: '0' })).useSmartTurn, false);
  assert.equal(resolveTurnKnobs(qs({ useSmartTurn: 'on' })).useSmartTurn, true);
  assert.equal(resolveTurnKnobs(qs({ useSmartTurn: 'maybe' })).useSmartTurn, DEFAULT_KNOBS.useSmartTurn);
});

test('accepts a real location.search (leading `?`)', () => {
  assert.equal(resolveTurnKnobs('?silenceFloorMs=350').silenceFloorMs, 350);
});

test('every sweep rung is reachable through the slider that drives it', () => {
  // The ladder's buttons drive the range input (main.ts renderFloorSweep), so a rung
  // outside the slider's [min,max] or off its step would be silently snapped to
  // something else — the operator would rate a value they did not select.
  const spec = TURN_KNOBS.find((s) => s.key === 'silenceFloorMs');
  assert.ok(spec && spec.min != null && spec.max != null && spec.step != null);
  for (const ms of FLOOR_SWEEP_MS) {
    assert.ok(ms >= spec.min && ms <= spec.max, `${ms}ms is outside the slider's range`);
    assert.equal((ms - spec.min) % spec.step, 0, `${ms}ms is not on the slider's step`);
  }
  // Ordered most-patient → least, which is the order the feel-test walks.
  assert.deepEqual([...FLOOR_SWEEP_MS].sort((a, b) => b - a), [...FLOOR_SWEEP_MS]);
});

test('this unit changes NO default — the floor is still 2000ms', () => {
  // su-lou.10.5 builds the harness and produces the evidence; su-lou.10.6 picks the
  // value. If this ever fails, someone tuned in the unit that promised not to.
  assert.equal(DEFAULT_KNOBS.silenceFloorMs, 2000);
  assert.equal(DEFAULT_KNOBS.incompleteExtensionMs, 4000);
  assert.equal(defaultTurnKnobs().silenceFloorMs, 2000);
});

// ── the completion threshold: one constant, two readers ──

test('the detector and the gate default to the SAME completion threshold', () => {
  // The drift this unit closed: two literal 0.5s, mirrored by a comment and enforced
  // by nothing. Tune one and the detector extends the floor on one boundary while the
  // gate reads the same pause as finished on another.
  assert.equal(DEFAULT_KNOBS.completionThreshold, DEFAULT_COMPLETION_THRESHOLD);
  assert.equal(DEFAULT_GATE_CONFIG.completionThreshold, DEFAULT_COMPLETION_THRESHOLD);
  assert.equal(DEFAULT_KNOBS.completionThreshold, DEFAULT_GATE_CONFIG.completionThreshold);
});

test('gateConfigFromTurnKnobs carries the LIVE knob to the gate', () => {
  // The second mirror: shared defaults do nothing for two runtime configs. This is
  // the one su-lou.10.6 actually moves, from the UI slider.
  const retuned = { ...defaultTurnKnobs(), completionThreshold: 0.8 };
  assert.equal(gateConfigFromTurnKnobs(retuned).completionThreshold, 0.8);

  // Partial on purpose: the gate's other knobs are not turn-detection's business and
  // must keep coming from DEFAULT_GATE_CONFIG via decideTier's spread.
  assert.deepEqual(Object.keys(gateConfigFromTurnKnobs(retuned)), ['completionThreshold']);
});
