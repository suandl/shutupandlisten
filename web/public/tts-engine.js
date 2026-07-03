// Self-hosted on-device TTS engine module — the same-origin wrapper the TTS worker
// import()s (the default `engineUrl`, see src/tts.ts DEFAULT_TTS_ENGINE_URL).
//
// U6 mirror of public/stt-engine.js: like STT, the placeholder voice runs on
// **CPU/WASM** (the GPU stays reserved for the U5 listener). Same no-egress posture
// as STT and the listener (su-0hi #1): transformers.js would otherwise fetch model
// weights from the HuggingFace hub and its ONNX Runtime wasm from a CDN at runtime.
// Here EVERY asset resolves from the app's OWN origin, relative to this module:
//
//   engine bundle + ONNX Runtime wasm → ./tts/transformers/   (provisioned, gitignored)
//   model weights                     → ./models/<id>/         (provisioned, gitignored;
//                                                               shared dir with STT + LLM)
//
// Provisioned by `npm run provision:tts` at build/deploy (web/scripts/provision-tts.mjs).
// If the provisioned bundle is ABSENT, the import below 404s, the worker's init
// handshake fails closed, and the adapter degrades to the placeholder tone — the
// graceful default, exactly as STT.
//
// Pinned engine: @huggingface/transformers 3.8.1 (the SAME version STT + the LLM
// pin; its dist self-contains the matching ort-wasm-simd-threaded.jsep.{mjs,wasm}).
import { pipeline as runPipeline, env } from './tts/transformers/transformers.min.js';

// Resolve model weights from our origin and never from the hub. localModelPath is
// the SAME ./models/ tree STT + the LLM use — a model id resolves under it identically.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;

// Serve the ONNX Runtime wasm from our origin too (default would be a CDN).
// Guarded so an engine build that lacks this knob still loads.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = new URL('./tts/transformers/', import.meta.url).href;
}

// Default synthesis to CPU/WASM + quantized (q8) weights — the smallest, GPU-free
// variant, what provision-tts.mjs fetches. The worker may override per call. When a
// future TTS model supports WebGPU, `device: 'webgpu'` from the worker overrides this.
export function pipeline(task, model, options = {}) {
  return runPipeline(task, model, { device: 'wasm', dtype: 'q8', ...options });
}

export { env };
