// Self-hosted on-device LLM engine module — the same-origin wrapper the listener
// worker import()s (the default `engineUrl`, see src/listener.ts DEFAULT_LLM_ENGINE_URL).
//
// U5 mirror of public/stt-engine.js, one deliberate difference: this engine runs
// on **WebGPU**, not CPU/WASM. The bead's constraint is "a SMALL on-device LLM
// (WASM/WebGPU), off the CPU/WASM the STT uses" — so text generation runs on the
// GPU the STT worker leaves untouched, keeping the two on-device models off each
// other's compute. WASM stays available as the fallback device for a machine with
// no WebGPU (transformers.js picks it up when the webgpu backend is absent).
//
// Same no-egress posture as STT (su-0hi #1): transformers.js would otherwise fetch
// model weights from the HuggingFace hub and its ONNX Runtime wasm from a CDN at
// runtime. Here EVERY asset resolves from the app's OWN origin, relative to this
// module:
//
//   engine bundle + ONNX Runtime wasm → ./llm/transformers/   (provisioned, gitignored)
//   model weights                     → ./models/<id>/         (provisioned, gitignored;
//                                                               shared dir with STT)
//
// Provisioned by `npm run provision:llm` at build/deploy (web/scripts/provision-llm.mjs).
// If the provisioned bundle is ABSENT, the import below 404s, the worker's init
// handshake fails closed, and the adapter degrades to the labelled stub — the
// graceful default, exactly as STT.
//
// Pinned engine: @huggingface/transformers 3.8.1 (same version STT pins; its dist
// self-contains the matching ort-wasm-simd-threaded.jsep.{mjs,wasm}).
import { pipeline as runPipeline, env } from './llm/transformers/transformers.min.js';

// Resolve model weights from our origin and never from the hub. localModelPath is
// the SAME ./models/ tree STT uses — a model id resolves under it identically.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;

// Serve the ONNX Runtime wasm from our origin too (default would be a CDN).
// Guarded so an engine build that lacks this knob still loads. Used for the WASM
// fallback path and for any ops WebGPU delegates back to wasm.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = new URL('./llm/transformers/', import.meta.url).href;
}

// Default generation to WebGPU + 4-bit weights (q4f16: 4-bit weights, fp16 compute)
// — the smallest/fastest variant for a small instruct model in the browser, and
// the GPU the STT worker leaves free. The worker may override per call. When there
// is no WebGPU adapter, transformers.js falls back to the wasm backend on its own;
// pass `device: 'wasm'` explicitly to force it.
export function pipeline(task, model, options = {}) {
  return runPipeline(task, model, { device: 'webgpu', dtype: 'q4f16', ...options });
}

export { env };
