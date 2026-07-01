// Self-hosted STT engine module — the same-origin wrapper the STT worker
// import()s (the default `engineUrl`, see src/stt.ts DEFAULT_STT_ENGINE_URL).
//
// Why a wrapper instead of pointing the worker straight at transformers.min.js:
// this is where the on-device / no-egress posture is pinned. transformers.js
// would otherwise fetch model weights from the HuggingFace hub and its ONNX
// Runtime wasm from a CDN at runtime — both third-party-origin fetches on a page
// that handles live microphone audio. Here we force EVERY asset to resolve from
// the app's own origin, relative to this module:
//
//   engine bundle + ONNX Runtime wasm → ./stt/transformers/   (provisioned, gitignored)
//   model weights                     → ./models/<id>/         (provisioned, gitignored)
//
// Provisioned by `npm run provision:stt` at build/deploy (web/scripts/provision-stt.mjs).
// If the provisioned bundle is ABSENT, the import below 404s, the worker's init
// handshake fails closed, and the adapter degrades to the labelled stub — the
// graceful default. (su-0hi #1: the engine URL is same-origin-restricted; this
// wrapper keeps the runtime fetches same-origin too.)
//
// Pinned engine: @huggingface/transformers 3.8.1 (its dist self-contains the
// matching ort-wasm-simd-threaded.jsep.{mjs,wasm}).
import { pipeline as runPipeline, env } from './stt/transformers/transformers.min.js';

// Resolve model weights from our origin and never from the hub.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;

// Serve the ONNX Runtime wasm from our origin too (default would be a CDN).
// Guarded so an engine build that lacks this knob still loads.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = new URL('./stt/transformers/', import.meta.url).href;
}

// Default inference to CPU/WASM + quantized (q8) weights — the smallest,
// GPU-free variant (the GPU is reserved for the LLM/TTS in later units). The
// worker may override per call; q8 weights are what provision-stt.mjs fetches.
export function pipeline(task, model, options = {}) {
  return runPipeline(task, model, { device: 'wasm', dtype: 'q8', ...options });
}

export { env };
