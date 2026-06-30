import { defineConfig } from 'vite';

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
  build: { target: 'es2022', outDir: 'dist' },
  worker: { format: 'es' },
  optimizeDeps: { include: ['@ricky0123/vad-web'] },
});
