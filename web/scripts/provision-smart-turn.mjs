#!/usr/bin/env node
// Provision the self-hosted smart-turn v3 assets — run at BUILD/DEPLOY, never at app
// runtime. Downloads the pinned end-of-utterance classifier into web/public/ and
// copies the matching ONNX Runtime wasm next to it, where Vite copies them into
// dist/ and the app serves them SAME-ORIGIN (src/smart-turn.ts loads both). This is
// the deploy-time half of the no-egress design for the EOU stage: the browser never
// fetches model or runtime cross-origin and no user audio leaves the page.
//
// WHY THIS SCRIPT EXISTS (su-lou.10.1): it did not, which is why the classifier had
// NEVER RUN — src/smart-turn.ts returned its duration heuristic on every call
// because no URL ever pointed at a model. With no real EOU signal the 2000ms silence
// floor carried all the patience alone, the "uniformly long pause" the 2026-07-21
// feel-test reported.
//
// Layout it writes (all gitignored — see web/.gitignore):
//   public/smart-turn/smart-turn-v3.onnx           the pinned int8 CPU export
//   public/smart-turn/ort/ort-wasm-simd-threaded.* the CPU/WASM ONNX Runtime
//   public/smart-turn/manifest.json                what was provisioned (provenance)
//
// Absent assets are fine: the model fetch 404s (the SPA-fallback guard in
// src/asset-fallback.ts makes sure that is a real 404 and not index.html — su-lou.7)
// and the adapter degrades to the labelled heuristic. So this script is optional for
// a heuristic-only deploy and required to make the harness actually classify —
// which `npm run works-check` asserts.
//
// Usage:
//   node scripts/provision-smart-turn.mjs           # provision
//   node scripts/provision-smart-turn.mjs --force   # re-download/re-copy existing files
// Env override: SMART_TURN_MODEL_FILE (a file in the pinned HF repo, e.g.
// smart-turn-v3.1-cpu.onnx), SMART_TURN_REPO (HF repo id).

import { copyFile, mkdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const PUBLIC = join(WEB_ROOT, 'public');
const OUT_DIR = join(PUBLIC, 'smart-turn');

// Adopted classifier: Pipecat smart-turn v3 (BSD-2-Clause) — a Whisper-tiny encoder
// plus a shallow classifier head, 8M params, int8 ONNX, ~12ms on CPU.
// https://huggingface.co/pipecat-ai/smart-turn-v3
//
// Pinned to the v3.2 CPU export: the newest of the v3.x line and the same 8.7MB int8
// graph shape as v3.1 (input `input_features` [1, 80, 800], output `logits` already
// sigmoid-ed). Bump deliberately and re-run `npm run works-check`: the front-end in
// src/whisper-mel.ts encodes v3's 8-second Whisper chunk, so a future export with a
// different chunk length needs that constant changed too.
const REPO = process.env.SMART_TURN_REPO || 'pipecat-ai/smart-turn-v3';
const MODEL_FILE = process.env.SMART_TURN_MODEL_FILE || 'smart-turn-v3.2-cpu.onnx';
const UPSTREAM = 'Pipecat smart-turn v3 — https://github.com/pipecat-ai/smart-turn';
/** Served under a version-independent name so the app's default URL never moves. */
const MODEL_DEST = 'smart-turn-v3.onnx';

const HF_FILE = (repo, rf) => `https://huggingface.co/${repo}/resolve/main/${rf}`;

// ONNX Runtime wasm for the CPU/WASM backend. COPIED from the installed
// onnxruntime-web rather than downloaded: the JS half is bundled into the app by
// Vite, so the binaries MUST come from the same version — a CDN pin here could drift
// out of lockstep with the lockfile and fail at first speech, in the browser, with a
// wasm magic-number error. src/smart-turn.ts imports `onnxruntime-web/wasm` (the
// CPU-only build — the default bundle also carries the 2x-larger WebGPU binary, and
// this stage promises not to touch the GPU the LLM/TTS use).
const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

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

/** Copy a file out of node_modules (atomic, same shape as downloadTo). */
async function copyInto(src, dest, { force }) {
  if (!force && (await exists(dest))) {
    return (await stat(dest)).size;
  }
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    await copyFile(src, tmp);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return (await stat(dest)).size;
}

/**
 * Locate the installed onnxruntime-web binaries + version (the runtime Vite bundles).
 * Each wasm/mjs file is resolved through the package's OWN exports map — which does
 * not expose ./package.json, so the version is read off the filesystem instead.
 */
async function ortDist() {
  const require = createRequire(import.meta.url);
  const paths = {};
  for (const f of ORT_FILES) {
    try {
      paths[f] = require.resolve(`onnxruntime-web/${f}`, { paths: [WEB_ROOT] });
    } catch {
      throw new Error(`onnxruntime-web does not provide ${f} — run \`npm install\` in web/, or check the pinned version`);
    }
  }
  let version = 'unknown';
  try {
    const pkgPath = join(dirname(dirname(paths[ORT_FILES[0]])), 'package.json');
    version = JSON.parse(await readFile(pkgPath, 'utf8')).version;
  } catch {
    /* provenance only — a missing version must not fail the provision */
  }
  return { paths, version };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'Provision the self-hosted smart-turn v3 assets into web/public/smart-turn/',
        '(the ONNX classifier + the matching CPU/WASM ONNX Runtime). Run at build/deploy.',
        '',
        '  node scripts/provision-smart-turn.mjs [--force]',
        '',
        `  model   : ${REPO}/${MODEL_FILE}`,
        `  upstream: ${UPSTREAM}`,
      ].join('\n'),
    );
    return;
  }

  const log = (m) => console.log(m);
  log(`Provisioning smart-turn assets → ${OUT_DIR} (${REPO}/${MODEL_FILE})${args.force ? ' (--force)' : ''}`);

  const files = [];

  const modelDest = join(OUT_DIR, MODEL_DEST);
  const modelBytes = await downloadTo(HF_FILE(REPO, MODEL_FILE), modelDest, { force: args.force });
  log(`  ✓ smart-turn/${MODEL_DEST}  ${fmtBytes(modelBytes)}`);
  files.push({ file: `smart-turn/${MODEL_DEST}`, bytes: modelBytes });

  const ort = await ortDist();
  log(`runtime: onnxruntime-web@${ort.version} (CPU/WASM, copied from node_modules)`);
  for (const f of ORT_FILES) {
    const dest = join(OUT_DIR, 'ort', f);
    const bytes = await copyInto(ort.paths[f], dest, { force: args.force });
    log(`  ✓ smart-turn/ort/${f}  ${fmtBytes(bytes)}`);
    files.push({ file: `smart-turn/ort/${f}`, bytes });
  }

  // Manifest = machine-readable provenance (what/where/version), mirroring
  // public/stt/manifest.json. Lives under the gitignored public/smart-turn/.
  const manifest = {
    generatedBy: 'scripts/provision-smart-turn.mjs',
    generatedAt: new Date().toISOString(),
    repo: REPO,
    modelFile: MODEL_FILE,
    servedAs: `smart-turn/${MODEL_DEST}`,
    upstream: UPSTREAM,
    license: 'BSD-2-Clause (model weights)',
    onnxruntimeWebVersion: ort.version,
    // The front-end contract src/whisper-mel.ts implements; recorded so a future
    // model bump that changes it is caught by reading the manifest, not by a
    // mystery drop in verdict quality.
    input: { name: 'input_features', shape: [1, 80, 800], features: 'whisper log-mel, 8s @ 16kHz' },
    files,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const total = files.reduce((n, f) => n + f.bytes, 0);
  log(`\nDone: ${files.length} file(s), ${fmtBytes(total)} total. Run \`npm run build\` to bundle into dist/.`);
}

main().catch((err) => {
  console.error(`\nprovision-smart-turn failed: ${err.message}`);
  console.error('If the model 404s, the pinned export may have moved — adjust SMART_TURN_MODEL_FILE or the top of this script.');
  process.exitCode = 1;
});
