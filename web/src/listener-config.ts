// Resolve the live listener-LLM config: self-hosted defaults, with URL-query
// overrides for the operator feel-test. The U5 mirror of stt-config.ts.
//
// Split out of main.ts so the default-on wiring AND the same-origin engine guard
// (su-0hi #1) are unit-testable headlessly — main.ts itself is DOM-coupled.
//
// Out-of-the-box (no query) the adapter uses the self-hosted engine + the small
// instruct model default from listener.ts, so a provisioned deploy responds
// immediately and an un-provisioned one degrades to the labelled stub. Query
// params let the operator retune without a code edit:
//
//   ?llm=off                      → skip the worker entirely, use the labelled stub
//   ?llmEngine=<same-origin url>  → override the engine module (must be self-hosted)
//   ?llmModel=<id|path>           → override the on-device instruct model

import { sanitizeEngineUrl } from './engine-url.ts';
import { DEFAULT_LLM_ENGINE_URL, DEFAULT_LLM_MODEL, type ListenerOptions } from './listener.ts';

// Operator kill-switch values for `?llm=` that force the labelled stub.
const LLM_OFF_VALUES = new Set(['off', 'stub', 'none', '0', 'false', 'no']);

/**
 * Build the listener config from a URL query string, defaulting to the self-hosted
 * engine + model. Pure — `search` and `base` are the page's `location.search` /
 * `location.href`, passed in so this is testable headlessly.
 */
export function resolveListenerOptions(search: string, base: string): ListenerOptions {
  const q = new URLSearchParams(search);

  // Kill-switch: force the labelled stub (operator A/Bs a live model against it).
  if (LLM_OFF_VALUES.has((q.get('llm') ?? '').trim().toLowerCase())) return {};

  // Engine module. Default = the committed self-hosted wrapper. An override must
  // ALSO be same-origin: the worker import()s this and generates on the thinker's
  // words, so a remote module would run attacker-controlled code on that text
  // (su-0hi #1). An unsafe override is warned and dropped back to the safe default
  // rather than silently disabling the listener.
  let engineUrl = sanitizeEngineUrl(DEFAULT_LLM_ENGINE_URL, base);
  const engineOverride = q.get('llmEngine');
  if (engineOverride) {
    const safe = sanitizeEngineUrl(engineOverride, base);
    if (safe) {
      engineUrl = safe;
    } else {
      console.warn(
        `Ignoring ?llmEngine=${engineOverride}: the listener engine module must be same-origin/` +
          `self-hosted (it runs as code on the thinker's words). Falling back to ${DEFAULT_LLM_ENGINE_URL}.`,
      );
    }
  }

  // Model resolves under the engine's same-origin env.localModelPath (/models/).
  // `||` (not `??`) so an empty `?llmModel=` also falls back to the default.
  const model = q.get('llmModel') || DEFAULT_LLM_MODEL;

  return { engineUrl, model };
}
