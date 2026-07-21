#!/usr/bin/env node
// Provision the self-hosted smart-turn v3 model — run at BUILD/DEPLOY, never at app
// runtime. Downloads the pinned end-of-utterance classifier into web/public/, where
// Vite copies it into dist/ and the app serves it SAME-ORIGIN (src/smart-turn.ts
// loads it). This is the deploy-time half of the no-egress design for the EOU stage:
// the browser never fetches the model cross-origin and no user audio leaves the page.
//
// Only the WEIGHTS are provisioned. The runtime (onnxruntime-web) is bundled into
// the app by Vite, and the adapter points ONNX Runtime at that emitted binary — so
// it is same-origin and version-coherent by construction, with nothing here that
// could drift out of lockstep with the lockfile.
//
// WHY THIS SCRIPT EXISTS (su-lou.10.1): it did not, which is why the classifier had
// NEVER RUN — src/smart-turn.ts returned its duration heuristic on every call
// because no URL ever pointed at a model. With no real EOU signal the 2000ms silence
// floor carried all the patience alone, the "uniformly long pause" the 2026-07-21
// feel-test reported.
//
// Layout it writes (all gitignored — see web/.gitignore):
//   public/smart-turn/smart-turn-v3.onnx   the pinned int8 CPU export
//   public/smart-turn/manifest.json        what was provisioned (provenance)
//
// Absent assets are fine: the model fetch 404s (the SPA-fallback guard in
// src/asset-fallback.ts makes sure that is a real 404 and not index.html — su-lou.7)
// and the adapter degrades to the labelled heuristic. So this script is optional for
// a heuristic-only deploy and required to make the harness actually classify —
// which `npm run works-check` asserts.
//
// Usage:
//   node scripts/provision-smart-turn.mjs           # provision
//   node scripts/provision-smart-turn.mjs --force   # re-download an existing file
// Env override: SMART_TURN_MODEL_FILE (a file in the pinned HF repo, e.g.
// smart-turn-v3.1-cpu.onnx), SMART_TURN_REPO (HF repo id), SMART_TURN_SHA256
// (integrity pin for a custom export — see PINNED_SHA256 below).

import { mkdir, rename, stat, writeFile, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const PUBLIC = join(WEB_ROOT, 'public');
const OUT_DIR = join(PUBLIC, 'smart-turn');

// Adopted classifier: Pipecat smart-turn v3 (BSD-2-Clause) — a Whisper-tiny encoder
// plus a shallow classifier head, 8M params, int8 ONNX. The model card's ~12ms is
// NATIVE CPU; in browser wasm the whole verdict measures ~270ms (see src/vad.ts).
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

// Integrity pin (sha256 hex) for the DEFAULT export. The name is pinned but the bytes
// are not: HuggingFace serves `main` as a MOVING branch, so the same filename can be
// replaced with different weights, and a wrong EOU model does not throw — it emits
// garbage verdicts, the exact silent degrade su-lou.7/.8/.9 keep dragging into the
// light. Pinning the hash turns "mystery-bad turn-taking at runtime" into a loud stop at
// deploy. Verified against the .part BEFORE the atomic rename, so a bad file never
// reaches the served path.
//
// The value is HF's advertised LFS oid for the pinned file — GET
// /api/models/pipecat-ai/smart-turn-v3/tree/main, the matching entry's `lfs.oid`. It is
// left UNSET here because this checkout has NO egress to huggingface.co (.devcontainer/
// allowed-domains.txt is api.openai.com + api.anthropic.com only), so the real hash could
// not be fetched and must never be guessed. Provision once from a networked deploy and
// paste the sha256 the manifest records into this map. Until it is filled, provisioning
// still works and prints a loud UNVERIFIED note instead of failing — so heuristic-only
// deploys and env-override exports below are unaffected.
const PINNED_SHA256 = {
  // 'pipecat-ai/smart-turn-v3/smart-turn-v3.2-cpu.onnx': '<64-hex sha256 from HF lfs.oid>',
};

// Pointing SMART_TURN_REPO / SMART_TURN_MODEL_FILE at a different export invalidates the
// default pin by construction; SMART_TURN_SHA256 lets an operator pin their own bytes,
// otherwise that file provisions UNVERIFIED with a printed note.
const EXPECTED_SHA256 = process.env.SMART_TURN_SHA256 || PINNED_SHA256[`${REPO}/${MODEL_FILE}`] || null;

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

// Streamed sha256 so an 8.7MB model never sits in memory whole. Same digest as
// `sha256sum <file>` — the bytes on disk, nothing else.
async function sha256File(path) {
  const h = createHash('sha256');
  await new Promise((res, rej) => {
    const s = createReadStream(path);
    s.on('data', (c) => h.update(c));
    s.on('end', res);
    s.on('error', rej);
  });
  return h.digest('hex');
}

// Loud stop on a pin mismatch. A no-op when nothing is pinned — the caller has already
// printed the UNVERIFIED note, so an unpinned deploy is a conscious choice, not a silent
// one. The message carries the su-lou voice: name the degrade and the remedy.
function verifyPin(path, actual, expect) {
  if (!expect || actual === expect) return;
  throw new Error(
    `sha256 mismatch for ${path}\n` +
      `  expected ${expect}\n` +
      `  actual   ${actual}\n` +
      'The pinned upstream file changed under the same name (moved, replaced, or corrupted). ' +
      'A wrong EOU model does not error — it emits garbage turn-taking verdicts at runtime, ' +
      'the silent degrade this pin exists to catch. If the bump is intentional, update ' +
      'PINNED_SHA256 (the manifest records the actual hash); otherwise do not deploy this file.',
  );
}

// Stream a URL to dest (atomic: write .part then rename). Returns { size, sha256 }.
// The pin is checked against the .part BEFORE the rename so a mismatched file is deleted,
// never landing at the served path; an already-present file is re-hashed on re-run so a
// stale corruption cannot hide behind the exists() short-circuit.
async function downloadTo(url, dest, { force, expectSha256 }) {
  if (!force && (await exists(dest))) {
    const sha256 = await sha256File(dest);
    verifyPin(dest, sha256, expectSha256);
    return { size: (await stat(dest)).size, sha256 };
  }
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const tmp = `${dest}.part`;
  try {
    await streamPipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const { size } = await stat(tmp);
    if (size === 0) throw new Error(`downloaded 0 bytes from ${url}`);
    const sha256 = await sha256File(tmp);
    verifyPin(tmp, sha256, expectSha256);
    await rename(tmp, dest);
    return { size, sha256 };
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        'Provision the self-hosted smart-turn v3 model into web/public/smart-turn/',
        '(the ONNX end-of-utterance classifier). Run at build/deploy.',
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
  log(`Provisioning the smart-turn model → ${OUT_DIR} (${REPO}/${MODEL_FILE})${args.force ? ' (--force)' : ''}`);

  const files = [];

  if (!EXPECTED_SHA256) {
    log(
      `  ⚠ integrity UNVERIFIED — no pinned sha256 for ${REPO}/${MODEL_FILE}; recording the ` +
        'actual hash in manifest.json (fill PINNED_SHA256, or set SMART_TURN_SHA256, to enforce)',
    );
  }
  const modelDest = join(OUT_DIR, MODEL_DEST);
  const { size: modelBytes, sha256: modelSha256 } = await downloadTo(HF_FILE(REPO, MODEL_FILE), modelDest, {
    force: args.force,
    expectSha256: EXPECTED_SHA256,
  });
  log(`  ✓ smart-turn/${MODEL_DEST}  ${fmtBytes(modelBytes)}  sha256:${modelSha256.slice(0, 12)}…${EXPECTED_SHA256 ? ' (verified)' : ''}`);
  files.push({ file: `smart-turn/${MODEL_DEST}`, bytes: modelBytes, sha256: modelSha256 });

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
    runtime: 'onnxruntime-web, bundled with the app (not provisioned)',
    // Integrity: expected is the pinned sha256 (null when unpinned); each file's actual
    // sha256 is under `files`. `verified` records whether the download was checked against
    // a pin — a false here is the receipt that this deploy trusted upstream bytes blind.
    integrity: {
      expectedSha256: EXPECTED_SHA256,
      verified: Boolean(EXPECTED_SHA256),
      source: EXPECTED_SHA256 ? (process.env.SMART_TURN_SHA256 ? 'env:SMART_TURN_SHA256' : 'PINNED_SHA256') : 'unverified',
    },
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
  console.error('If the sha256 mismatches, the upstream bytes changed under the same name — reconcile PINNED_SHA256 before deploying.');
  process.exitCode = 1;
});
