// Regression guard for the live-mic dependency loading (su-lou.5).
//
// `@ricky0123/vad-web` (and its nested onnxruntime-web@1.14.0) ship as CommonJS.
// The mic path dynamic-imports vad-web (see vad.ts); if Vite serves it un-
// pre-bundled, the raw CJS reaches the browser and throws "exports is not
// defined" the moment Microphone mode starts — the bug this guard exists to
// prevent. Listing the lib in `optimizeDeps.exclude` is precisely what disables
// the CJS→ESM dep pre-bundling, so it must be in `include` and must NOT be in
// `exclude`.
//
// The browser-side behavior (mic permission + real Silero VAD firing) is an
// operator feel-test — there is no headless mic in CI. This test locks the one
// piece that IS deterministically checkable: the Vite config keeps the mic lib
// pre-bundled to ESM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../vite.config.ts';

const MIC_LIB = '@ricky0123/vad-web';

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

test('vite optimizeDeps pre-bundles the CJS mic lib to ESM (no "exports is not defined")', () => {
  const optimizeDeps = (config as { optimizeDeps?: { include?: unknown; exclude?: unknown } }).optimizeDeps ?? {};
  const include = asArray(optimizeDeps.include);
  const exclude = asArray(optimizeDeps.exclude);

  assert.ok(
    include.includes(MIC_LIB),
    `${MIC_LIB} must be in optimizeDeps.include so Vite pre-bundles its CommonJS into ESM; ` +
      `without it the dev server serves raw CJS and the mic throws "exports is not defined".`,
  );
  assert.ok(
    !exclude.includes(MIC_LIB),
    `${MIC_LIB} must NOT be in optimizeDeps.exclude — excluding it disables CJS→ESM ` +
      `pre-bundling and re-introduces the "exports is not defined" mic-load failure.`,
  );
});
