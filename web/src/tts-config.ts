// Resolve the live TTS config: self-hosted defaults, with URL-query overrides for
// the operator feel-test. The U6 mirror of stt-config.ts / listener-config.ts.
//
// Split out of main.ts so the default-on wiring AND the same-origin engine guard
// (su-0hi #1) are unit-testable headlessly — main.ts itself is DOM-coupled.
//
// Out-of-the-box (no query) the adapter uses the self-hosted engine + the placeholder
// voice default from tts.ts, so a provisioned deploy speaks immediately and an
// un-provisioned one degrades to the placeholder tone. Query params let the operator
// retune without a code edit:
//
//   ?tts=off                      → skip the worker entirely, use the placeholder tone
//   ?ttsEngine=<same-origin url>  → override the engine module (must be self-hosted)
//   ?ttsModel=<id|path>           → override the on-device voice model

import { sanitizeEngineUrl } from './engine-url.ts';
import { DEFAULT_TTS_ENGINE_URL, DEFAULT_TTS_MODEL, type SpeakerOptions } from './tts.ts';

// Operator kill-switch values for `?tts=` that force the placeholder tone.
const TTS_OFF_VALUES = new Set(['off', 'stub', 'none', '0', 'false', 'no']);

/**
 * Build the TTS config from a URL query string, defaulting to the self-hosted
 * engine + model. Pure — `search` and `base` are the page's `location.search` /
 * `location.href`, passed in so this is testable headlessly.
 */
export function resolveTtsOptions(search: string, base: string): SpeakerOptions {
  const q = new URLSearchParams(search);

  // Kill-switch: force the placeholder tone (operator A/Bs a live voice against it).
  if (TTS_OFF_VALUES.has((q.get('tts') ?? '').trim().toLowerCase())) return {};

  // Engine module. Default = the committed self-hosted wrapper. An override must
  // ALSO be same-origin: the worker import()s this and runs it as code to voice the
  // listener's reply, so a remote module would run attacker-controlled code on that
  // reply text (and could exfiltrate it), breaking the no-egress posture (su-0hi #1).
  // An unsafe override is warned and dropped back to the safe default rather than
  // silently muting the voice.
  let engineUrl = sanitizeEngineUrl(DEFAULT_TTS_ENGINE_URL, base);
  const engineOverride = q.get('ttsEngine');
  if (engineOverride) {
    const safe = sanitizeEngineUrl(engineOverride, base);
    if (safe) {
      engineUrl = safe;
    } else {
      console.warn(
        `Ignoring ?ttsEngine=${engineOverride}: the TTS engine module must be same-origin/` +
          `self-hosted (it runs as code to voice the reply). Falling back to ${DEFAULT_TTS_ENGINE_URL}.`,
      );
    }
  }

  // Model resolves under the engine's same-origin env.localModelPath (/models/).
  // `||` (not `??`) so an empty `?ttsModel=` also falls back to the default.
  const model = q.get('ttsModel') || DEFAULT_TTS_MODEL;

  return { engineUrl, model };
}
