// The listener LLM's device/weight ladder — the ONE place that says which backends
// the listener will try, in what order, and which weight file each one needs.
//
// Split out of listener.worker.ts (which is browser-only: it touches Worker globals
// at import time, so no node test can import it) so the ladder is assertable from
// three sides that must agree:
//
//   1. listener.worker.ts     — walks it at runtime to load a model
//   2. scripts/provision-llm.mjs — must actually SHIP every rung's weight file
//   3. works-check / tests    — assert 1 and 2 have not drifted apart
//
// That three-way agreement is the contract su-lou.9 was filed against. The reported
// symptom was a listener that silently stubbed on a provisioned build; the filed
// root cause was "the webgpu rung omits the q4f16 dtype, so the engine asks for an
// fp32 model.onnx the provisioner never downloads → 404". Measured against the real
// provisioned tree, that turned out to be WRONG — public/llm-engine.js has supplied
// `dtype: 'q4f16'` as its pipeline default since U5, so the webgpu rung fetched
// model_q4f16.onnx and got a clean 200. What it did instead was worse (see
// SHADER_F16 below).
//
// The dtype is stated here anyway, explicitly, per rung. Inheriting it from the
// engine module's default is what made the filed diagnosis so plausible: the rung
// that loads the weights did not name the weights it wanted, so the only way to know
// was to read a second file — and a `?llmEngine=` override supplies no such default
// at all, which would silently re-introduce exactly the 404 the bead described.

/** Weight variants scripts/provision-llm.mjs ships (its `wantRepoFile`: _q4f16|_q4). */
export type ListenerDtype = 'q4f16' | 'q4';

export interface ListenerCandidate {
  /** transformers.js execution device — also the `mode` the adapter reports. */
  device: 'webgpu' | 'wasm';
  /** Weight variant. Named explicitly so the ladder is self-describing. */
  dtype: ListenerDtype;
  /**
   * Optional WebGPU feature this rung's weights REQUIRE. When the adapter lacks it
   * the rung is skipped rather than attempted — see SHADER_F16.
   */
  requiresFeature?: string;
}

/**
 * `shader-f16` is an OPTIONAL WebGPU feature, and q4f16 means 4-bit weights with
 * **fp16 compute** — so on an adapter without it, ORT's WebGPU backend cannot build
 * the f16 compute pipelines the graph needs.
 *
 * It does not fail closed. Measured on the provisioned tree (su-lou.9 repro, Chrome
 * for Testing 149 on a SwiftShader adapter, `shader-f16` absent): the session builds,
 * `pipeline()` RESOLVES, the console fills with "Invalid ComputePipeline
 * [MatMulNBits|SkipLayerNormalization|Cast]" validation errors, and generation
 * returns `"!!!!!!!!!!!!"` in ~29s. Mode reports `webgpu`; the text is non-empty.
 * Nothing throws, so the ladder stops there and the companion answers with garbage —
 * strictly worse than the labelled stub, and invisible to a gate that only asks "is
 * the backend real and the output non-empty".
 *
 * transformers.js gates plain `fp16` on this feature but not `q4f16`, so the ladder
 * gates it itself.
 */
export const SHADER_F16 = 'shader-f16';

/**
 * The ladder, best rung first. Every rung here has been RUN against the provisioned
 * Llama-3.2-1B-Instruct tree; a rung nobody has measured is a rung that will lie
 * about what it can do:
 *
 *   webgpu/q4f16  the U5 target — GPU, 4-bit weights, fp16 compute (1.09G of
 *                 weights). Requires `shader-f16`; skipped without it.
 *   wasm/q4       the no-WebGPU floor — 4-bit weights, fp32 compute (1.69G).
 *                 Measured end-to-end at ~52s to first token on an 8-core VM with
 *                 warm page cache, returning correct English. Slow, but REAL: the
 *                 stub is not a fallback, it is a failure.
 *
 * Deliberately NOT here: `webgpu/q4` (GPU without `shader-f16`). It is the obvious
 * middle rung and it may well be the right one on real f16-less hardware — but the
 * su-lou.9 repro host has no GPU beyond SwiftShader, where that rung had not
 * produced a token after 7 minutes, so there was no honest way to measure it. When
 * the q4f16 rung is skipped the adapter says so out loud (see listener.ts's
 * `onDiagnostic`), which is what gives a GPU-having operator the evidence to add it.
 */
export const LISTENER_CANDIDATES: readonly ListenerCandidate[] = [
  { device: 'webgpu', dtype: 'q4f16', requiresFeature: SHADER_F16 },
  { device: 'wasm', dtype: 'q4' },
];

/** Human-readable rung name for diagnostics — `webgpu/q4f16`. */
export function listenerCandidateLabel(c: ListenerCandidate): string {
  return `${c.device}/${c.dtype}`;
}

/**
 * The ONNX weight file a rung resolves under a model's directory, mirroring
 * transformers.js's DEFAULT_DTYPE_SUFFIX_MAPPING (q4f16 → `_q4f16`, q4 → `_q4`).
 *
 * This is the consumer half of the provisioning contract, written down so the gate
 * can HEAD it. External weights live alongside as `<file>_data` — see
 * listenerExternalWeightFile.
 */
export function listenerWeightFile(dtype: ListenerDtype): string {
  return `onnx/model_${dtype}.onnx`;
}

/**
 * The external-weights sibling. For a model of this size the `.onnx` file is only
 * the GRAPH — 149KB for Llama-3.2-1B-Instruct — and every actual weight lives in
 * `<file>_data` (1.09G at q4f16, 1.69G at q4), because the graph would otherwise
 * blow protobuf's 2GB message limit. A check that confirmed the `.onnx` and stopped
 * would be asserting 0.01% of what the rung needs, and would sail straight past an
 * interrupted `provision:llm` — which is a real way to end up with the graph on disk
 * and no weights beside it.
 */
export function listenerExternalWeightFile(dtype: ListenerDtype): string {
  return `${listenerWeightFile(dtype)}_data`;
}

/**
 * Below this, an `.onnx` is a graph that keeps its weights in the `_data` sibling;
 * at or above it, the weights are inline and no sibling exists. Any threshold
 * between "a graph" (~150KB) and "4-bit weights for a 1B+ model" (~1G) separates
 * the two — 16MB sits in the middle of a very wide gap, and keeps the gate correct
 * for a future small model swapped in via LLM_MODEL / `?llmModel=` instead of
 * demanding an external-data file that such a model would never ship.
 */
export const INLINE_WEIGHTS_MIN_BYTES = 16 * 1024 * 1024;
