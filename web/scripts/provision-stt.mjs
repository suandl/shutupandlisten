#!/usr/bin/env node
// Provision the self-hosted STT assets — run at BUILD/DEPLOY time, never at app
// runtime. Fetches the transformers.js engine bundle + its ONNX Runtime wasm and
// the Moonshine/Whisper quantized weights into web/public/, where Vite copies
// them into dist/ and the app serves them SAME-ORIGIN. This is the deploy-time
// half of the no-egress design: the browser never fetches engine or weights
// cross-origin (see web/public/stt-engine.js, src/stt.ts).
//
// Layout it writes (all gitignored — large binaries, see web/.gitignore):
//   public/stt/transformers/   transformers.min.js + ort-wasm-simd-threaded.jsep.{mjs,wasm}
//   public/stt/manifest.json   what was provisioned (versions, files, sizes)
//   public/models/<id>/        config/tokenizer JSON + onnx/*_quantized.onnx
//
// Absent assets are fine: the worker's engine import 404s and the adapter
// degrades to the labelled stub. So this script is optional for a stub-only
// deploy and required only to make the harness actually transcribe.
//
// Usage:
//   node scripts/provision-stt.mjs                 # provision everything
//   node scripts/provision-stt.mjs --only=engine,moonshine
//   node scripts/provision-stt.mjs --force         # re-download existing files
// Env overrides: STT_MOONSHINE_MODEL, STT_WHISPER_MODEL (HF repo ids).

import { mkdir, rename, stat, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const PUBLIC = join(WEB_ROOT, 'public');

// Pinned engine: @huggingface/transformers 3.8.1 — its dist self-contains the
// matching ort-wasm-simd-threaded.jsep.{mjs,wasm}, so engine + ONNX Runtime are
// one version-coherent set. Bump deliberately (and re-test in a browser).
const TRANSFORMERS_VERSION = '3.8.1';
const ENGINE_FILES = [
  'transformers.min.js',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

// Concrete, transformers.js-v3-compatible, quantized (q8 → *_quantized.onnx)
// exports. Moonshine primary (variable-length), Whisper-small fallback.
const MODELS = {
  moonshine: process.env.STT_MOONSHINE_MODEL || 'onnx-community/moonshine-base-ONNX',
  whisper: process.env.STT_WHISPER_MODEL || 'onnx-community/whisper-small',
};

const JSDELIVR = (file) =>
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/${file}`;
const HF_API = (repo) => `https://huggingface.co/api/models/${repo}`;
const HF_FILE = (repo, rf) => `https://huggingface.co/${repo}/resolve/main/${rf}`;

// Provision a repo file when it is a quantized ONNX graph OR a small JSON/TXT
// config/tokenizer file. Skips fp32/fp16/int8/etc. ONNX variants and heavy
// non-ONNX weight formats (.safetensors/.bin/...), keeping the deploy lean.
function wantRepoFile(rf) {
  if (rf.startsWith('onnx/')) return /_quantized\.onnx$/.test(rf);
  return /\.(json|txt)$/i.test(rf);
}

function parseArgs(argv) {
  const out = { force: false, only: null };
  for (const a of argv) {
    if (a === '--force') out.force = true;
    else if (a.startsWith('--only=')) out.only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
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

async function provisionEngine(force, log) {
  log(`engine: @huggingface/transformers@${TRANSFORMERS_VERSION} (+ ONNX Runtime wasm)`);
  const files = [];
  for (const f of ENGINE_FILES) {
    const dest = join(PUBLIC, 'stt', 'transformers', f);
    const bytes = await downloadTo(JSDELIVR(f), dest, { force });
    log(`  ✓ stt/transformers/${f}  ${fmtBytes(bytes)}`);
    files.push({ file: `stt/transformers/${f}`, bytes });
  }
  return files;
}

async function provisionModel(repo, force, log) {
  log(`model: ${repo}`);
  const meta = await fetchJson(HF_API(repo));
  const rfiles = (meta.siblings ?? []).map((s) => s.rfilename).filter(wantRepoFile);
  if (rfiles.length === 0) throw new Error(`no provisionable files for ${repo} (config/tokenizer/_quantized.onnx)`);
  const files = [];
  for (const rf of rfiles) {
    const dest = join(PUBLIC, 'models', repo, rf);
    const bytes = await downloadTo(HF_FILE(repo, rf), dest, { force });
    log(`  ✓ models/${repo}/${rf}  ${fmtBytes(bytes)}`);
    files.push({ file: `models/${repo}/${rf}`, bytes });
  }
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'Provision self-hosted STT assets into web/public/ (engine bundle + ONNX',
        'Runtime wasm + Moonshine/Whisper quantized weights). Run at build/deploy.',
        '',
        '  node scripts/provision-stt.mjs [--only=engine,moonshine,whisper] [--force]',
        '',
        `  engine  : @huggingface/transformers@${TRANSFORMERS_VERSION}`,
        `  moonshine: ${MODELS.moonshine}`,
        `  whisper : ${MODELS.whisper}`,
      ].join('\n'),
    );
    return;
  }

  const ALL = ['engine', 'moonshine', 'whisper'];
  const tasks = args.only ?? ALL;
  const unknown = tasks.filter((t) => !ALL.includes(t));
  if (unknown.length) throw new Error(`unknown --only target(s): ${unknown.join(', ')} (valid: ${ALL.join(', ')})`);

  const log = (m) => console.log(m);
  log(`Provisioning STT assets → ${PUBLIC}${args.force ? ' (--force)' : ''}`);

  let files = [];
  if (tasks.includes('engine')) files = files.concat(await provisionEngine(args.force, log));
  if (tasks.includes('moonshine')) files = files.concat(await provisionModel(MODELS.moonshine, args.force, log));
  if (tasks.includes('whisper')) files = files.concat(await provisionModel(MODELS.whisper, args.force, log));

  // Manifest lets the asset-presence guard (src/stt-assets.test.ts) and operators
  // see what is provisioned. Lives under the gitignored public/stt/, never committed.
  const manifest = {
    generatedBy: 'scripts/provision-stt.mjs',
    generatedAt: new Date().toISOString(),
    transformersVersion: TRANSFORMERS_VERSION,
    models: MODELS,
    tasks,
    files,
  };
  await mkdir(join(PUBLIC, 'stt'), { recursive: true });
  await writeFile(join(PUBLIC, 'stt', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const total = files.reduce((n, f) => n + f.bytes, 0);
  log(`\nDone: ${files.length} file(s), ${fmtBytes(total)} total. Run \`npm run build\` to bundle into dist/.`);
}

main().catch((err) => {
  console.error(`\nprovision-stt failed: ${err.message}`);
  console.error('If a file 404s, the pinned version or model id may have moved — adjust the top of this script.');
  process.exitCode = 1;
});
