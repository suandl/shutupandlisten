// Self-hosted denoise engine module — the same-origin wrapper the denoise
// adapter (src/denoise.ts, DEFAULT_DENOISE_ENGINE_URL) import()s to build the
// real-time noise-suppression AudioWorkletNode that sits ahead of the VAD.
//
// Engine: RNNoise — Xiph's recurrent-network speech denoiser — as compiled for
// the Web Audio API by @sapphi-red/web-noise-suppressor 0.3.5 (MIT). We ADOPT a
// proven, purpose-built worklet rather than hand-roll DSP (the bead's "adopt a
// proven on-device approach; do NOT research from scratch").
//
// No-egress posture (mirrors public/stt-engine.js): every asset resolves from
// the app's OWN origin, relative to this module. The worklet processor and the
// RNNoise wasm are provisioned under ./denoise/ by `npm run provision:denoise`
// (web/scripts/provision-denoise.mjs) and gitignored. Nothing is fetched
// cross-origin and no microphone audio leaves the page.
//
// Fail-closed: if the provisioned assets are ABSENT (fresh clone, CI,
// un-provisioned deploy), `addModule` 404s and throws (and the wasm fetch is
// ok-checked), so `createNode` rejects and src/denoise.ts degrades to
// passthrough — the graceful default, mic path unchanged.

// Surfaced in the Stage as `denoise (rnnoise)`.
export const mode = 'rnnoise';

// RNNoise operates at 48kHz; src/denoise.ts creates the AudioContext at this
// rate so the adapter itself stays engine-agnostic.
export const sampleRate = 48000;

// The processor name workletProcessor.js registers with — a stable constant in
// @sapphi-red/web-noise-suppressor 0.3.5, kept in sync with the provisioned
// worklet by the pinned version in provision-denoise.mjs.
const PROCESSOR_NAME = '@sapphi-red/web-noise-suppressor/rnnoise';

const WORKLET_URL = new URL('./denoise/rnnoise/workletProcessor.js', import.meta.url).href;
const WASM_URL = new URL('./denoise/rnnoise.wasm', import.meta.url).href;
const WASM_SIMD_URL = new URL('./denoise/rnnoise_simd.wasm', import.meta.url).href;

// Minimal WebAssembly-SIMD feature-detect (the module @sapphi-red's loadRnnoise
// uses): load the SIMD wasm where supported, the scalar build otherwise.
function simdSupported() {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

async function fetchWasm(url) {
  const res = await fetch(url); // same-origin, provisioned
  if (!res.ok) throw new Error(`denoise wasm ${url} → HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Build the RNNoise denoise node in `ctx`. Loads the provisioned same-origin
 * worklet + wasm; throws (→ adapter passthrough) if either is absent. The node
 * is constructed exactly as @sapphi-red's RnnoiseWorkletNode does — passing the
 * fetched wasm binary to the worklet via processorOptions — so we depend only on
 * the stable registered processor name, not on the package's JS bundle.
 */
export async function createNode(ctx) {
  // addModule first: on an un-provisioned deploy this 404s and throws, so we
  // fall back cleanly rather than hand the worklet a bogus (error-page) binary.
  await ctx.audioWorklet.addModule(WORKLET_URL);
  const wasmBinary = await fetchWasm(simdSupported() ? WASM_SIMD_URL : WASM_URL);
  return new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    processorOptions: { maxChannels: 1, wasmBinary },
  });
}
