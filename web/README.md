# web/ — Rung 1 in-browser harness (U3 timing + U4 STT)

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
turn-detection timing is unchanged. LLM and TTS are still to come (U5–U6).

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
```

`npm test` runs under Node's built-in test runner via native TypeScript
type-stripping, so the crux logic is verifiable without installing anything —
the browser model libs are only needed by the harness, not the tests.

## Using the harness

Two modes (top bar):

- **Simulation** (default) — play a scripted utterance (thinking pause, trailing
  conjunction, clean finish, barge-in) or **Free run**, then drag the knobs. The
  same script ends the turn mid-thought below the floor and holds above it — the
  fastest way to see what the patience window does. No mic or download needed.
- **Microphone** — real Silero VAD + smart-turn on your voice, for the operator
  feel-test. Models load on first start. Speech is transcribed into the
  **Transcript** panel (see below); pass `?sttModel=…` to load a real STT model
  (otherwise a labelled stub keeps the layout legible).

The **Stage** shows the live state, a patience countdown bar (held open visibly
when the incomplete veto is active), the current turn/verdict/arm, and the
stubbed-response indicator (a soft tone, not TTS). The **Transcript** panel
(mic) shows the running transcript grouped by turn: each segment's words, a `⏷`
where speech-end landed, and a `turn-end floor|extended` chip (with how long the
floor held after the last speech) where the detector ended the turn — so you can
read back what was said and see exactly where patience cut or held. The **event
log** streams the input events (← from the audio source) and output events (→
from the detector).

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
audio source ──InputEvent──▶ TurnDetector ──OutputEvent──▶ UI / stubbed response
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
- `src/knobs.ts`, `src/main.ts`, `index.html` — knob specs and UI wiring.

## Component substitutions (per the plan: substitute and note)

- **smart-turn v3 model** — the adapter loads the real ONNX model when a model
  URL is configured; otherwise it degrades to a transparent **duration
  heuristic** (short trailing segments read as "incomplete"), and the Stage shows
  which mode is live. The asymmetric-veto *logic* is identical and fully tested
  either way; only verdict *quality* depends on the model, which is a tuning
  concern resolved on real audio during the feel-test. Wiring a specific
  smart-turn v3 ONNX export (input tensor + mel front-end) is the first task of
  that tuning pass.

- **STT model (Moonshine / Whisper-small)** — mirrors smart-turn. `src/stt.ts`
  runs STT in a Web Worker (`src/stt.worker.ts`, CPU/WASM, off the GPU) that
  loads a [transformers.js](https://github.com/huggingface/transformers.js)-compatible
  engine and model from **operator-supplied URLs**, set via query params for the
  feel-test (no code edit, nothing fetched by default — honouring the plan's
  no-network/self-hosted-weights posture):

  ```
  ?sttEngine=<engine module URL>&sttModel=<moonshine id/path>&sttFallback=<whisper-small id/path>
  ```

  Absent that config — and in CI, where there is no headless mic or bundled
  weights — the adapter degrades to a transparent, labelled **stub**
  (`⟨speech 1.4s — STT model not loaded⟩`), and the Stage shows the live mode
  (`STT (moonshine|whisper|stub)`). The transcript **alignment** logic
  (`src/transcript.ts`) is identical and fully unit-tested regardless of which
  mode is live; only transcription *quality/read-back* depends on the model,
  resolved on real audio during the feel-test. Wiring a specific Moonshine ONNX
  export + tokenizer is the first task of that pass — the same substitution shape
  as smart-turn's, for the same reason (the model is validated in the browser,
  not in CI). The Whisper fallback exists because Whisper zero-pads every segment
  to 30 s where Moonshine processes variable length proportionally.

## Verification boundary

Open-PR criteria (met): scenarios 1–5 pass as automated tests, the asymmetric
veto and scenario-6 measurement pass, the transcript-alignment and STT-fallback
suites pass, the project type-checks, and the harness builds and runs live with
working knobs. The **operator feel-test** — talking through a real session and
tuning the knobs against the usefulness bar — is a separate post-merge gate
owned by the epic host, and is where the live mic + real smart-turn and STT
models are exercised end to end (real transcription read-back is validated
there, not in CI).
