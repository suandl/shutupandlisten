# web/ — Rung 1 in-browser harness (U3 timing + U4 STT + U5 listener + U6 TTS)

The product-defining turn-detection layer, built first and in isolation as a
**timing-only milestone**: Web Audio → Silero VAD → a configurable **silence
floor** (the patience window) → **smart-turn v3** as an asymmetric veto → a
**stubbed** canned response — the point is to feel the patience against the
[usefulness bar](../docs/usefulness-bar.md) (B1 "holds silence through an
unfinished thought", B2 "yields the floor instantly") before any model quality
is in play.

**U4** adds on-device **STT** as an *additive* layer on top of that timing: each
completed VAD speech segment is transcribed (Moonshine CPU/WASM primary,
Whisper-small fallback, in a Web Worker off the GPU) and rendered as a running
transcript **aligned to the turn boundaries** the detector emits — so the
operator can read back what was said and SEE where speech-end and turn-end
landed relative to the words. STT never feeds the detector; the tested
turn-detection timing is unchanged.

**U5** adds the **listener**: when a turn ends and its transcript resolves, a pure
**response-hierarchy gate** ([`src/response-hierarchy.ts`](src/response-hierarchy.ts))
picks a rung of the companion's ladder — *silence → minimal acknowledgment →
short reflection → one brief follow-up question* — under the "escalate slowly"
rule. `silence`/`acknowledge` are answered from RULES with no model call (the
"reduced role"); only the substantive rungs (`reflection`/`question`) call a
**small on-device LLM** ([`src/listener.ts`](src/listener.ts)) running on **WebGPU**
(off the CPU/WASM the STT uses), prompted with [`prompts/chatgpt.md`](../prompts/chatgpt.md)
and constrained to the chosen tier. The reply renders under its turn in the
Transcript panel. Like STT it is additive and downstream of the detector — it
reads turn boundaries + words, never the tested timing.

**U6** closes the loop: the gated reply is now **spoken**. On-device **TTS**
([`src/tts.ts`](src/tts.ts)) synthesizes each substantive reply (and the short
acknowledge backchannel; silence stays silent) on **CPU/WASM** — off the GPU the
listener uses — and main.ts plays it through Web Audio, so the harness responds
*aloud*, in a real back-and-forth. If the thinker speaks while a reply is playing
it **yields instantly** (barge-in stops the voice and returns to listening),
reusing the detector's tested barge-in event without touching its timing. A pure
**loop-metrics** ([`src/loop-metrics.ts`](src/loop-metrics.ts)) recorder measures
the warmed loop per stage — *turn-end → transcript → gate → reply → speech-start* —
surfaced in a **Loop latency** panel so the operator can see where time goes.
Un-provisioned (or `?tts=off`), TTS degrades to a short, labelled **placeholder
tone** so the loop still audibly closes.

> The bead frames the ladder as "listen > acknowledge > probe > advise". That is
> shorthand: the repo's canonical hierarchy (CONCEPTS.md) is the four tiers above
> and deliberately has **no "advise" rung** — advising/coaching/solving are on the
> listener's explicit Do-NOT list. The gate implements the canon.

The turn logic lives in a pure, runtime-agnostic state machine
([`src/turn-detection.ts`](src/turn-detection.ts)) specified in
[`spec/turn-state-machine.md`](../spec/turn-state-machine.md) and pinned by the
[golden vectors](../spec/turn-vectors/README.md). Everything else here is I/O
adapters and UI around it. The same spec + vectors are the U7 native-parity
contract — "reuse U3 logic" means the spec, not this TypeScript.

## Run it

```bash
cd web
npm install

npm test         # scenario + measurement suites (Node's runner, zero extra deps)
npm run measure  # scenario-6 metrics table: smart-turn+floor vs patience-only
npm run dev      # Vite dev server — open the harness in a browser
npm run build    # static production build to dist/ (no server needed to serve it)

npm run provision:stt  # build/deploy step: fetch the self-hosted STT engine +
                       # Moonshine/Whisper weights into public/ so mic mode transcribes
npm run provision:llm  # build/deploy step: fetch the self-hosted LLM engine +
                       # small instruct-model weights into public/ so the listener replies
npm run provision:tts  # build/deploy step: fetch the self-hosted TTS engine +
                       # small voice-model weights into public/ so the companion speaks

npm run demo:u6        # record a narrated MP4 that PROVES the U6 warmed loop, driven
                       # against deterministic sim mode (see e2e/README.md)
```

`npm test` runs under Node's built-in test runner via native TypeScript
type-stripping, so the crux logic is verifiable without installing anything —
the browser model libs are only needed by the harness, not the tests.

**STT is on by default**, served entirely from the app's own origin. `npm run
provision:stt` (`scripts/provision-stt.mjs`) is the build/deploy-time step that
downloads the self-hosted transformers.js engine bundle and the Moonshine/Whisper
weights into `public/` (gitignored — large binaries, served same-origin out of
`dist/`). It reaches the network only at deploy time — the running app never
fetches engine or weights cross-origin, and no microphone audio ever leaves the
page. It is optional: skip it and mic mode falls back to the labelled stub. See
**Component substitutions** below for the models, per-run overrides, and the
`?stt=off` kill switch.

## Using the harness

Two modes (top bar):

- **Simulation** (default) — play a scripted utterance (thinking pause, trailing
  conjunction, clean finish, barge-in) or **Free run**, then drag the knobs. The
  same script ends the turn mid-thought below the floor and holds above it — the
  fastest way to see what the patience window does. No mic or download needed. The
  **U6 warmed loop (demo)** script goes further: it carries scripted transcripts, so
  it drives the *whole* loop (transcript → gate → listener → voice → per-stage
  metrics) mic-lessly — the deterministic substrate the demo-capture engine records
  (`?demo=u6-warmed-loop`; see [`e2e/README.md`](e2e/README.md)).
- **Microphone** — real Silero VAD + smart-turn on your voice, for the operator
  feel-test. Models load on first start. STT is **on by default**: on a
  provisioned deploy (see `npm run provision:stt` above) real speech is
  transcribed into the **Transcript** panel (see below). With no provisioned
  assets — or with `?stt=off` — a labelled stub keeps the layout legible. Retune
  the engine/models per run with query params (see **Component substitutions**).

The **Stage** shows the live state, a patience countdown bar (held open visibly
when the incomplete veto is active), the current turn/verdict/arm, and the
responding indicator. The **Transcript + listener** panel (mic) shows the running
transcript grouped by turn: each segment's words, a `⏷` where speech-end landed,
and a `turn-end floor|extended` chip (with how long the floor held after the last
speech) where the detector ended the turn — so you can read back what was said and
see exactly where patience cut or held. Under each completed turn the **listener's
reply** appears: a faint `· held ·` when the gate holds silence, a `mm`/`yeah`
backchannel for a minimal acknowledgment, or a `reflection`/`question` tier chip
with the on-device LLM's reply (or its labelled stub) — so you can see the response
hierarchy escalate, or decline to. **In mic mode that reply is also spoken aloud**
(U6): silence stays silent, the acknowledge backchannel and the substantive reply
are voiced, and if you talk over it the voice yields instantly. The **Loop latency**
panel reports the warmed loop's per-stage cost (turn-end → transcript → gate →
reply → speech-start) so you can see where time goes. The **event log** streams the
input events (← from the audio source) and output events (→ from the detector).

### Live knobs

| Knob | What it does |
|------|--------------|
| Silence floor (patience window) | Minimum silence before a pause may end the turn. The load-bearing tunable. |
| Incomplete extension | Extra patience when smart-turn reads the pause as "incomplete". |
| Completion threshold | smart-turn P(complete) cutoff; higher = more patient. |
| Stubbed response length | How long the canned response "plays". |
| smart-turn veto | On = floor + veto; off = the patience-only baseline arm. |
| VAD thresholds (mic) | Silero speech on/off probabilities and redemption frames. |

## Architecture

```
audio source ──InputEvent──▶ TurnDetector ──OutputEvent──▶ UI / spoken reply (U6)
(mic | sim)                  (pure, tested)
```

- `src/turn-detection.ts` — the crux: pure `(state, event)` reducer. Floor +
  asymmetric smart-turn veto, live knobs, stubbed response, barge-in. No audio
  code. Fully unit-tested by the golden vectors.
- `src/vad.ts` — microphone adapter (Silero VAD via `@ricky0123/vad-web`); also
  runs smart-turn and STT on each released segment and emits transcripts.
- `src/smart-turn.ts` — smart-turn v3 adapter (`onnxruntime-web`) + heuristic
  fallback (see substitutions).
- `src/stt.ts` / `src/stt.worker.ts` — STT adapter (Moonshine/Whisper in a
  CPU/WASM worker) + labelled stub fallback (see substitutions).
- `src/transcript.ts` — pure turn-alignment: groups transcribed segments under
  the detector's turns and marks where speech-end / turn-end landed. No DOM,
  fully unit-tested.
- `src/simulator.ts` — scripted/synthetic event source for the mic-less demo.
- `src/measurement.ts` / `src/measure.ts` — scenario-6 false-cutoff /
  false-continuation harness vs the patience-only baseline.
- `src/response-hierarchy.ts` — the U5 crux: pure `(turn, history) → tier` gate
  (silence/acknowledge = rules-only, reflection/question = LLM) + the tier-
  constrained prompt builder. No DOM, no model — fully unit-tested, the same
  discipline as turn-detection.ts. Mirrors the routing of the reference prototype
  `promptfoo/providers/reduced-role.js`, extended with the detector's turn-end
  reason (the audio+timing signal a text gate lacks).
- `src/listener.ts` / `src/listener.worker.ts` — on-device listener LLM adapter
  (small instruct model on WebGPU, WASM fallback) + labelled stub fallback (see
  substitutions). `src/listener-config.ts` resolves its live config (same-origin
  guard + `?llm=` overrides), split out to be unit-testable like `stt-config.ts`.
- `src/tts.ts` / `src/tts.worker.ts` — on-device TTS adapter (small voice model on
  CPU/WASM) that synthesizes the gated reply to PCM + a placeholder-tone stub
  fallback (see substitutions). `src/tts-config.ts` resolves its live config
  (same-origin guard + `?tts=` overrides), split out to be unit-testable.
- `src/loop-metrics.ts` — the U6 crux: a pure per-stage latency recorder for the
  warmed loop (turn-end → transcript → gate → reply → speech-start). No DOM, no
  clock — fully unit-tested, the same discipline as `measurement.ts`.
- `src/knobs.ts`, `src/main.ts`, `index.html` — knob specs and UI wiring (main.ts
  also runs the U5 gate + listener over completed turns, renders each reply under
  its transcript turn, speaks it via the U6 voice with barge-in yield, and records
  the loop-latency panel).

## Component substitutions (per the plan: substitute and note)

- **smart-turn v3 model** — the adapter loads the real ONNX model when a model
  URL is configured; otherwise it degrades to a transparent **duration
  heuristic** (short trailing segments read as "incomplete"), and the Stage shows
  which mode is live. The asymmetric-veto *logic* is identical and fully tested
  either way; only verdict *quality* depends on the model, which is a tuning
  concern resolved on real audio during the feel-test. Wiring a specific
  smart-turn v3 ONNX export (input tensor + mel front-end) is the first task of
  that tuning pass.

- **STT model (Moonshine / Whisper-small)** — wired real and **default-on**,
  served self-hosted. `src/stt.ts` runs STT in a Web Worker (`src/stt.worker.ts`,
  CPU/WASM, off the GPU) that loads a
  [transformers.js](https://github.com/huggingface/transformers.js)-compatible
  engine and models from the app's **own origin**: the committed wrapper
  `public/stt-engine.js`, plus the engine bundle under `public/stt/` and weights
  under `public/models/<id>/`, provisioned at build/deploy by `npm run
  provision:stt` (those two trees gitignored — large binaries). The defaults
  (`src/stt.ts`) are Moonshine `onnx-community/moonshine-base-ONNX` (primary) and
  Whisper `onnx-community/whisper-small` (fallback). The no-egress posture from
  PR #12 / su-0hi is preserved: the engine module is accepted **same-origin
  only** (a remote `?sttEngine=` is rejected back to the default and warned),
  `env.allowRemoteModels=false`, and no microphone audio leaves the page —
  provisioning is the only network fetch and it runs at deploy time, not in the
  running app.

  Query params retune per run without a code edit (feel-test), never relaxing
  that posture:

  ```
  ?stt=off                       # kill switch → force the labelled stub (also: stub|none|0|false|no)
  ?sttEngine=<same-origin url>   # override the engine module (must be self-hosted)
  ?sttModel=<moonshine id/path>  # override the primary model   (alias: ?moonshine=)
  ?sttFallback=<whisper id/path> # override the fallback model  (alias: ?whisper=)
  ```

  A deploy that skips provisioning — and CI, where there is no headless mic or
  bundled weights — has no assets to load, so the adapter degrades to a
  transparent, labelled **stub** (`⟨speech 1.4s — STT model not loaded⟩`), and
  the Stage shows the live mode (`STT (moonshine|whisper|stub)`). The transcript
  **alignment** logic (`src/transcript.ts`) is identical and fully unit-tested
  regardless of which mode is live; only transcription *quality/read-back*
  depends on the model, resolved on real audio during the feel-test. The Whisper
  fallback exists because Whisper zero-pads every segment to 30 s where Moonshine
  processes variable length proportionally.

- **Listener LLM (U5)** — wired real and served self-hosted, the same pattern as
  STT but on **WebGPU** (the bead's "off the CPU/WASM the STT uses").
  `src/listener.worker.ts` loads a
  [transformers.js](https://github.com/huggingface/transformers.js)-compatible
  engine from the committed same-origin wrapper `public/llm-engine.js` (default
  `device: 'webgpu'`, `dtype: q4f16`, WASM fallback) plus the model under
  `public/models/<id>/`, provisioned at build/deploy by `npm run provision:llm`
  (the `public/llm/` + `public/models/` trees gitignored — large binaries). The
  same no-egress posture holds: the engine module is accepted **same-origin only**
  (`sanitizeEngineUrl`), `env.allowRemoteModels=false`, and no transcript leaves
  the page — provisioning is the only network fetch and it runs at deploy time.

  Per-run overrides, never relaxing that posture:

  ```
  ?llm=off                     # kill switch → force the labelled stub (also: stub|none|0|false|no)
  ?llmEngine=<same-origin url> # override the engine module (must be self-hosted)
  ?llmModel=<id/path>          # override the on-device instruct model
  ```

  SUBSTITUTE-AND-NOTE (mirroring STT/smart-turn): the concrete engine and model
  are the first task of the U5 tuning pass. The validation plan names **WebLLM
  (MLC)** as the browser runtime and U2 (`docs/findings/on-device-text-quality.md`)
  lists the candidate class — Llama-3.2-3B / Qwen2.5-3B / Phi-3.5-mini /
  Gemma-2-2B at q4f16, with **Llama-3.2-1B** the VRAM drop-target — but finalises
  none (its score tables are pending real GPU). The adapter therefore ships the
  1B drop-target as a transformers.js-ONNX placeholder default (consistent with
  the STT engine stack) and stays engine-agnostic behind the same-origin
  `?llmEngine=` override, so U2's finalised pick — or a WebLLM/MLC wrapper — swaps
  in without a code edit. With no provisioned assets — or `?llm=off` — the adapter
  degrades to a labelled stub (`⟨listener: reflection — LLM not loaded⟩`) that
  still shows which tier the gate chose; the gate logic is identical and fully
  unit-tested regardless, so only reply *wording* depends on the model, validated
  on real audio during the feel-test.

- **TTS voice (U6)** — wired real and served self-hosted, the same pattern as STT
  (CPU/WASM). `src/tts.worker.ts` runs a
  [transformers.js](https://github.com/huggingface/transformers.js)-compatible
  `text-to-speech` pipeline from the committed same-origin wrapper
  `public/tts-engine.js` (`device: 'wasm'`, `dtype: q8`) plus the model under
  `public/models/<id>/`, provisioned at build/deploy by `npm run provision:tts`
  (the `public/tts/` + `public/models/` trees gitignored — large binaries). The
  same no-egress posture holds: the engine module is accepted **same-origin only**
  (`sanitizeEngineUrl`), `env.allowRemoteModels=false`, and no synthesized audio
  leaves the page — provisioning is the only network fetch and it runs at deploy
  time. Synthesis runs in a Web Worker off the main thread and off the GPU (the
  listener's); STT (listening) and TTS (responding) never contend for CPU/WASM at
  the same time.

  Per-run overrides, never relaxing that posture:

  ```
  ?tts=off                     # kill switch → force the placeholder tone (also: stub|none|0|false|no)
  ?ttsEngine=<same-origin url> # override the engine module (must be self-hosted)
  ?ttsModel=<id/path>          # override the on-device voice model
  ```

  SUBSTITUTE-AND-NOTE (mirroring STT/LLM, and the operator's "tangibility first"
  steer — a crude-but-real spoken reply beats a polished voice that takes longer):
  the concrete voice is the first task of a U6 tuning pass. The adapter ships
  **Xenova/mms-tts-eng** — a small VITS voice with a transformers.js ONNX export
  and no speaker-embedding step, so a single `synthesize(text)` runs it on
  CPU/WASM — as the placeholder default, and stays engine-agnostic behind the
  same-origin `?ttsEngine=` override so a finalised pick swaps in without a code
  edit. With no provisioned assets — or `?tts=off` — the adapter degrades not to
  silence but to a short, labelled **placeholder tone** (the audible analog of the
  listener's labelled-text stub), so the warmed loop still audibly closes and the
  Stage shows the live mode (`tts (wasm|stub)`); only voice *quality* depends on
  the model, validated on real audio during the feel-test.

- **Denoise stage — background-noise robustness (increment 2)** — an on-device
  noise-suppression stage that sits **ahead of the Silero VAD**: the mic is
  routed mic → denoise `AudioWorkletNode` → `MediaStreamDestination`, and the VAD
  captures the **denoised** stream. This is the coffee-shop repro fix — with the
  audio cleaned, light background music no longer fills the silence gap or reads
  as false speech, so the gap reappears and turns end. `src/denoise.ts` is the
  adapter; `src/vad.ts` feeds the denoised stream to `@ricky0123/vad-web`'s
  `stream` option. Served self-hosted the same way as STT/LLM/TTS: the committed
  same-origin wrapper `public/denoise-engine.js` loads the RNNoise worklet + wasm
  from `public/denoise/`, provisioned at build/deploy by `npm run
  provision:denoise` (that tree gitignored — binaries). The no-egress posture
  holds: the engine module is accepted **same-origin only** (`sanitizeEngineUrl`,
  a remote `?denoiseEngine=` is rejected back to the default and warned), and no
  microphone audio leaves the page — provisioning is the only network fetch and it
  runs at deploy time.

  Per-run overrides, never relaxing that posture:

  ```
  ?denoise=off                     # kill switch → force passthrough (also: passthrough|none|0|false|no)
  ?denoiseEngine=<same-origin url> # override the engine module (must be self-hosted)
  ```

  Provenance (adopted engine — RNNoise, the mature "just filter it out" tech, not
  hand-rolled DSP):

  | Component | Package / pin | Upstream | License | Source |
  |---|---|---|---|---|
  | RNNoise Web Audio worklet + wasm | `@sapphi-red/web-noise-suppressor@0.3.5` | RNNoise — [xiph/rnnoise](https://github.com/xiph/rnnoise) | MIT | [jsDelivr `@0.3.5/dist`](https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/) · [repo](https://github.com/sapphi-red/web-noise-suppressor) |

  Provisioned-file SHA-256 (also recorded in `public/denoise/manifest.json`):

  ```
  rnnoise/workletProcessor.js  7e95f138ff6901a6a246dd29e6be4a1e8e4ada2baf0bcc04dae065745b51ff3d
  rnnoise.wasm                 8b60a2ab88fdae2d1a9f940249d0eb072f28ba8e796f7304347b4e07839c8853
  rnnoise_simd.wasm            8b60a2ab88fdae2d1a9f940249d0eb072f28ba8e796f7304347b4e07839c8853
  ```

  SUBSTITUTE-AND-NOTE (mirroring STT/LLM/TTS): with no provisioned assets — a
  fresh clone, CI, an un-provisioned deploy — or `?denoise=off`, the adapter
  degrades to a transparent **passthrough** that returns no stream, so the VAD
  captures the mic itself, **byte-identical to the pre-denoise path**. That is the
  downstream-safety guarantee — the tested turn-detection state machine
  (`spec/turn-state-machine.md` + vectors) is provably unchanged whenever denoise
  is off. The Stage shows the live mode (`denoise (rnnoise|passthrough)`). The
  real-time RNNoise worklet runs only in a browser (headless CI has no Web Audio),
  so — exactly like the STT model export — it is validated on real background
  music during the operator feel-test; the CI-tested surface is the adapter's
  passthrough/fallback contract (`src/denoise.test.ts`) and the config resolver
  (`src/denoise-config.test.ts`). The stage stays engine-agnostic behind the
  same-origin `?denoiseEngine=` override, so a DTLN/ONNX module can swap in
  without a code edit.

## Verification boundary

Open-PR criteria (met): scenarios 1–5 pass as automated tests, the asymmetric
veto and scenario-6 measurement pass, the transcript-alignment, STT-fallback,
response-hierarchy-gate, listener-fallback, listener-config, **TTS-fallback,
TTS-config, and loop-metrics** suites pass, the project type-checks, and the
harness builds and runs live with working knobs. The **operator feel-test** —
talking through a real **warmed loop** and rating it against the usefulness bar —
is a separate post-merge gate owned by the epic host, and is where the live mic +
real smart-turn, STT, listener, and **TTS** models are exercised end to end (real
transcription read-back, reply *quality*, and the spoken back-and-forth are
validated there, not in CI — CI pins the gate ROUTING and the loop-latency math,
which are model-independent). Rating a real warmed session is where the epic's
decision-ready verdict (U8) gets its evidence.

## The works-check (pre-operator gate)

```
npm run works-check                    # exit 0 pass · 100 regression (names the stage) · other = infra
npm run works-check -- --with-listener # ...and load the 1.69G listener model + generate (minutes)
```

The layer the node suite cannot be (su-lou.8: 25/25 green while a real browser
degraded three stages): a standalone, headless proof that the pure-WASM voice
stages a deploy would ship actually **work**. It builds a probe-only entry
(`probe.html` → `src/probe.ts`, never part of the production build), serves it
with `vite preview` on pinned `:4650`, drives a headless Chromium through the
REAL `createTranscriber`/`createSpeaker` adapters with the app's own config
resolvers, and asserts each stage (1) loads its real backend — moonshine/whisper
for STT, `wasm` for TTS, never a labelled stub — and (2) survives a smoke-run
with non-empty output: a transcript of `test/fixtures/utterance.wav`, audible
synthesized samples. Load-assert alone is not enough — a stage can load green
and still degrade per call, so the smoke-run is asserted separately.

**The listener** (su-lou.9) is checked in two tiers, because its halves cost
four orders of magnitude apart:

- **always** — every rung of the listener's device ladder
  (`src/listener-backends.ts`) must have its weights actually *served*: the ONNX
  graph **and** the `_data` sibling that holds the gigabytes. Milliseconds, and
  it is the only listener assertion that covers the `webgpu/q4f16` rung an
  **operator** runs — this browser exposes no WebGPU adapter with `shader-f16`, so
  it can never load that rung, only prove the deploy serves it.
- **`-- --with-listener`** — additionally load the model and generate a reply,
  asserting a real backend and that the reply is *language*: a WebGPU adapter
  without `shader-f16` loads q4f16 happily and emits `"!!!!!!!!!!!!"`, which
  every other liveness rule here would have greened. Budget ~5 minutes: the page
  is not cross-origin isolated, so ORT runs the WASM backend single-threaded
  (228s to load 1.69G, vs ~52s served with COOP/COEP).

Denoise and smart-turn stay unguarded on purpose: denoise is an AudioWorklet
over a live mic MediaStream (no mic, no audio graph, headless), and smart-turn
has no provisioned model at all — nothing sets its `modelUrl`, so `heuristic` is
the designed state, not a degrade.

Prereqs: `npm run provision:stt` + `provision:tts` + `provision:llm`, and a
Playwright browser (`npx playwright install chromium-headless-shell`). Missing
prereqs exit as **infra** with the remedy named — never confusable with a code
regression.
Forensics land in `.works-check/report.json` (probe report, verdict, browser
console tail). Exit codes are the contract the refinery-side gate consumes;
scripts/works-verdict.mjs owns the rules and is unit-tested in `npm test`.
