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
import { AutoModelForTextToWaveform, AutoTokenizer, env } from './tts/transformers/transformers.min.js';

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

// Component construction, NOT the transformers.js pipeline() factory (su-lou.8).
// The 3.8.1 factory probes the OPTIONAL preprocessor_config.json during
// construction; mms-tts-eng (VITS) has none upstream, so under our
// allowRemoteModels=false posture the clean 404 becomes a fatal throw and the
// voice silently stubbed. Fabricating the file is worse: a typed stub makes the
// pipeline dispatch on processor PRESENCE and fetch an absent speecht5 vocoder at
// synthesis time. Building the components directly skips the probe entirely and
// mirrors what the factory's VITS path (_call_text_to_waveform) does anyway:
// tokenize, run the model, read the waveform + the config's sampling_rate.
//
// Default synthesis is CPU/WASM + quantized (q8) weights — the smallest, GPU-free
// variant, what provision-tts.mjs fetches. The worker may override per call. When a
// future TTS model supports WebGPU, `device: 'webgpu'` from the worker overrides this.
export async function pipeline(task, model, options = {}) {
  if (task !== 'text-to-speech') throw new Error(`unsupported task: ${task} (this engine only speaks)`);
  // Model FIRST, tokenizer second. The worker tries wasm and then webgpu (see
  // tts.worker.ts), and it is the MODEL construction that fails on a device the
  // host cannot provide — so loading the tokenizer first meant every failed
  // attempt paid for a tokenizer the retry then loaded again. Cached, therefore
  // only wasteful rather than wrong, but the ordering buys nothing either way.
  const tts = await AutoModelForTextToWaveform.from_pretrained(model, { device: 'wasm', dtype: 'q8', ...options });
  const tokenizer = await AutoTokenizer.from_pretrained(model);
  const samplingRate = tts.config?.sampling_rate;
  if (!(samplingRate > 0)) throw new Error(`model config carries no sampling_rate (${model})`);
  return async (text) => {
    const inputs = tokenizer(text, { padding: true, truncation: true });
    const { waveform } = await tts(inputs);
    const audio = waveform?.data instanceof Float32Array ? waveform.data : Float32Array.from(waveform?.data ?? []);
    if (audio.length === 0) throw new Error('model returned an empty waveform');
    return { audio, sampling_rate: samplingRate };
  };
}

export { env };
