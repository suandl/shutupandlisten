import { mergeConfig } from 'vite';

import base from './vite.config.ts';

// Build/serve config for the OPERATOR FEEL-TEST — the recurring post-merge gate
// where a human rates the live loop on real audio, and the recordings accrue into
// spec/turn-vectors/labeled/ (see that README). Written as a throwaway U6 scaffold
// (su-lou.10.6) and tracked afterwards (su-12qg): none of the serving model below
// is U6-specific — it is what makes the gate runnable at all — and it had been
// sitting as a single untracked copy in one working tree, one disk away from being
// re-derived from scratch.
//
// PREVIEW, not dev: su-lou.8's residual denoise-passthrough finding is suspected
// (su-ljrb.1) to be a dev-vs-preview artifact, so the feel-test runs against the
// built output a deploy would ship — which answers that residual for free.
//
// Serving model copied from vite.works-check.config.ts: build with copyPublicDir
// OFF (public/ holds ~3.3G of provisioned model trees) and HARDLINK public/ into
// dist/ afterwards, which `vite preview` then serves same-origin with the base
// config's provisionedAsset404 guard active. Nothing automates that hardlink here
// — the gate is driven by hand, and scripts/works-check.mjs (`linkTree`) is the
// worked example to copy.
//
// Vite 5.4 rejects a Host header it does not know, and the harness is reached
// through `tailscale serve` (:8443 → 127.0.0.1:5173), which forwards the tailnet
// name. Bound to loopback, so only the HTTPS proxy is reachable from the tailnet,
// never the raw http port — and HTTPS is what makes it a secure context, without
// which the browser refuses microphone access.
//
// FEELTEST_HOST is the one machine-specific value in this file: the tailnet name of
// the box that ran U6. A feel-test from a different machine must change it, or Vite
// answers the proxied request with a host-not-allowed error. That is also why no
// npm script wraps this config — `npm run <x>` reads as portable, and this is not.
const FEELTEST_HOST = 'ai-development.tail72658e.ts.net';
const FEELTEST_PORT = 5173;

export default mergeConfig(base, {
  build: { copyPublicDir: false },
  server: {
    host: '127.0.0.1',
    port: FEELTEST_PORT,
    strictPort: true,
    allowedHosts: [FEELTEST_HOST],
  },
  preview: {
    host: '127.0.0.1',
    port: FEELTEST_PORT,
    strictPort: true,
    allowedHosts: [FEELTEST_HOST],
  },
});
