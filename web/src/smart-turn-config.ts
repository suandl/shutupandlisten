// Resolve the live smart-turn config: self-hosted default, with URL-query overrides
// for the operator feel-test.
//
// Split out of main.ts like stt-config.ts / denoise-config.ts, so the default-ON
// wiring AND the same-origin guard are unit-testable headlessly (main.ts is
// DOM-coupled). Out-of-the-box (no query) the adapter points at the provisioned
// same-origin model, so a provisioned deploy classifies immediately and an
// un-provisioned one degrades to the labelled duration heuristic. Query params
// retune it without a code edit:
//
//   ?smartTurn=off                    → force the heuristic (A/B the model against it)
//   ?smartTurnModel=<same-origin url> → override the ONNX model URL
//
// There is deliberately no `?smartTurnWasm=`: the ONNX Runtime binaries must match
// the bundled runtime exactly (provision-smart-turn.mjs copies them from the
// installed onnxruntime-web for that reason), so pointing them elsewhere at runtime
// can only break the stage.

import { sanitizeEngineUrl } from './engine-url.ts';
import { DEFAULT_SMART_TURN_MODEL_URL, DEFAULT_SMART_TURN_WASM_PATH, type SmartTurnOptions } from './smart-turn.ts';

/** Operator kill-switch values for `?smartTurn=` that force the heuristic. Identical
 *  to the STT/LLM/TTS/denoise off-sets so the harness has one off vocabulary. */
const SMART_TURN_OFF_VALUES = new Set(['off', 'heuristic', 'none', '0', 'false', 'no']);

/**
 * Build the smart-turn config from a URL query string, defaulting to the
 * self-hosted model. Pure — `search` and `base` are the page's `location.search` /
 * `location.href`, passed in so this is testable headlessly.
 */
export function resolveSmartTurnOptions(search: string, base: string): SmartTurnOptions {
  const q = new URLSearchParams(search);

  // Kill-switch: force the heuristic (so the operator can A/B a live classifier
  // against the duration proxy the harness shipped with).
  if (SMART_TURN_OFF_VALUES.has((q.get('smartTurn') ?? '').trim().toLowerCase())) return {};

  // The model is fetched and executed on mic audio, so it is held to the same
  // same-origin rule as the engine modules: an unsafe override is warned and dropped
  // back to the safe default rather than silently disabling the classifier.
  let modelUrl = sanitizeEngineUrl(DEFAULT_SMART_TURN_MODEL_URL, base);
  const override = q.get('smartTurnModel');
  if (override) {
    const safe = sanitizeEngineUrl(override, base);
    if (safe) {
      modelUrl = safe;
    } else {
      console.warn(
        `Ignoring ?smartTurnModel=${override}: the smart-turn model must be same-origin/` +
          `self-hosted (it is run on microphone audio). Falling back to ${DEFAULT_SMART_TURN_MODEL_URL}.`,
      );
    }
  }

  return { modelUrl, wasmPath: DEFAULT_SMART_TURN_WASM_PATH };
}
