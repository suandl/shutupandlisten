# Test fixtures

## `utterance.wav` — the works-check speech fixture (su-ljrb.6, plan U4)

A ~2.4 s clean English utterance — “The voice pipeline is working.” — as
16 kHz mono 16-bit PCM. `npm run works-check` decodes it (scripts/wav.mjs) and
smoke-runs the STT adapter on it, asserting a **non-empty** transcript:
liveness, not accuracy (origin R4). It must be real speech — the su-ljrb.1
spike showed a sine-tone fixture exercises the pipeline but transcribes to an
empty string, which would false-fail the gate on a healthy STT stage.

**Provenance.** Synthesized headlessly on 2026-07-18 with the repo's own
provisioned on-device voice — `Xenova/mms-tts-eng` (MMS-TTS VITS, q8 ONNX
export, transformers.js 3.8.1, CPU/WASM) — via direct component construction
(`AutoTokenizer` + `AutoModelForTextToWaveform`), then peak-normalized to 0.9
and encoded with scripts/wav.mjs. No microphone or third-party recording is
involved; the audio is a model output committed solely as a test fixture.
Note: the MMS model weights are released by Meta AI under CC-BY-NC 4.0; this
generated clip is used here only for non-commercial testing of this repo
(the repo's MIT license covers its code, not this asset's source model).

**Regenerating / replacing.** Any ~1–3 s clean spoken utterance in this format
works — decode-ability is guarded by `parseWavPcm16` (16-bit PCM only) and the
works-check preflight names this path if the file is missing or unreadable.
Keep it short: the sample array is passed into the probe page per run.
