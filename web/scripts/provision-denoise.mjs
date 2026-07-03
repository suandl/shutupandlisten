#!/usr/bin/env node
// Provision the self-hosted denoise assets — run at BUILD/DEPLOY, never at app
// runtime. Downloads the adopted RNNoise AudioWorklet + wasm into web/public/,
// where Vite copies them into dist/ and the app serves them SAME-ORIGIN
// (public/denoise-engine.js import()s them). This is the deploy-time half of the
// no-egress design for the denoise stage: the browser never fetches the worklet
// or wasm cross-origin and no user audio leaves the page (see src/denoise.ts,
// public/denoise-engine.js, README).
//
// Layout it writes (all gitignored — see web/.gitignore):
//   public/denoise/rnnoise/workletProcessor.js  the RNNoise AudioWorklet processor
//   public/denoise/rnnoise.wasm                 scalar RNNoise wasm
//   public/denoise/rnnoise_simd.wasm            SIMD RNNoise wasm
//   public/denoise/manifest.json                what was provisioned (provenance)
//
// Absent assets are fine: public/denoise-engine.js's addModule/fetch 404s and
// the adapter degrades to passthrough. So this script is optional for a
// passthrough-only deploy and required only to make the harness actually
// denoise.
//
// Usage:
//   node scripts/provision-denoise.mjs           # provision
//   node scripts/provision-denoise.mjs --force   # re-download existing files
// Env override: DENOISE_PACKAGE_VERSION (npm version of @sapphi-red/web-noise-suppressor).

import { mkdir, rename, stat, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const PUBLIC = join(WEB_ROOT, 'public');

// Adopted denoise engine: RNNoise (Xiph, https://github.com/xiph/rnnoise) as
// packaged for the Web Audio API by @sapphi-red/web-noise-suppressor (MIT). Pin
// deliberately and re-test in a browser on bump: the processor name in
// public/denoise-engine.js is tied to this package's worklet.
const PKG = '@sapphi-red/web-noise-suppressor';
const VERSION = process.env.DENOISE_PACKAGE_VERSION || '0.3.5';
const UPSTREAM = 'RNNoise (Xiph) — https://github.com/xiph/rnnoise';

const JSDELIVR = (file) => `https://cdn.jsdelivr.net/npm/${PKG}@${VERSION}/dist/${file}`;

// Source path under the package dist → destination under public/denoise/.
const FILES = [
  { src: 'rnnoise/workletProcessor.js', dest: 'rnnoise/workletProcessor.js' },
  { src: 'rnnoise.wasm', dest: 'rnnoise.wasm' },
  { src: 'rnnoise_simd.wasm', dest: 'rnnoise_simd.wasm' },
];

function parseArgs(argv) {
  const out = { force: false };
  for (const a of argv) {
    if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown arg: ${a} (see --help)`);
  }
  return out;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

// Stream a URL to dest (atomic: write .part then rename). Returns byte size.
async function downloadTo(url, dest, { force }) {
  if (!force && (await exists(dest))) {
    return (await stat(dest)).size;
  }
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const tmp = `${dest}.part`;
  try {
    await streamPipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  const { size } = await stat(dest);
  if (size === 0) {
    await rm(dest, { force: true }).catch(() => {});
    throw new Error(`downloaded 0 bytes from ${url}`);
  }
  return size;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'Provision the self-hosted denoise assets into web/public/denoise/ (the',
        'RNNoise AudioWorklet + wasm). Run at build/deploy.',
        '',
        '  node scripts/provision-denoise.mjs [--force]',
        '',
        `  engine : ${PKG}@${VERSION}`,
        `  upstream: ${UPSTREAM}`,
      ].join('\n'),
    );
    return;
  }

  const log = (m) => console.log(m);
  log(`Provisioning denoise assets → ${join(PUBLIC, 'denoise')} (${PKG}@${VERSION})${args.force ? ' (--force)' : ''}`);

  const files = [];
  for (const f of FILES) {
    const dest = join(PUBLIC, 'denoise', f.dest);
    const bytes = await downloadTo(JSDELIVR(f.src), dest, { force: args.force });
    log(`  ✓ denoise/${f.dest}  ${fmtBytes(bytes)}`);
    files.push({ file: `denoise/${f.dest}`, bytes });
  }

  // Manifest = machine-readable provenance (what/where/version), mirroring
  // public/stt/manifest.json. Lives under gitignored public/denoise/.
  const manifest = {
    generatedBy: 'scripts/provision-denoise.mjs',
    generatedAt: new Date().toISOString(),
    engine: PKG,
    engineVersion: VERSION,
    processorName: '@sapphi-red/web-noise-suppressor/rnnoise',
    upstream: UPSTREAM,
    files,
  };
  await mkdir(join(PUBLIC, 'denoise'), { recursive: true });
  await writeFile(join(PUBLIC, 'denoise', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const total = files.reduce((n, f) => n + f.bytes, 0);
  log(`\nDone: ${files.length} file(s), ${fmtBytes(total)} total. Run \`npm run build\` to bundle into dist/.`);
}

main().catch((err) => {
  console.error(`\nprovision-denoise failed: ${err.message}`);
  console.error('If a file 404s, the pinned version may have moved — adjust DENOISE_PACKAGE_VERSION or the top of this script.');
  process.exitCode = 1;
});
