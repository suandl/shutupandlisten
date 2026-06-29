# web/ — Rung 1 in-browser harness (U3, timing-only)

The product-defining turn-detection layer, built first and in isolation as a
**timing-only milestone**: Web Audio → Silero VAD → a configurable **silence
floor** (the patience window) → **smart-turn v3** as an asymmetric veto → a
**stubbed** canned response. No STT, LLM, or TTS yet (those are U4–U6) — the
point is to feel the patience against the [usefulness bar](../docs/usefulness-bar.md)
(B1 "holds silence through an unfinished thought", B2 "yields the floor
instantly") before any model quality is in play.

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
  feel-test. Models load on first start.

The **Stage** shows the live state, a patience countdown bar (held open visibly
when the incomplete veto is active), the current turn/verdict/arm, and the
stubbed-response indicator (a soft tone, not TTS). The **event log** streams the
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
audio source ──InputEvent──▶ TurnDetector ──OutputEvent──▶ UI / stubbed response
(mic | sim)                  (pure, tested)
```

- `src/turn-detection.ts` — the crux: pure `(state, event)` reducer. Floor +
  asymmetric smart-turn veto, live knobs, stubbed response, barge-in. No audio
  code. Fully unit-tested by the golden vectors.
- `src/vad.ts` — microphone adapter (Silero VAD via `@ricky0123/vad-web`).
- `src/smart-turn.ts` — smart-turn v3 adapter (`onnxruntime-web`) + heuristic
  fallback (see substitutions).
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

## Verification boundary

Open-PR criteria (met): scenarios 1–5 pass as automated tests, the asymmetric
veto and scenario-6 measurement pass, the project type-checks, and the harness
builds and runs live with working knobs. The **operator feel-test** — talking
through a real session and tuning the knobs against the usefulness bar — is a
separate post-merge gate owned by the epic host, and is where the live mic +
real smart-turn model are exercised end to end.
