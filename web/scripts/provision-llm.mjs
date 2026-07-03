#!/usr/bin/env node
// Provision the self-hosted on-device LISTENER LLM assets — run at BUILD/DEPLOY
// time, never at app runtime. The U5 mirror of provision-stt.mjs: fetches the
// transformers.js engine bundle + its ONNX Runtime wasm and the small instruct
// model's quantized weights into web/public/, where Vite copies them into dist/
// and the app serves them SAME-ORIGIN. This is the deploy-time half of the
// no-egress design: the browser never fetches engine or weights cross-origin (see
// web/public/llm-engine.js, src/listener.ts).
//
// Layout it writes (all gitignored — large binaries, see web/.gitignore):
//   public/llm/transformers/   transformers.min.js + ort-wasm-simd-threaded.jsep.{mjs,wasm}
//   public/llm/manifest.json   what was provisioned (versions, files, sizes)
//   public/models/<id>/        config/tokenizer JSON + onnx/*_q4f16|q4.onnx(_data)
//                              (the /models/ tree is shared with STT)
//
// Absent assets are fine: the worker's engine import 404s and the adapter degrades
// to the labelled stub. So this script is optional for a stub-only deploy and
// required only to make the harness actually respond.
//
// Usage:
//   node scripts/provision-llm.mjs                 # provision engine + model
//   node scripts/provision-llm.mjs --only=engine
//   node scripts/provision-llm.mjs --force         # re-download existing files
// Env overrides: LLM_MODEL (HF repo id).

import { mkdir, rename, stat, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const PUBLIC = join(WEB_ROOT, 'public');

// Pinned engine: @huggingface/transformers 3.8.1 — the SAME version STT pins, so
// engine + ONNX Runtime are one version-coherent set across both on-device models.
// Bump deliberately (and re-test in a browser).
const TRANSFORMERS_VERSION = '3.8.1';
const ENGINE_FILES = [
  'transformers.min.js',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

// The small on-device instruct model — the substitute-and-note placeholder from
// listener.ts (U2's VRAM drop-target, with a transformers.js ONNX export). Swap
// for U2's finalised pick via LLM_MODEL. Must have q4f16 (WebGPU) and/or q4 (WASM
// fallback) ONNX exports under onnx/.
const LLM_MODEL = process.env.LLM_MODEL || 'onnx-community/Llama-3.2-1B-Instruct';

const JSDELIVR = (file) =>
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/${file}`;
const HF_API = (repo) => `https://huggingface.co/api/models/${repo}`;
const HF_FILE = (repo, rf) => `https://huggingface.co/${repo}/resolve/main/${rf}`;

// Provision a repo file when it is one of the two ONNX quant variants the engine
// loads (q4f16 for WebGPU, q4 for the WASM fallback) — plus any external-weight
// `.onnx_data` sibling — OR a small JSON/TXT config/tokenizer file. Skips the
// fp32/fp16/q8/int8/bnb4 ONNX variants and heavy non-ONNX weight formats
// (.safetensors/.bin/...), keeping the deploy lean.
function wantRepoFile(rf) {
  if (rf.startsWith('onnx/')) return /_(q4f16|q4)\.onnx(_data)?$/.test(rf);
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
    const dest = join(PUBLIC, 'llm', 'transformers', f);
    const bytes = await downloadTo(JSDELIVR(f), dest, { force });
    log(`  ✓ llm/transformers/${f}  ${fmtBytes(bytes)}`);
    files.push({ file: `llm/transformers/${f}`, bytes });
  }
  return files;
}

async function provisionModel(repo, force, log) {
  log(`model: ${repo}`);
  const meta = await fetchJson(HF_API(repo));
  const rfiles = (meta.siblings ?? []).map((s) => s.rfilename).filter(wantRepoFile);
  if (rfiles.length === 0) throw new Error(`no provisionable files for ${repo} (config/tokenizer/_q4f16|q4.onnx)`);
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
        'Provision self-hosted listener-LLM assets into web/public/ (engine bundle +',
        'ONNX Runtime wasm + the small instruct model quantized weights). Run at build/deploy.',
        '',
        '  node scripts/provision-llm.mjs [--only=engine,model] [--force]',
        '',
        `  engine : @huggingface/transformers@${TRANSFORMERS_VERSION}`,
        `  model  : ${LLM_MODEL}`,
      ].join('\n'),
    );
    return;
  }

  const ALL = ['engine', 'model'];
  const tasks = args.only ?? ALL;
  const unknown = tasks.filter((t) => !ALL.includes(t));
  if (unknown.length) throw new Error(`unknown --only target(s): ${unknown.join(', ')} (valid: ${ALL.join(', ')})`);

  const log = (m) => console.log(m);
  log(`Provisioning listener-LLM assets → ${PUBLIC}${args.force ? ' (--force)' : ''}`);

  let files = [];
  if (tasks.includes('engine')) files = files.concat(await provisionEngine(args.force, log));
  if (tasks.includes('model')) files = files.concat(await provisionModel(LLM_MODEL, args.force, log));

  // Manifest lets operators see what is provisioned. Lives under the gitignored
  // public/llm/, never committed.
  const manifest = {
    generatedBy: 'scripts/provision-llm.mjs',
    generatedAt: new Date().toISOString(),
    transformersVersion: TRANSFORMERS_VERSION,
    model: LLM_MODEL,
    tasks,
    files,
  };
  await mkdir(join(PUBLIC, 'llm'), { recursive: true });
  await writeFile(join(PUBLIC, 'llm', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const total = files.reduce((n, f) => n + f.bytes, 0);
  log(`\nDone: ${files.length} file(s), ${fmtBytes(total)} total. Run \`npm run build\` to bundle into dist/.`);
}

main().catch((err) => {
  console.error(`\nprovision-llm failed: ${err.message}`);
  console.error('If a file 404s, the pinned version or model id may have moved — adjust the top of this script.');
  process.exitCode = 1;
});
