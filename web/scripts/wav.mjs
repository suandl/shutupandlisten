// Minimal WAV (RIFF PCM16) codec for the works-check (su-ljrb.6).
//
// The driver decodes the committed speech fixture (web/test/fixtures/*.wav) to the
// Float32 PCM the STT adapter takes, in NODE — the probe page receives ready
// samples and stays free of browser audio-decode variance (no AudioContext in a
// headless check). Scope is deliberately narrow: 16-bit PCM, the one format the
// fixture is committed in; anything else is a loud error, never a guess.
// `encodeWavPcm16` is the mirror (fixture generation + round-trip tests).

/**
 * Parse a RIFF/WAVE buffer holding 16-bit PCM. Multi-channel audio is downmixed
 * to mono by averaging (the STT path is mono 16k). Returns Float32 samples in
 * [-1, 1] plus the container's sample rate.
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function parseWavPcm16(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off) => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let fmt = null;
  let data = null;
  // Walk the chunk list — provenance-carrying files often hold LIST/INFO chunks
  // between fmt and data, so fixed offsets would be wrong.
  for (let off = 12; off + 8 <= view.byteLength; ) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { off: body, size: Math.min(size, view.byteLength - body) };
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('WAV is missing its fmt or data chunk');
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`unsupported WAV encoding (format=${fmt.format}, bits=${fmt.bitsPerSample}); the fixture must be 16-bit PCM`);
  }
  if (fmt.channels < 1) throw new Error('WAV reports zero channels');

  const frames = Math.floor(data.size / (2 * fmt.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      acc += view.getInt16(data.off + (i * fmt.channels + c) * 2, true);
    }
    samples[i] = acc / fmt.channels / 32768;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

/**
 * Encode mono Float32 samples ([-1, 1], clipped) as a 16-bit PCM WAV buffer.
 *
 * @param {Float32Array | number[]} samples
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeWavPcm16(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}
