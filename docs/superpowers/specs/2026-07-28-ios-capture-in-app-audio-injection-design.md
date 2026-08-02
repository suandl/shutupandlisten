# iOS Capture — In-App Audio-File Injection — Design

**Date:** 2026-07-28
**Branch:** `claude/ios-app-evaluation-wre62e`
**Status:** Approved design (pre-implementation)

## Goal

Give the visual-capture pipeline a **real-transcription drive path that needs no
virtual audio device**. Under a test flag, the app reads a bundled fixture
`.wav` and feeds it through the *same* code the microphone tap uses, so the
running session transcribes real `SFSpeech` output and — as far as the real
pipeline allows — escalates a turn, lands a stubbed listener reply, and shows the
analyst's SUGGESTED hint. This becomes the **default "real content" capture
path**; the existing display-only seed (`-captureSeedTranscript`) drops to being
the ultimate fallback.

The prior design (`2026-07-27-ios-visual-capture-ci-design.md`) accepted
**BlackHole** — a HAL virtual audio device feeding the fixture into the host mic
— as the flaky-but-workable "real audio" step. Research confirms Apple offers no
native simulator-mic injection, but the community-standard alternative is to feed
a bundled file **directly into the audio/speech path inside the app**, bypassing
the mic. That is what this spec designs. BlackHole, `SwitchAudioSource`, and
`afplay` are removed from the pipeline.

Decisions locked during brainstorming:

- **Injection level:** buffer-based into the *live* pipeline path (not
  whole-file `SFSpeechURLRecognitionRequest`). Rationale below (§Architecture).
- **New flag** `-captureInjectAudio`, composing with `-uiTestCapture`; it is the
  CI default. `-captureSeedTranscript` remains the last-resort paint.
- **Fixture bundled** into `App/Resources/` so `Bundle.main` can read it.
- **Boundary:** transcription + VAD + turn/gate/analyst-driver run **real**;
  Claude/analyst *replies* stay stubbed by `CaptureURLProtocol`.
- **Never assert on transcript text**; the fallback chain guarantees artifacts.

## Constraints & context

- The **App target only builds on macOS/Xcode**; the Linux devcontainer builds
  and tests only `ios/ShutUpAndListenKit`. All capture runs on a Mac.
- `AudioPipeline.process(_:)` is the single fan-out point: it calls `onBuffer`
  (→ `SpeechTranscriber.append`), writes the recording sink, runs the RMS VAD
  (`onSpeechStart`/`onSpeechEnd`), and emits `onLevel` (the decibel-reactive
  ring). Anything fed through `process(_:)` drives the whole downstream chain for
  real. This is the seam.
- `SessionController.startSession()` already **skips the mic/speech permission
  prompts** under `CaptureSeam.isActive`, wires the pipeline→transcriber→
  detector→analyst callbacks, and starts the `AVAudioEngine`.
- The fixture is `ios/fixtures/demo-conversation.wav` — 16 kHz mono LEI16 PCM,
  ~15.7 s, four sentences matching `capture-fixture.json`'s `seedTranscript`.
  Today it is **only host-side** (played by `afplay`); it is *not* in the app
  bundle.
- `SFSpeechRecognizer` in the simulator is itself flaky: it may report
  unavailable or fall back to Apple's *server-based* recognition. The
  `CaptureURLProtocol` stub already intercepts **only** the Claude/proxy hosts
  (`CaptureHosts`), so Apple speech endpoints pass through.

## Architecture

### Injection level — buffer-based, and why

Two candidates were weighed against the goal (a real listener reply *and* hint
must actually appear, not just transcript text):

- **(a) Buffer-based into the live path — CHOSEN.** Read the `.wav` via
  `AVAudioFile`, chunk it into `AVAudioPCMBuffer`s, and push each chunk through
  the same `AudioPipeline.process(_:)` fan-out the mic tap feeds, paced to
  real time. Every downstream stage runs *for real*: RMS VAD →
  `onSpeechStart`/`onSpeechEnd`, `onBuffer` → `SpeechTranscriber` live
  transcription, `onLevel` → the reactive ring, `LinguisticEOU` → `TurnDetector`
  turn-end → `decideTier` gate → (analyst pool candidate | stubbed model reply) →
  listener line, and `analyst.tick` on the growing transcript → SUGGESTED hint.
- **(b) Whole-file `SFSpeechURLRecognitionRequest`** (reuse `FileTranscriber`).
  Simpler and already written, but it **bypasses `AudioPipeline` entirely**: no
  VAD, so no `speechEnd` → no turn-end → no gate escalation → **no listener reply
  and no analyst-driven hint**, and partials do not necessarily stream in
  real time. It produces transcript text and nothing else.

Because the whole point is to show the *downstream* surfaces (reply, hint, ring)
built from real speech, **(a) is the only path that reaches the goal.** (b) is
rejected even though it is less code.

### The injector

A new App-layer `CaptureAudioInjector` (compiled in, inert unless the flag is
present) owns the file-drive loop:

```
CaptureAudioInjector.start(clockOrigin:) under -captureInjectAudio
  1. Bundle.main url(forResource: "demo-conversation", withExtension: "wav")
  2. AVAudioFile(forReading:) → read into float32, deinterleaved buffers
     matching the transcriber/VAD expectations (floatChannelData[0] present)
  3. FileInjectionPlan (Kit, pure) computes chunk boundaries + per-chunk
     timestamps from (frameCount, sampleRate, chunkFrames ≈ 2048)
  4. a paced DispatchSourceTimer emits one chunk per tick, tick interval =
     chunkFrames / sampleRate (real-time), calling the pipeline's process fan-out
  5. natural inter-sentence silence in the file drives the RMS VAD's hangover
     (380 ms) → onSpeechEnd → turn-end at each pause
  6. on EOF, stop; leave the session running so the ended/idle checkpoints render
```

`AudioPipeline` gains an **injection mode** rather than a second engine graph:
under the flag `startEngine()` **does not install the input tap** (the simulator
mic is silent; a live tap would only pollute the noise floor), but the engine
still starts so TTS/AEC render the listener's spoken reply as in production. The
injector calls straight into the existing private fan-out. Concretely,
`AudioPipeline` exposes an internal `injectForCapture(_ buffer:)` that runs the
identical body as `process(_:)` (recording write + VAD + `onBuffer`/`onLevel`),
so there is **one** VAD/metering implementation, exercised by both mic and file.

We deliberately do **not** use `AVAudioPlayerNode` + a re-capturing tap (needs a
working sim mic loopback) nor the engine's manual/offline render mode (whether it
feeds `SFSpeech` reliably in the sim is unverified — see Open questions). Driving
`process(_:)` directly sidesteps both uncertainties: `SFSpeech` receives ordinary
`append(buffer:)` calls exactly as it does from a live mic.

### Flag composition

- `-uiTestCapture` — arms the whole capture seam (auth bypass, network stub, a11y
  ids, permission skip). Unchanged.
- `-captureInjectAudio` — **new**; requires `-uiTestCapture`. Runs the injector
  instead of the silent mic. **CI default** (the UITest always passes it).
- `-captureSeedTranscript` — display-only fixture paint; unchanged code, demoted
  to fallback.

Precedence: `inject` supersedes `seed` as the *primary* driver, but the two
coexist as a fallback chain (below): injection is attempted first, and the seed
paint is the safety net when real transcription yields nothing.

## Components

1. **`CaptureAudioInjector` (App, new)** — reads the bundled `.wav`, chunks it,
   and paces buffers into `AudioPipeline`'s fan-out. Owned by `SessionController`,
   started from `startSession()` right after `pipeline.start` +
   `transcriber.start`, only when `CaptureSeam.shouldInjectAudio`.

2. **`AudioPipeline` injection mode (App, edit)** — under the flag, skip the mic
   tap; expose `injectForCapture(_:)` sharing the `process(_:)` body. Engine still
   starts for TTS. No production path changes (guarded by the flag).

3. **`CaptureSeam` (App, edit)** — add `injectAudioFlag = "-captureInjectAudio"`
   and `shouldInjectAudio`. No other behavior change.

4. **`FileInjectionPlan` (Kit, new, pure)** — given `frameCount`, `sampleRate`,
   `chunkFrames`, produce the ordered `(frameOffset, frameLength, startMs,
   durationMs)` chunk list and total duration. This is the Linux-testable math
   (chunking, real-time pacing, tail-chunk remainder). Lives in `TurnEngine`
   alongside the other pure timing helpers.

5. **Bundled fixture** — relocate `demo-conversation.wav` into
   `App/Resources/` (auto-bundled). `make-fixture-audio.sh` writes there;
   the host-side `ios/fixtures/` copy is dropped with `afplay`. Author the
   fixture with **≥ ~600 ms inter-sentence pauses** (e.g. `say` `[[slnc 600]]`)
   so each pause clears the 380 ms VAD hangover and a turn-end reliably fires.

6. **Seed fallback watchdog (App, edit — optional)** — in injection mode, if the
   transcript is still empty ~8 s after injection began (SFSpeech unavailable in
   the sim), invoke the existing `seedCaptureStateIfNeeded()` paint so the live
   transcript + hint checkpoints still render. Keeps injection primary, seed as
   net.

## What is real vs stubbed

| Stage | In injection mode |
| --- | --- |
| Audio source | **Fixture `.wav`** read in-app (no mic, no BlackHole) |
| VAD / speech-start/end | **Real** (`AudioPipeline` RMS detector) |
| Level meter / reactive ring | **Real** (`onLevel` from injected buffers) |
| Transcription | **Real** `SFSpeechRecognizer` on injected buffers |
| EOU / turn detection / gate | **Real** (`LinguisticEOU`, `TurnDetector`, `decideTier`) |
| Claude listener reply | **Stubbed** (`CaptureURLProtocol` → `capture-fixture.json`) |
| Analyst candidates / hint | **Stubbed** replies, **real** pool + on-screen surfacing |

The boundary is the network: everything up to and including the *decision to
speak* is real; the *words spoken* by the listener and analyst are canned and
deterministic.

## Reliability strategy

Ordered fallback chain — a run only fails on a genuine build error:

1. **Real injection** — buffers → real SFSpeech → real gate → stubbed reply +
   hint. Preferred.
2. **Seed paint** — if the transcript stays empty (SFSpeech unavailable/
   server-only and unreachable, or the file failed to load), the watchdog (or an
   explicit `-captureSeedTranscript` launch) paints the fixture transcript + top
   hint. Display only.
3. **Capture-whatever-shows** — the UITest snapshots the real screens at each
   checkpoint regardless; the video records regardless.

Guards: `requiresOnDeviceRecognition` is set only when
`supportsOnDeviceRecognition` (already the case in `SpeechTranscriber` /
`FileTranscriber`), so a sim without an on-device model falls to server-based —
which works because only Claude hosts are stubbed. The UITest **never asserts on
transcript words**. Missing checkpoints degrade to a screenshot of whatever is
on screen, never a failure.

The listener-reply checkpoint depends on the real gate escalating to a
substantive tier over the fixture — inherently nondeterministic. To make that
checkpoint dependable without faking transcription, the UITest **may tap the
"pull a thread" control** (`askNow()`), which deterministically requests a
question that the stub answers, landing a real listener line built on the real
transcript. This is an optional nudge, not a fake.

## Build phasing

- **Phase 1 — the seam (Mac):** `FileInjectionPlan` (Kit + tests),
  `CaptureAudioInjector`, `AudioPipeline` injection mode, `CaptureSeam` flag,
  bundle the fixture, and wire it from `startSession()`. **Done when** running
  `capture-demo.sh` locally yields light/dark screenshots + `demo.mov` showing a
  **real** transcript building and the SUGGESTED hint — with BlackHole
  uninstalled.
- **Phase 2 — script + CI cleanup:** strip BlackHole/`SwitchAudioSource`/
  `afplay` from `capture-demo.sh` and the `install BlackHole` step from
  `ios-visual.yml`; keep `xcparse`. Verify one `workflow_dispatch` run.

## capture-demo.sh & CI impact

Removed: the `set host input = BlackHole` block, the `afplay "$FIXTURE_WAV"`
block, the `sleep 6` pre-feed timing hack, and the `BLACKHOLE_DEVICE`/
`FIXTURE_WAV` config. Timing is now **in-app** (the injector paces itself), so
`run_pass` collapses to: boot → set appearance → (light) record video → run the
UITest → stop video. `brew install blackhole-2ch switchaudio-osx` drops from the
workflow; only `xcparse` remains. The pipeline becomes host-audio-free and
deterministic in its drive.

## Testing approach

- **Kit-testable (`swift test`, Linux devcontainer):** `FileInjectionPlan`
  chunking + real-time-pacing math (chunk count, offsets, tail remainder, total
  duration, per-chunk `startMs`); the `CaptureSeam` flag-set shape can be
  asserted via a small pure predicate if factored into `CaptureSupport`. Push the
  timing/chunking arithmetic into the Kit so it has real coverage without a Mac.
- **App-only (Mac-gated):** `AVAudioFile` read, `AVAudioPCMBuffer` construction,
  the `AudioPipeline` injection wiring, and live `SFSpeech` behavior — verified by
  the developer running `capture-demo.sh` (the devcontainer has no Xcode/sim).

## Open questions / risks

- **SFSpeech partials on injected buffers in the sim.** The highest residual
  risk: whether the simulator's recognizer streams partial results for
  programmatically-appended buffers as reliably as for live mic audio, and
  whether it needs the network (server-based) on the CI runner image. Mitigated
  by the seed-paint fallback and by never asserting on text, but it may mean the
  "real transcript" look is only reliable on a developer Mac, not every runner.
- **VAD pauses vs fixture gaps.** Turn-ends require inter-sentence silence to
  exceed the 380 ms hangover. If the current `say`-generated gaps are too short,
  no `speechEnd` fires and the gate never escalates. Mitigation: regenerate the
  fixture with explicit `[[slnc 600]]` pauses; the injector could optionally pad
  gaps, but authoring the pauses into the fixture is preferred (keeps the
  injector a faithful player).
- **Natural reply landing.** Even with turn-ends, whether `decideTier` reaches a
  substantive tier over this specific fixture is nondeterministic; the optional
  `askNow()` nudge is the deterministic backstop for the reply checkpoint.
- **Buffer format.** The `.wav` is 16 kHz mono; buffers must be float32 /
  deinterleaved with `floatChannelData[0]` populated for the VAD RMS loop and the
  transcriber. Read via `AVAudioFile.processingFormat` set to
  `.pcmFormatFloat32`; confirm SFSpeech accepts 16 kHz appended buffers (it does
  for the live path, which runs at the input node's rate).

## Out of scope

- Removing the whole-file `FileTranscriber` path (it remains the authoritative
  post-session reconciliation pass — a different job).
- Multi-fixture / scripted-branching conversations.
- Injecting audio into production (the flag gates everything; no shipping change).
- Visual-regression diffing (this design captures; it does not compare).
