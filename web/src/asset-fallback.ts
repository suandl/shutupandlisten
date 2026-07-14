// Guard the provisioned same-origin asset trees against Vite's SPA history-fallback.
//
// THE BUG (U6, su-lou.7): the app serves its on-device model assets same-origin from
// public/ → dist/ (config.json, tokenizer.json, *.onnx, and the OPTIONAL files a
// transformers.js `from_pretrained` probes, e.g. generation_config.json). Vite's dev
// server and `vite preview` default to `appType: 'spa'`, whose html fallback rewrites
// ANY missing GET that accepts text/html or */* to `/index.html` — regardless of file
// extension. So a fetch for a NOT-provisioned optional file gets `200 text/html`
// (`<!doctype html>…`) instead of a real `404`. transformers.js reads the 200 as
// "file present", `JSON.parse()`s the HTML, throws `Unexpected token '<'`, and the TTS
// adapter degrades to the placeholder tone even though the core weights are present.
//
// THE FIX: before the SPA fallback runs, intercept requests under the provisioned
// asset roots. If the file physically exists it falls through to Vite's static
// middleware (served normally); if it does NOT exist we answer a real `404` so
// transformers.js correctly treats the optional file as absent and the pipeline loads.
// Doing our own existence check (rather than relying on middleware ordering vs. the
// static serve) keeps the guard self-contained and unit-testable with a fake req/res.
//
// The roots below are exactly the gitignored, provisioned public/ trees
// (see .gitignore) — models plus every engine root — so STT and the LLM, which share
// the same `/models/` tree and the identical from_pretrained probing, are covered too.

import { existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

import type { Plugin } from 'vite';

/**
 * URL prefixes for the provisioned, same-origin asset trees served from public/ →
 * dist/. Kept in lockstep with the gitignored `public/<root>/` trees in .gitignore
 * (asset-fallback.test.ts fails if a new provisioned root is added there but not here).
 */
export const PROVISIONED_ASSET_ROOTS = ['/models/', '/stt/', '/llm/', '/tts/', '/denoise/'];

/** True when `pathname` targets one of the provisioned asset trees. */
export function isProvisionedAssetPath(pathname: string): boolean {
  return PROVISIONED_ASSET_ROOTS.some((root) => pathname.startsWith(root));
}

/** Minimal structural view of the request fields the guard reads. */
interface AssetReq {
  url?: string;
  method?: string;
}
/** Minimal structural view of the response the guard may 404. */
interface AssetRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}
type NextFn = (err?: unknown) => void;

/**
 * A connect-style middleware that returns a real `404` for a MISSING file under a
 * provisioned asset root, instead of letting Vite's SPA fallback answer it with
 * `index.html`. Requests for existing assets, and every non-asset route (the SPA's
 * own client routes), fall through untouched via `next()`.
 *
 * @param serveDirs the filesystem roots the RUNNING server serves at the request URL —
 *                  and ONLY those (see serveDirsFor). A file present under any of them
 *                  is treated as served, so listing a root this mode does NOT serve
 *                  would suppress the 404 while Vite still can't find the file, handing
 *                  back index.html — the very trap this guard exists to close.
 * @param fileExists existence probe, injectable for tests (defaults to fs.existsSync).
 */
export function assetFallbackGuard(
  serveDirs: string[],
  fileExists: (path: string) => boolean = existsSync,
): (req: AssetReq, res: AssetRes, next: NextFn) => void {
  return (req, res, next) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return next();

    // Strip query/hash, decode percent-escapes; a malformed URL is left to Vite.
    let pathname: string;
    try {
      pathname = decodeURIComponent((req.url ?? '').split('?')[0].split('#')[0]);
    } catch {
      return next();
    }
    if (!isProvisionedAssetPath(pathname)) return next();

    // Resolve to a path under a serve dir without escaping it (a `..` probe that
    // climbs out is treated as absent → 404, never a filesystem walk).
    const rel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
    const found = serveDirs.some((dir) => fileExists(join(dir, rel)));
    if (found) return next(); // real provisioned asset → Vite's static middleware serves it

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`404 Not Found: ${pathname}`);
  };
}

/** The two server modes that serve the provisioned trees, each from a different root. */
type ServeMode = 'dev' | 'preview';

/** Minimal structural view of the resolved Vite config fields the plugin reads. */
interface ServeConfig {
  root: string;
  /** Absolute path, or '' when publicDir is disabled. */
  publicDir: string;
  build: { outDir: string };
}

/**
 * The roots `mode` actually serves at a provisioned-asset URL — the whole point being
 * that dev and preview serve DIFFERENT roots, so the guard must be handed one or the
 * other, never both (su-5k1p):
 *
 *   - dev serves `<root>/public` at `/`; it does not serve dist/. An asset left in a
 *     stale dist/ is NOT reachable.
 *   - `vite preview` serves the built `<root>/dist`; it does not serve public/ (the
 *     build copies public/ into dist/). An asset provisioned AFTER the last build is
 *     in public/ but NOT reachable.
 *
 * Hand the guard both roots and either case above suppresses the 404 for a file the
 * running server cannot actually serve — Vite's SPA fallback then answers it with
 * `200 index.html` and transformers.js is back to JSON.parse()ing HTML.
 *
 * (The provisioned trees live only under public/ → dist/ — they are the gitignored
 * `public/<root>/` dirs — so those are the only roots in play.)
 */
export function serveDirsFor(mode: ServeMode, config: ServeConfig): string[] {
  if (mode === 'preview') return [resolve(config.root, config.build.outDir)];
  return config.publicDir ? [config.publicDir] : []; // publicDir disabled → dev serves none
}

/**
 * Vite plugin: answer a MISSING provisioned asset with a real 404 instead of the SPA
 * index.html fallback, in both the dev server and `vite preview`.
 *
 * @param fileExists existence probe, injectable for tests (defaults to fs.existsSync).
 */
export function provisionedAsset404(
  fileExists: (path: string) => boolean = existsSync,
): Plugin {
  return {
    name: 'provisioned-asset-404',
    // Direct `.use()` (not a returned post-hook) installs BEFORE Vite's internal
    // middlewares, so we intercept the request ahead of the SPA html fallback.
    configureServer(server) {
      server.middlewares.use(assetFallbackGuard(serveDirsFor('dev', server.config), fileExists));
    },
    configurePreviewServer(server) {
      server.middlewares.use(assetFallbackGuard(serveDirsFor('preview', server.config), fileExists));
    },
  };
}
