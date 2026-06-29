import { defineConfig } from 'vite';

// Rung 1 in-browser harness. A static page — `vite build` emits to dist/ and the
// result is serveable with no backend (matches the plan's "static page, no
// server"). onnxruntime-web is excluded from dep pre-bundling because it ships
// its own WASM/worker assets that esbuild should not rewrite.
export default defineConfig({
  build: { target: 'es2022', outDir: 'dist' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web', '@ricky0123/vad-web'] },
});
