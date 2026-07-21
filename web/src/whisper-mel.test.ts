// Tests for the smart-turn v3 front-end (whisper-mel.ts).
//
// The guarantee under test is CONFORMANCE, not plausibility: the model is a Whisper
// encoder, so features that merely "look like a spectrogram" would produce confident
// nonsense verdicts — the exact failure mode su-lou.10.1 exists to prevent (a stage
// that reports `model` while emitting garbage is worse than the honest heuristic).
//
// So the log-Mel is pinned to GOLDEN values produced by the canonical implementation
// (@huggingface/transformers 3.8.1, the JS port of the HF WhisperFeatureExtractor the
// pipecat reference inference uses), generated once and committed as
// test/fixtures/whisper-mel-golden.json. The mixed-radix FFT underneath is checked
// against a naive DFT written independently here, and the numpy/HF semantics each
// stage claims (reflect padding, last-8s windowing, zero-mean/unit-var) are asserted
// directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Fft,
  N_FRAMES,
  N_MELS,
  N_SAMPLES,
  fitToWindow,
  hannWindow,
  hertzToMel,
  logMelSpectrogram,
  melFilterBank,
  melToHertz,
  reflectPad,
  whisperFeatures,
  zeroMeanUnitVar,
} from './whisper-mel.ts';
import { parseWavPcm16 } from '../scripts/wav.mjs';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(readFileSync(join(WEB_ROOT, 'test', 'fixtures', 'whisper-mel-golden.json'), 'utf8'));

/** Deterministic pseudo-random source, so a failure is always reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

/** Straight O(n²) DFT — the independent reference for the mixed-radix transform. */
function naiveDft(re: Float64Array, im: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * t * k) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      sr += re[t] * c - im[t] * s;
      si += re[t] * s + im[t] * c;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

// ── FFT ────────────────────────────────────────────────────────────────────────

test('mixed-radix FFT matches a naive DFT across the sizes 400 factors through', () => {
  // 1 (base case), 2/16 (pure radix-2), 5/25 (the radix-5 levels), 400 (the real
  // n_fft), 7 (a prime that hits the general-radix path at the top level).
  for (const n of [1, 2, 5, 7, 16, 25, 400]) {
    const rand = lcg(n * 7919);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = rand();
      im[i] = rand();
    }
    const expected = naiveDft(re, im);
    const actual = new Fft(n).transform(re, im);
    for (let k = 0; k < n; k++) {
      assert.ok(
        Math.abs(actual.re[k] - expected.re[k]) < 1e-9 && Math.abs(actual.im[k] - expected.im[k]) < 1e-9,
        `n=${n} bin ${k}: got ${actual.re[k]}+${actual.im[k]}i, want ${expected.re[k]}+${expected.im[k]}i`,
      );
    }
  }
});

test('FFT leaves its input untouched and is reusable across frames', () => {
  const fft = new Fft(16);
  const re = Float64Array.from({ length: 16 }, (_, i) => Math.sin(i));
  const im = new Float64Array(16);
  const snapshot = Float64Array.from(re);
  const first = Float64Array.from(fft.transform(re, im).re);
  assert.deepEqual(Array.from(re), Array.from(snapshot), 'input buffer was mutated');
  const second = fft.transform(re, im).re;
  assert.deepEqual(Array.from(second), Array.from(first), 'a reused Fft is not deterministic');
});

test('FFT rejects a size it cannot transform', () => {
  assert.throws(() => new Fft(0), /positive integer/);
  assert.throws(() => new Fft(2.5), /positive integer/);
});

// ── window + Mel bank ──────────────────────────────────────────────────────────

test('hann window is PERIODIC (numpy hanning(n+1)[:-1]), not symmetric', () => {
  const w = hannWindow(400);
  assert.equal(w.length, 400);
  assert.equal(w[0], 0);
  assert.ok(Math.abs(w[200] - 1) < 1e-12, 'peak sits at n/2 for an even periodic window');
  // Periodic ⇒ w[n-1] != w[1] would be symmetric; periodic makes them equal.
  assert.ok(Math.abs(w[1] - w[399]) < 1e-12);
  // A SYMMETRIC hann would end at exactly 0; the periodic one does not.
  assert.ok(w[399] > 0);
});

test('slaney mel scale round-trips and switches to log above 1kHz', () => {
  for (const hz of [0, 100, 999.9, 1000, 4000, 8000]) {
    assert.ok(Math.abs(melToHertz(hertzToMel(hz)) - hz) < 1e-6, `round-trip failed at ${hz}Hz`);
  }
  // Linear below the knee: 3·f/200.
  assert.ok(Math.abs(hertzToMel(200) - 3) < 1e-12);
  assert.ok(Math.abs(hertzToMel(1000) - 15) < 1e-12);
});

test('mel bank matches the canonical slaney/slaney bank (start bin + weight sum)', () => {
  const bank = melFilterBank(201, N_MELS, 0.0, 8000.0, 16000);
  assert.equal(bank.length, N_MELS);
  for (let m = 0; m < N_MELS; m++) {
    const f = bank[m];
    assert.equal(f.start, golden.melBank.starts[m], `filter ${m} starts at the wrong bin`);
    let sum = 0;
    for (const w of f.weights) {
      assert.ok(w > 0, `filter ${m} kept a zero weight in its sparse span`);
      sum += w;
    }
    assert.ok(
      Math.abs(sum - golden.melBank.sums[m]) < 1e-5,
      `filter ${m} weight sum ${sum} != golden ${golden.melBank.sums[m]}`,
    );
  }
});

// ── waveform preparation ───────────────────────────────────────────────────────

test('fitToWindow keeps the TAIL of a long segment', () => {
  const audio = Float32Array.from({ length: N_SAMPLES + 5000 }, (_, i) => i);
  const win = fitToWindow(audio);
  assert.equal(win.length, N_SAMPLES);
  assert.equal(win[N_SAMPLES - 1], audio[audio.length - 1], 'the end of the utterance must survive');
  assert.equal(win[0], audio[5000]);
});

test('fitToWindow pads a short segment at the BEGINNING', () => {
  const audio = Float32Array.from([1, 2, 3]);
  const win = fitToWindow(audio, 6);
  assert.deepEqual(Array.from(win), [0, 0, 0, 1, 2, 3]);
});

test('zeroMeanUnitVar produces zero mean and unit variance', () => {
  const rand = lcg(12345);
  const x = Float32Array.from({ length: 4096 }, () => rand() * 3 + 7);
  const y = zeroMeanUnitVar(x);
  let mean = 0;
  for (const v of y) mean += v;
  mean /= y.length;
  let variance = 0;
  for (const v of y) variance += (v - mean) * (v - mean);
  variance /= y.length;
  assert.ok(Math.abs(mean) < 1e-5, `mean ${mean}`);
  assert.ok(Math.abs(variance - 1) < 1e-4, `variance ${variance}`);
});

test('zeroMeanUnitVar keeps digital silence finite (the eps floor)', () => {
  const y = zeroMeanUnitVar(new Float32Array(64));
  for (const v of y) assert.equal(v, 0);
});

test('reflectPad matches numpy reflect (the edge sample is not repeated)', () => {
  const padded = reflectPad(Float32Array.from([1, 2, 3, 4, 5]), 2);
  assert.deepEqual(Array.from(padded), [3, 2, 1, 2, 3, 4, 5, 4, 3]);
});

// ── the whole front-end ────────────────────────────────────────────────────────

test('log-Mel conforms to the canonical transformers.js features on the speech fixture', () => {
  const { samples, sampleRate } = parseWavPcm16(readFileSync(join(WEB_ROOT, 'test', 'fixtures', 'utterance.wav')));
  assert.equal(sampleRate, 16000, 'the fixture must already be at the model rate');
  const features = logMelSpectrogram(zeroMeanUnitVar(fitToWindow(samples)));
  assert.equal(features.length, N_MELS * N_FRAMES);

  // Spot-check every golden sample (a coprime stride walks all 80 rows × 800 frames).
  // Tolerance is float32-scale: the golden was computed in float32 by a different
  // FFT, so exact equality is not the claim — conformance to ~1e-5 is.
  let worst = 0;
  let worstIdx = -1;
  golden.values.forEach((want: number, n: number) => {
    const i = n * golden.stride;
    const err = Math.abs(features[i] - want);
    if (err > worst) {
      worst = err;
      worstIdx = i;
    }
  });
  assert.ok(worst < 1e-5, `log-Mel diverged from the canonical features by ${worst} at index ${worstIdx}`);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of features) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  assert.ok(Math.abs(min - golden.stats.min) < 1e-5, `min ${min} != ${golden.stats.min}`);
  assert.ok(Math.abs(max - golden.stats.max) < 1e-5, `max ${max} != ${golden.stats.max}`);
  assert.ok(Math.abs(sum / features.length - golden.stats.mean) < 1e-5, 'mean drifted from the golden');
});

test('whisperFeatures emits a finite [80, 800] tensor for silence, speech and clipping', () => {
  const rand = lcg(999);
  const cases: Array<[string, Float32Array]> = [
    ['digital silence', new Float32Array(16000)],
    ['white noise', Float32Array.from({ length: 16000 }, () => rand())],
    ['full-scale square', Float32Array.from({ length: 16000 }, (_, i) => (i % 2 ? 1 : -1))],
    ['longer than the window', Float32Array.from({ length: N_SAMPLES * 2 }, (_, i) => Math.sin(i / 50) * 0.5)],
    ['one sample', Float32Array.from([0.5])],
  ];
  for (const [label, audio] of cases) {
    const f = whisperFeatures(audio);
    assert.equal(f.length, N_MELS * N_FRAMES, `${label}: wrong tensor size`);
    for (let i = 0; i < f.length; i++) {
      assert.ok(Number.isFinite(f[i]), `${label}: non-finite feature at ${i}`);
    }
  }
});

test('a tone lands in the mel row its frequency belongs to', () => {
  // 1kHz sits at mel 15; with 80 filters spanning mel 0..hertzToMel(8000), the peak
  // row is the one whose triangle centre is nearest. This catches a bin↔Hz mixup
  // (e.g. an FFT size change) that the golden's absolute values would also catch but
  // less legibly.
  const sr = 16000;
  const tone = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / sr));
  const f = whisperFeatures(tone);
  let peakRow = -1;
  let peak = -Infinity;
  for (let m = 0; m < N_MELS; m++) {
    // Sample a frame well inside the tone (the window left-pads, so the tail is signal).
    const v = f[m * N_FRAMES + (N_FRAMES - 10)];
    if (v > peak) {
      peak = v;
      peakRow = m;
    }
  }
  const melMax = hertzToMel(8000);
  const expectedRow = Math.round((hertzToMel(1000) / melMax) * (N_MELS + 1)) - 1;
  assert.ok(
    Math.abs(peakRow - expectedRow) <= 1,
    `1kHz tone peaked at mel row ${peakRow}, expected ≈${expectedRow}`,
  );
});
