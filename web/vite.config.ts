import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import { resolve } from 'node:path';

import { assetFallbackGuard } from './src/asset-fallback.ts';

// Serve the provisioned same-origin model/engine assets, but answer a MISSING one
// with a real 404 instead of Vite's SPA index.html fallback. Without this, a fetch
// for an optional file transformers.js probes (e.g. generation_config.json) that was
// never provisioned returns `200 <!doctype html>`; transformers.js JSON.parse()s the
// HTML, throws, and the TTS pipeline (and, once provisioned, STT/LLM — they share the
// `/models/` tree) aborts to its stub. Covers both the dev server and `vite preview`
// (the dist/ static serve). See src/asset-fallback.ts (su-lou.7).
function provisionedAsset404(): Plugin {
  const serveDirs = (config: ResolvedConfig): string[] => {
    const dirs: string[] = [];
    if (config.publicDir) dirs.push(config.publicDir); // dev serves <root>/public at /
    dirs.push(resolve(config.root, config.build.outDir)); // preview serves the built <root>/dist
    return dirs;
  };
  return {
    name: 'provisioned-asset-404',
    // Direct `.use()` (not a returned post-hook) installs BEFORE Vite's internal
    // middlewares, so we intercept the request ahead of the SPA html fallback.
    configureServer(server) {
      server.middlewares.use(assetFallbackGuard(serveDirs(server.config)));
    },
    configurePreviewServer(server) {
      server.middlewares.use(assetFallbackGuard(serveDirs(server.config)));
    },
  };
}

// Rung 1 in-browser harness. A static page — `vite build` emits to dist/ and the
// result is serveable with no backend (matches the plan's "static page, no
// server").
//
// `@ricky0123/vad-web` ships as CommonJS (`exports.MicVAD = ...`, `require(...)`),
// and its single mic dependency `onnxruntime-web@1.14.0` is CJS too. Served raw by
// the dev server they hit the browser un-transformed and throw
// "exports is not defined" the moment the mic path dynamic-imports them — the live
// mic never starts. The previous config put BOTH libs in `optimizeDeps.exclude`,
// which is exactly what disables Vite's CJS→ESM dep pre-bundling, so it caused the
// failure rather than preventing it.
//
// The fix is to pre-bundle the JS (`include`) so esbuild rewrites the CJS into
// clean ESM. We must NOT also list these in `exclude`: vad-web carries its own
// nested onnxruntime-web@1.14.0, and excluding the bare name "onnxruntime-web"
// would make esbuild keep that import external and mis-resolve it to the
// hoisted root onnxruntime-web@1.27.0 — an API/wasm-version mismatch. Letting
// esbuild inline vad-web's nested copy keeps it self-consistent.
//
// The WASM/worklet/model ASSETS the old comment worried about are never emitted by
// our build: vad-web fetches the worklet + Silero model from its CDN `baseAssetPath`
// and sets `ort.env.wasm.wasmPaths` to a CDN at runtime (see real-time-vad.ts).
// Pre-bundling the JS leaves those runtime fetches untouched.
export default defineConfig({
  plugins: [provisionedAsset404()],
  build: { target: 'es2022', outDir: 'dist' },
  worker: { format: 'es' },
  optimizeDeps: { include: ['@ricky0123/vad-web'] },
  // main.ts imports the listener system prompt from ../../prompts/chatgpt.md?raw
  // (single source of truth, no TS copy to drift). The dev server restricts file
  // serving to the project root by default; allow the parent so that raw import
  // resolves. Vite build inlines the string, so this only affects `vite dev`.
  server: { fs: { allow: ['..'] } },
});
