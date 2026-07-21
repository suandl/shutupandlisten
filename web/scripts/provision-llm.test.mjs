// The provisioner ⇄ ladder contract (su-lou.9).
//
// Two files have to agree about which quantized weights a deploy ships:
//
//   scripts/provision-llm.mjs   decides what gets DOWNLOADED into public/models/
//   src/listener-backends.ts    decides what the worker asks the engine to LOAD
//
// When they drift, the app 404s on the weights it needs and the listener degrades
// to its labelled stub — with, before this bead, no diagnostic saying so. That is
// exactly the failure su-lou.9 was reported as. (The real cause turned out to be
// different — the engine wrapper supplied the dtype, so the two agreed after all —
// but the contract was genuinely unguarded, and it is unguarded no longer.)
//
// These run in CI with no provisioned assets: they check the RULES, not the tree.
// The works-check asserts the other half — that a provisioned deploy really serves
// the files these rules promise.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LISTENER_CANDIDATES, listenerWeightFile } from '../src/listener-backends.ts';
import { wantRepoFile } from './provision-llm.mjs';

test('every ladder rung asks for weights the provisioner actually downloads', () => {
  assert.ok(LISTENER_CANDIDATES.length > 0, 'the ladder must have at least one rung');
  for (const c of LISTENER_CANDIDATES) {
    const file = listenerWeightFile(c.dtype);
    assert.equal(wantRepoFile(file), true, `${c.device}/${c.dtype} wants ${file}, which provision-llm.mjs skips`);
    // External weights ride along as a `_data` sibling — a 1GB+ model is useless
    // without them, and the provisioner's regex must claim both.
    assert.equal(wantRepoFile(`${file}_data`), true, `${file}_data would not be provisioned`);
  }
});

test('the rung a bare `device: webgpu` would resolve is NOT provisioned', () => {
  // transformers.js maps an unspecified dtype to fp32 for any device except wasm
  // (DEFAULT_DEVICE_DTYPE_MAPPING = { wasm: q8 }), and fp32's file suffix is empty.
  // So a rung that omits its dtype asks for `onnx/model.onnx` — which this asserts
  // the provisioner does not ship. That is why listener-backends.ts states a dtype
  // on every rung instead of inheriting one from whichever engine module is loaded:
  // the default only exists in public/llm-engine.js, and a `?llmEngine=` override
  // supplies no such default at all.
  assert.equal(wantRepoFile('onnx/model.onnx'), false);
  assert.equal(wantRepoFile('onnx/model_fp16.onnx'), false);
  assert.equal(wantRepoFile('onnx/model_quantized.onnx'), false);
});

test('config and tokenizer files are provisioned; heavy non-ONNX formats are not', () => {
  for (const keep of ['config.json', 'tokenizer.json', 'generation_config.json', 'LICENSE.txt']) {
    assert.equal(wantRepoFile(keep), true, `${keep} should be provisioned`);
  }
  for (const skip of ['model.safetensors', 'pytorch_model.bin']) {
    assert.equal(wantRepoFile(skip), false, `${skip} should be skipped`);
  }
});

test('importing the provisioner does not start a download', () => {
  // The entry-point guard exists so this test file can import wantRepoFile at all.
  // If main() ran on import, this suite would try to fetch gigabytes from HF.
  assert.equal(typeof wantRepoFile, 'function');
});
