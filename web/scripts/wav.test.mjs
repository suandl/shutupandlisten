// Tests for the works-check WAV codec (wav.mjs).
//
// The guarantees under test:
//   1. encode → parse round-trips samples (within 16-bit quantization) + rate
//   2. multi-channel PCM downmixes to mono (the STT path is mono)
//   3. chunk walking survives an extra chunk between fmt and data (provenance
//      LIST/INFO chunks are common in real files)
//   4. non-PCM16 and non-WAV input is a loud error, never a garbage decode

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeWavPcm16, parseWavPcm16 } from './wav.mjs';

function sine(n, freq, rate) {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
  return s;
}

test('encode → parse round-trips mono PCM16', () => {
  const rate = 16000;
  const original = sine(rate, 440, rate); // 1s
  const parsed = parseWavPcm16(encodeWavPcm16(original, rate));
  assert.equal(parsed.sampleRate, rate);
  assert.equal(parsed.samples.length, original.length);
  for (let i = 0; i < original.length; i += 997) {
    assert.ok(Math.abs(parsed.samples[i] - original[i]) < 1 / 32000, `sample ${i} drifted`);
  }
});

test('encoder clips out-of-range samples instead of wrapping', () => {
  const parsed = parseWavPcm16(encodeWavPcm16(Float32Array.from([2, -2, 0]), 16000));
  assert.ok(parsed.samples[0] > 0.99);
  assert.ok(parsed.samples[1] < -0.99);
  assert.equal(parsed.samples[2], 0);
});

test('stereo PCM16 downmixes to mono by averaging', () => {
  // Hand-build a stereo file: 2 frames, L/R = (0.5, -0.5) then (1.0, 0.0).
  const buf = Buffer.alloc(44 + 8);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(8000 * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(8, 40);
  for (const [i, v] of [16384, -16384, 32767, 0].entries()) buf.writeInt16LE(v, 44 + i * 2);
  const parsed = parseWavPcm16(buf);
  assert.equal(parsed.samples.length, 2);
  assert.ok(Math.abs(parsed.samples[0] - 0) < 1e-4);
  assert.ok(Math.abs(parsed.samples[1] - 0.5) < 1e-3);
});

test('parser walks past an extra chunk between fmt and data', () => {
  const rate = 8000;
  const clean = encodeWavPcm16(sine(64, 200, rate), rate);
  // Splice a LIST chunk (odd-sized, to exercise word-alignment) before `data`.
  const listBody = Buffer.from('INFOprovenance!', 'ascii'); // 15 bytes, odd
  const list = Buffer.alloc(8 + listBody.length + 1);
  list.write('LIST', 0);
  list.writeUInt32LE(listBody.length, 4);
  listBody.copy(list, 8);
  const spliced = Buffer.concat([clean.subarray(0, 36), list, clean.subarray(36)]);
  spliced.writeUInt32LE(spliced.length - 8, 4);
  const parsed = parseWavPcm16(spliced);
  assert.equal(parsed.sampleRate, rate);
  assert.equal(parsed.samples.length, 64);
});

test('rejects float-PCM and non-WAV input loudly', () => {
  const floatWav = encodeWavPcm16(sine(16, 200, 8000), 8000);
  floatWav.writeUInt16LE(3, 20); // format 3 = IEEE float
  assert.throws(() => parseWavPcm16(floatWav), /unsupported WAV encoding/);
  assert.throws(() => parseWavPcm16(Buffer.from('definitely not audio')), /not a RIFF\/WAVE/);
});
