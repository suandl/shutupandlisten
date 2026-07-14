// Regression guard for the SPA-fallback trap on provisioned assets (su-lou.7).
//
// The defect: Vite's `appType:'spa'` html fallback answers a MISSING same-origin
// asset with `200 <!doctype html>` instead of `404`, so transformers.js
// JSON.parse()s the HTML on an optional model file and the TTS pipeline aborts to
// its stub. assetFallbackGuard fixes that by 404-ing missing files under the
// provisioned roots before the SPA fallback runs. These tests drive the middleware
// with a fake req/res so the exact HTTP behaviour is checked headlessly (no live
// Vite server needed), mirroring how engine-url.test.ts unit-tests sanitizeEngineUrl.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assetFallbackGuard,
  isProvisionedAssetPath,
  provisionedAsset404,
  PROVISIONED_ASSET_ROOTS,
  serveDirsFor,
} from './asset-fallback.ts';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fakeReq(url: string, method = 'GET') {
  return { url, method };
}
function fakeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      this.ended = true;
      if (chunk !== undefined) this.body = chunk;
    },
  };
}
/** Run the guard; report whether it fell through (next) or answered the response. */
function run(guard: ReturnType<typeof assetFallbackGuard>, req: { url: string; method?: string }) {
  const res = fakeRes();
  let nexted = false;
  guard(req, res, () => {
    nexted = true;
  });
  return { res, nexted };
}

test('a MISSING provisioned model asset returns 404, not the SPA index.html fallback', () => {
  // The exact repro from the bead: an optional file transformers.js probes.
  const guard = assetFallbackGuard(['/serve'], () => false); // nothing on disk
  const { res, nexted } = run(guard, fakeReq('/models/Xenova/mms-tts-eng/generation_config.json'));
  assert.equal(nexted, false, 'must NOT fall through to Vite’s SPA html fallback');
  assert.equal(res.statusCode, 404);
  assert.match(res.headers['content-type'] ?? '', /text\/plain/, 'a real 404, not 200 text/html');
  assert.equal(res.ended, true);
});

test('an EXISTING provisioned asset falls through to the static middleware', () => {
  const onDisk = join('/serve', 'models/Xenova/mms-tts-eng/config.json');
  const guard = assetFallbackGuard(['/serve'], (p) => p === onDisk);
  const { res, nexted } = run(guard, fakeReq('/models/Xenova/mms-tts-eng/config.json'));
  assert.equal(nexted, true, 'a real provisioned asset must be served normally');
  assert.equal(res.ended, false, 'the guard must not answer the response for a present file');
});

// --- mode-specific serve roots (su-5k1p) -------------------------------------------
//
// Dev and preview serve DIFFERENT roots: the dev server serves <root>/public at `/`,
// while `vite preview` serves the built <root>/dist. The first cut of the plugin passed
// BOTH roots to BOTH hooks; since the guard treats a file present in any listed root as
// served, an asset sitting in the root the running mode does NOT serve suppressed the
// 404 — and Vite answered the still-unreachable asset with the SPA index.html, reviving
// the exact JSON.parse(HTML) failure this module exists to kill.
//
// Both misses below are ordinary, not contrived: dev hits it with a stale dist/ from an
// earlier `vite build`, and preview hits it whenever an asset is provisioned AFTER the
// last build. These drive the plugin's REAL hooks (not a hand-built dir list), because
// the defect was in the wiring — a combined list would regress them.

const FAKE_CONFIG = { root: '/proj', publicDir: '/proj/public', build: { outDir: 'dist' } };
const ASSET_URL = '/tts/mms-tts-eng/generation_config.json';
const IN_PUBLIC = join('/proj/public', 'tts/mms-tts-eng/generation_config.json');
const IN_DIST = join('/proj/dist', 'tts/mms-tts-eng/generation_config.json');

type Middleware = ReturnType<typeof assetFallbackGuard>;
interface FakeServer {
  config: typeof FAKE_CONFIG;
  middlewares: { use(fn: Middleware): void };
}

/** Install the plugin's guard for ONE server mode over a fake on-disk layout, then run
 *  a request through the middleware Vite itself would have been handed. */
function runMode(mode: 'dev' | 'preview', onDisk: string[], url = ASSET_URL) {
  const plugin = provisionedAsset404((path) => onDisk.includes(path));
  const hook: unknown = mode === 'dev' ? plugin.configureServer : plugin.configurePreviewServer;
  // A Vite hook is either the function or an { handler } object; ours are functions.
  const raw = typeof hook === 'function' ? hook : (hook as { handler?: unknown } | undefined)?.handler;
  assert.equal(typeof raw, 'function', `${mode}: the plugin must install a guard for this mode`);

  let middleware: Middleware | undefined;
  (raw as (server: FakeServer) => void)({
    config: FAKE_CONFIG,
    middlewares: {
      use(fn: Middleware) {
        middleware = fn;
      },
    },
  });
  assert.ok(middleware, `${mode}: the plugin must install the guard middleware`);
  return run(middleware, fakeReq(url));
}

test('dev: an asset present ONLY in the unserved dist/ still 404s (stale build)', () => {
  const { res, nexted } = runMode('dev', [IN_DIST]);
  assert.equal(nexted, false, 'dev serves public/, not dist/ — a dist-only file must not suppress the 404');
  assert.equal(res.statusCode, 404);
  assert.match(res.headers['content-type'] ?? '', /text\/plain/, 'a real 404, not the 200 text/html fallback');
});

test('dev: an asset present in the served public/ falls through to Vite', () => {
  const { res, nexted } = runMode('dev', [IN_PUBLIC]);
  assert.equal(nexted, true, 'dev serves public/ — a real provisioned asset must be served normally');
  assert.equal(res.ended, false);
});

test('preview: an asset present ONLY in the unserved public/ still 404s (provisioned after the build)', () => {
  const { res, nexted } = runMode('preview', [IN_PUBLIC]);
  assert.equal(nexted, false, 'preview serves dist/, not public/ — a public-only file must not suppress the 404');
  assert.equal(res.statusCode, 404);
  assert.match(res.headers['content-type'] ?? '', /text\/plain/, 'a real 404, not the 200 text/html fallback');
});

test('preview: an asset present in the served dist/ falls through to Vite', () => {
  const { res, nexted } = runMode('preview', [IN_DIST]);
  assert.equal(nexted, true, 'preview serves dist/ — a built asset must be served normally');
  assert.equal(res.ended, false);
});

test('serveDirsFor hands each mode only the root it serves', () => {
  assert.deepEqual(serveDirsFor('dev', FAKE_CONFIG), ['/proj/public'], 'dev serves publicDir');
  assert.deepEqual(serveDirsFor('preview', FAKE_CONFIG), [resolve('/proj', 'dist')], 'preview serves the outDir');
  // publicDir disabled → dev serves no provisioned root at all, so every asset URL is a
  // miss. An empty list is right; falling back to dist/ here is what caused the bug.
  assert.deepEqual(serveDirsFor('dev', { ...FAKE_CONFIG, publicDir: '' }), []);
});

test('every provisioned engine/model root is guarded; SPA routes are left alone', () => {
  const guard = assetFallbackGuard(['/serve'], () => false);
  for (const root of ['/models/', '/stt/', '/llm/', '/tts/', '/denoise/']) {
    assert.ok(isProvisionedAssetPath(`${root}missing.json`), `${root} must be a guarded root`);
    const { res } = run(guard, fakeReq(`${root}missing.json`));
    assert.equal(res.statusCode, 404, `${root} miss must 404`);
  }
  // The SPA's own client routes and top-level bundles must still reach the fallback.
  for (const url of ['/', '/index.html', '/some/spa/route', '/assets/app-abc123.js', '/tts-engine.js']) {
    const { res, nexted } = run(guard, fakeReq(url));
    assert.equal(nexted, true, `${url} must pass through to Vite`);
    assert.equal(res.statusCode, 200, `${url} must not be 404’d`);
  }
});

test('the query string is stripped before matching (…/x.json?foo still 404s when absent)', () => {
  const guard = assetFallbackGuard(['/serve'], () => false);
  const { res } = run(guard, fakeReq('/models/x/nonexistent.json?v=2#frag'));
  assert.equal(res.statusCode, 404);
});

test('HEAD is guarded like GET; non-GET/HEAD methods are ignored', () => {
  const guard = assetFallbackGuard(['/serve'], () => false);
  assert.equal(run(guard, fakeReq('/models/x/missing.json', 'HEAD')).res.statusCode, 404);
  const post = run(guard, fakeReq('/models/x/missing.json', 'POST'));
  assert.equal(post.nexted, true, 'a POST is not the SPA-fallback path — leave it to Vite');
});

test('a "../" escape attempt cannot probe outside a serve dir', () => {
  const probed: string[] = [];
  const guard = assetFallbackGuard(['/serve'], (p) => {
    probed.push(p);
    return false;
  });
  const { res } = run(guard, fakeReq('/models/../../../etc/passwd'));
  assert.equal(res.statusCode, 404);
  for (const p of probed) assert.ok(p.startsWith('/serve'), `existence probe escaped the serve dir: ${p}`);
});

test('every gitignored provisioned public/ tree is covered by the guard', () => {
  // Prevents the "STT/LLM will bite next" recurrence the bead calls out: a new
  // provisioned root added to .gitignore (public/<x>/) but forgotten in
  // PROVISIONED_ASSET_ROOTS would silently reintroduce the 200-HTML-not-404 trap.
  const gitignore = readFileSync(join(WEB_ROOT, '.gitignore'), 'utf8');
  const provisioned = [...gitignore.matchAll(/^public\/([^/\n]+)\/$/gm)].map((m) => `/${m[1]}/`);
  assert.ok(provisioned.length > 0, 'sanity: .gitignore must list the provisioned public/ trees');
  for (const root of provisioned) {
    assert.ok(
      PROVISIONED_ASSET_ROOTS.includes(root),
      `${root} is a gitignored provisioned asset tree but is not guarded from the SPA fallback ` +
        `(add it to PROVISIONED_ASSET_ROOTS in asset-fallback.ts)`,
    );
  }
});
