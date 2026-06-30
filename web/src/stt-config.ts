// Resolve the live STT config: self-hosted defaults, with URL-query overrides for
// the operator feel-test.
//
// Split out of main.ts so the default-on wiring AND the same-origin engine guard
// (su-0hi #1) are unit-testable headlessly — main.ts itself is DOM-coupled.
//
// Out-of-the-box (no query) the adapter uses the self-hosted engine + the
// Moonshine/Whisper defaults from stt.ts, so a provisioned deploy transcribes
// immediately and an un-provisioned one degrades to the labelled stub. Query
// params let the operator retune without a code edit:
//
//   ?stt=off                      → skip the worker entirely, use the labelled stub
//   ?sttEngine=<same-origin url>  → override the engine module (must be self-hosted)
//   ?sttModel=<id|path>           → override the Moonshine (primary) model
//   ?sttFallback=<id|path>        → override the Whisper (fallback) model

import { sanitizeEngineUrl } from './engine-url.ts';
import {
  DEFAULT_STT_ENGINE_URL,
  DEFAULT_MOONSHINE_MODEL,
  DEFAULT_WHISPER_MODEL,
  type TranscriberOptions,
} from './stt.ts';

// Operator kill-switch values for `?stt=` that force the labelled stub.
const STT_OFF_VALUES = new Set(['off', 'stub', 'none', '0', 'false', 'no']);

/**
 * Build the transcriber config from a URL query string, defaulting to the
 * self-hosted engine + models. Pure — `search` and `base` are the page's
 * `location.search` / `location.href`, passed in so this is testable headlessly.
 */
export function resolveSttOptions(search: string, base: string): TranscriberOptions {
  const q = new URLSearchParams(search);

  // Kill-switch: force the labelled stub (operator A/Bs a live model against it).
  if (STT_OFF_VALUES.has((q.get('stt') ?? '').trim().toLowerCase())) return {};

  // Engine module. Default = the committed self-hosted wrapper. An override must
  // ALSO be same-origin: the worker import()s this and feeds it live mic audio,
  // so a remote module would run attacker-controlled code on user speech
  // (su-0hi #1). An unsafe override is warned and dropped back to the safe
  // default rather than silently disabling STT.
  let engineUrl = sanitizeEngineUrl(DEFAULT_STT_ENGINE_URL, base);
  const engineOverride = q.get('sttEngine');
  if (engineOverride) {
    const safe = sanitizeEngineUrl(engineOverride, base);
    if (safe) {
      engineUrl = safe;
    } else {
      console.warn(
        `Ignoring ?sttEngine=${engineOverride}: the STT engine module must be same-origin/` +
          `self-hosted (it runs as code on microphone audio). Falling back to ${DEFAULT_STT_ENGINE_URL}.`,
      );
    }
  }

  // Models resolve under the engine's same-origin env.localModelPath (/models/).
  // `||` (not `??`) so an empty `?sttModel=` also falls back to the default.
  const moonshineModel = q.get('sttModel') || q.get('moonshine') || DEFAULT_MOONSHINE_MODEL;
  const whisperModel = q.get('sttFallback') || q.get('whisper') || DEFAULT_WHISPER_MODEL;

  return { engineUrl, moonshineModel, whisperModel };
}
