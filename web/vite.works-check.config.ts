// Build/serve config for the works-check ONLY (su-ljrb.6) — the base
// vite.config.ts merged with a probe-only entry. The production build never uses
// this file, which is the whole probe-isolation story (origin U5/KTD3, resolved
// no-op by the su-ljrb.1 spike): `npm run build` bundles index.html alone, so
// probe.html / src/probe.ts simply do not exist in a deployed dist/. No in-app
// hook, no PROD guard needed.
//
// Deliberate divergences from the base build:
//   - input: probe.html only — the check needs the adapters + workers, not the app
//     page; building the app would only slow the gate down.
//   - outDir: .works-check/dist (gitignored) — a check run must never clobber a
//     real dist/ the operator built for deploy.
//   - copyPublicDir: false — public/ holds the provisioned model trees (multi-GB,
//     see .gitignore); byte-copying them per check run is prohibitive. The driver
//     hardlinks the needed subtrees into outDir after the build instead
//     (scripts/works-check.mjs), which vite preview then serves same-origin —
//     and provisionedAsset404 (inherited from the base config's plugins) keeps
//     answering a real 404 for files absent from outDir, the exact serving
//     contract the app depends on (su-lou.7 / su-5k1p).
//   - preview pinned to :4650 strictPort — the works-check mirror of the dev
//     server's pinned :5173 (su-lou.4.1): the driver gets a stable origin or a
//     fast, classifiable port-clash failure, never a silent port hop. 4650 also
//     keeps check runs from ever contending with a live `npm run dev`.
//
// The port and outDir themselves live in scripts/works-check.constants.mjs, which
// both this config and the driver import. They were defined here, which forced the
// CLI to import vite (and the base config's whole plugin graph) for two scalars.

import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig } from 'vite';

import base from './vite.config.ts';
import { WORKS_CHECK_OUT_DIR, WORKS_CHECK_PORT } from './scripts/works-check.constants.mjs';

export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: WORKS_CHECK_OUT_DIR,
      copyPublicDir: false,
      rollupOptions: { input: { probe: fileURLToPath(new URL('./probe.html', import.meta.url)) } },
    },
    preview: { port: WORKS_CHECK_PORT, strictPort: true },
  }),
);
