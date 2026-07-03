// Resolve the live denoise config: self-hosted default engine, with URL-query
// overrides for the operator feel-test.
//
// Split out of main.ts (mirroring stt-config.ts) so the default-on wiring AND the
// same-origin engine guard are unit-testable headlessly — main.ts itself is
// DOM-coupled. Out-of-the-box (no query) the adapter points at the committed
// self-hosted engine, so a provisioned deploy denoises immediately and an
// un-provisioned one degrades to passthrough. Query params let the operator
// retune the coffee-shop feel-test without a code edit:
//
//   ?denoise=off                     → force passthrough (kill switch; A/B the raw mic)
//   ?denoiseEngine=<same-origin url> → override the engine module (must be self-hosted)
//
// There is deliberately no `?denoiseModel=`: RNNoise bakes its weights into the
// wasm, and an alternate engine (DTLN/ONNX) owns its own model assets behind its
// module URL — so engine selection IS `?denoiseEngine=`, matching how each
// adapter's engine wrapper resolves its own weights.

import { sanitizeEngineUrl } from './engine-url.ts';
import { DEFAULT_DENOISE_ENGINE_URL, type DenoiserOptions } from './denoise.ts';

// Operator kill-switch values for `?denoise=` that force passthrough. Identical
// to the STT/LLM/TTS off-sets so the whole harness shares one off vocabulary.
const DENOISE_OFF_VALUES = new Set(['off', 'passthrough', 'none', '0', 'false', 'no']);

/**
 * Build the denoiser config from a URL query string, defaulting to the
 * self-hosted engine. Pure — `search` and `base` are the page's
 * `location.search` / `location.href`, passed in so this is testable headlessly.
 */
export function resolveDenoiseOptions(search: string, base: string): DenoiserOptions {
  const q = new URLSearchParams(search);

  // Kill-switch: force passthrough (operator A/Bs denoise against the raw mic).
  if (DENOISE_OFF_VALUES.has((q.get('denoise') ?? '').trim().toLowerCase())) {
    return { disabled: true };
  }

  // Engine module. Default = the committed self-hosted wrapper. An override must
  // ALSO be same-origin: the adapter import()s this and runs it on live mic
  // audio, so a remote module would run attacker-controlled code on user speech.
  // An unsafe override is warned and dropped back to the safe default rather than
  // silently disabling denoise.
  let engineUrl = sanitizeEngineUrl(DEFAULT_DENOISE_ENGINE_URL, base);
  const engineOverride = q.get('denoiseEngine');
  if (engineOverride) {
    const safe = sanitizeEngineUrl(engineOverride, base);
    if (safe) {
      engineUrl = safe;
    } else {
      console.warn(
        `Ignoring ?denoiseEngine=${engineOverride}: the denoise engine module must be same-origin/` +
          `self-hosted (it runs as code on microphone audio). Falling back to ${DEFAULT_DENOISE_ENGINE_URL}.`,
      );
    }
  }

  return { engineUrl };
}
