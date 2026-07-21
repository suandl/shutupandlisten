// Types for the hand-written WAV codec in wav.mjs (NOT generated).
//
// scripts/ is plain JS and outside tsconfig's `include`, so its JSDoc types are
// invisible to `tsc`. src/whisper-mel.test.ts decodes the committed speech fixture
// through this codec to check the smart-turn front-end against its golden features,
// and duplicating a second parser in the test would be worse than declaring the one
// that exists. Keep in sync with wav.mjs by hand — it is fifteen lines of surface.

export declare function parseWavPcm16(bytes: Uint8Array): { samples: Float32Array; sampleRate: number };

export declare function encodeWavPcm16(samples: Float32Array | number[], sampleRate: number): Uint8Array;
