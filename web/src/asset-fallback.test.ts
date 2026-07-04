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

import { assetFallbackGuard, isProvisionedAssetPath, PROVISIONED_ASSET_ROOTS } from './asset-fallback.ts';

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

test('an asset present in ANY serve dir (publicDir OR outDir) is served', () => {
  const onDisk = join('/dist', 'tts/manifest.json');
  const guard = assetFallbackGuard(['/public', '/dist'], (p) => p === onDisk);
  const { nexted } = run(guard, fakeReq('/tts/manifest.json'));
  assert.equal(nexted, true);
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
