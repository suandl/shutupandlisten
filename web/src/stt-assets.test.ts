// Asset-presence guard for the self-hosted STT provisioning (the test referenced
// from scripts/provision-stt.mjs).
//
// The no-egress design has two halves: a small COMMITTED same-origin wrapper
// (public/stt-engine.js) and the large PROVISIONED, gitignored binaries (engine
// bundle + ONNX Runtime wasm + Moonshine/Whisper weights under public/stt/ and
// public/models/, fetched by `npm run provision:stt` at build/deploy). This guard
// holds that contract:
//
//   • the committed wrapper and the provision script are always present and wired;
//   • the heavy assets stay gitignored (a stray `git add -A` must never commit
//     hundreds of MB of weights);
//   • the wrapper and the provisioner agree on the same-origin layout they share;
//   • WHEN provisioned (manifest present), every listed file is actually on disk.
//
// All unconditional assertions are CI-safe: with no assets provisioned the app
// degrades to the labelled stub, which is the documented default. The manifest
// check only runs once `provision:stt` has populated public/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(WEB_ROOT, 'public');
const ENGINE_WRAPPER = join(PUBLIC, 'stt-engine.js');
const PROVISION_SCRIPT = join(WEB_ROOT, 'scripts', 'provision-stt.mjs');
const GITIGNORE = join(WEB_ROOT, '.gitignore');
const PACKAGE_JSON = join(WEB_ROOT, 'package.json');
const MANIFEST = join(PUBLIC, 'stt', 'manifest.json');

const nonEmpty = (p: string) => existsSync(p) && statSync(p).size > 0;

test('the committed same-origin engine wrapper is present', () => {
  assert.ok(nonEmpty(ENGINE_WRAPPER), 'public/stt-engine.js (the default engineUrl) must be committed');
});

test('the wrapper pins the no-egress posture and the shared same-origin layout', () => {
  const src = readFileSync(ENGINE_WRAPPER, 'utf8');
  // Engine bundle resolves under ./stt/transformers/ — exactly where
  // provision-stt.mjs writes it. Keeps wrapper and provisioner from drifting.
  assert.match(src, /from\s+['"]\.\/stt\/transformers\//, 'wrapper must import the engine from ./stt/transformers/');
  // No third-party model fetches at runtime.
  assert.match(src, /allowRemoteModels\s*=\s*false/, 'wrapper must disable remote model fetches');
  // Weights resolve from our origin under ./models/.
  assert.match(src, /localModelPath\s*=.*models\//, 'wrapper must point localModelPath at ./models/');
});

test('the provision script exists and is wired into package.json', () => {
  assert.ok(nonEmpty(PROVISION_SCRIPT), 'scripts/provision-stt.mjs must exist');
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  assert.match(
    pkg.scripts?.['provision:stt'] ?? '',
    /provision-stt\.mjs/,
    'package.json must expose `provision:stt`',
  );
});

test('the heavy provisioned asset trees stay gitignored', () => {
  const ignore = readFileSync(GITIGNORE, 'utf8');
  for (const dir of ['public/stt/', 'public/models/']) {
    assert.match(ignore, new RegExp(`^${dir}$`, 'm'), `${dir} must be gitignored (large binaries, never committed)`);
  }
});

test('when provisioned, every file the manifest lists is present and non-empty', {
  skip: existsSync(MANIFEST) ? false : 'un-provisioned (CI default) — app degrades to the labelled stub',
}, () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.ok(typeof manifest.transformersVersion === 'string' && manifest.transformersVersion.length > 0);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest must record provisioned files');
  for (const f of manifest.files) {
    assert.ok(nonEmpty(join(PUBLIC, f.file)), `provisioned asset missing on disk: ${f.file}`);
  }
});
