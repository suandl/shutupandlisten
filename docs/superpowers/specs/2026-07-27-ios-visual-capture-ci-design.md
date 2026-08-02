# iOS Visual-Capture CI — Design

**Date:** 2026-07-27
**Branch:** `claude/ios-app-evaluation-wre62e`
**Status:** Approved design (pre-implementation)

## Goal

Produce, for a native SwiftUI iOS app whose core UI is a *live audio
conversation*, a repeatable pipeline that drives a realistic session and
captures **screenshots (light + dark) and a demo video** of the real screens.
Primary consumers: PR reviewers who want to *see* UI changes without building
locally, and the developer wanting an end-to-end demo of a real conversation
flow.

Decisions locked during brainstorming:

- **Primary outputs:** PR visual artifacts + a full end-to-end conversation demo.
- **Drive mechanism:** mock the Claude/proxy network at the app layer, inject
  real audio into the simulator mic, and let the *real* `SpeechTranscriber`
  transcribe it (accepted as the realistic-but-flaky path).
- **Delivery:** downloadable artifacts (no auto PR comment).
- **Capture matrix:** one modern iPhone (iPhone 16 Pro), light + dark.
- **Execution model:** a single shared script is the source of truth; the
  developer runs it **locally on their Mac** as the primary path, and a GitHub
  Actions workflow runs the same script **on demand** (`workflow_dispatch`
  only — no per-PR runs).

## Constraints & context

- The **App target only builds on macOS/Xcode**; the Linux devcontainer can
  build/test only `ios/ShutUpAndListenKit`. So all capture runs on a Mac (the
  developer's host, or a macOS Actions runner).
- The app needs a **microphone, Sign in with Apple, and the Claude API** — none
  of which exist naturally in a CI simulator. Each needs a seam or an injection.
- **No shared Xcode scheme and no UITest target exist yet** (single app target;
  schemes live in `xcuserdata`). Both must be created.
- The Claude/proxy network goes through the Kit client (`AccountStore` + Kit
  `ClaudeClient`); audio is real `AVAudioEngine` + `SFSpeech` in
  `App/Audio/SpeechTranscriber.swift` / `AudioPipeline.swift`.

## Two audio/network landmines (design drivers)

1. **Simulator mic injection is not Apple-supported.** `simctl` cannot feed a
   file into the simulator mic. The workable technique is a **HAL virtual audio
   device** (BlackHole) set as the Mac's default input, into which the fixture
   `.wav` is played; the simulator reads host input as "live mic." This is the
   flakiest step.
2. **Speech recognition may require the network.** `SFSpeechRecognizer` in the
   simulator often falls back to Apple's *server-based* recognition. The network
   stub must therefore be **selective** — intercept *only* the Claude/proxy
   host and let Apple speech endpoints pass through.

## Architecture

A single script, `ios/scripts/capture-demo.sh`, is the source of truth and runs
the full pipeline. Both the developer's Mac and the GitHub workflow invoke it,
so what is validated locally is exactly what CI runs.

```
capture-demo.sh
  1. build-for-testing        (xcodebuild, shared scheme)
  2. boot iPhone 16 Pro sim   (simctl)
  3. set default input = BlackHole, start recordVideo
  4. play fixtures/demo-conversation.wav into BlackHole (timed)
  5. test-without-building    (XCUITest, -uiTestCapture)
       → real SpeechTranscriber transcribes injected audio
       → URLProtocol stub returns canned Claude replies
       → screenshots at checkpoints (idle, live transcript,
         listener reply, question card)
  6. toggle simctl appearance dark → repeat capture pass
  7. stop recordVideo; extract screenshots from .xcresult (xcparse)
  8. collect artifacts into ios/build/artifacts/
```

### Components

1. **App-side test seams** — compiled in, inert unless launch argument
   `-uiTestCapture` is present (production behavior untouched):
   - **Auth bypass:** seed a fake signed-in `AccountStore` state so the app
     lands on the live session screen (no Sign in with Apple in CI).
   - **Network stub:** register a CI-only `URLProtocol` that intercepts only the
     Claude/proxy host and replays canned listener/analyst replies from a bundled
     JSON fixture; all other hosts (Apple speech) pass through. Makes *replies*
     deterministic even though transcription is not.
   - **Accessibility identifiers:** stable IDs on the start control, `SessionView`
     transcript, `PatienceRing`, hint line, and `QuestionCard` so the UITest can
     wait on and snapshot them.

2. **Audio injection (runner/host setup):** install BlackHole (Homebrew), set it
   as the Mac's default input, `afplay` the fixture `.wav` timed to the session
   window. Fixture `.wav` is a short scripted conversation checked into the repo.

3. **UITest target + shared scheme:** new `ShutUpAndListenUITests` target and a
   **shared** `ShutUpAndListen` scheme (required for `xcodebuild -scheme` in CI).
   The test launches with `-uiTestCapture`, taps Start (real tap, for realism),
   and captures screenshots at checkpoints as `XCTAttachment`s. Appearance is
   toggled with `simctl ui booted appearance dark|light` and the pass runs twice.
   `simctl io booted recordVideo demo.mov` wraps the run for video.

4. **GitHub workflow** `ios-visual.yml` — Phase 2. Triggers on
   `workflow_dispatch` only. Steps: checkout → select Xcode 16 → install BlackHole
   → cache SwiftPM → `./ios/scripts/capture-demo.sh` → upload
   `ios/build/artifacts/**` (screenshots + `demo.mov`) with `if: always()`.

## Reliability strategy

Because audio injection is the accepted flaky element, artifacts must always be
produced:

- Captures are **checkpoint-based and never assert on transcript *text***. If
  audio yields nothing, screenshots still capture the real screens and the video
  still records.
- Artifact upload uses `if: always()`.
- Only a genuine **build/compile failure** fails the job — a useful secondary
  gate catching App-target breakage that the Kit tests cannot.
- If host audio injection proves unusable on the Actions runner image, the
  fallback is a scripted in-app replay (behind the same `-uiTestCapture` flag)
  that feeds a canned transcript for the "live transcript" look; screenshots and
  video still reflect real screens.

## Build phasing

- **Phase 1 — local, on the Mac (first):** app-side seams, audio injection,
  UITest target + shared scheme, and `capture-demo.sh`. **Done when** running
  `./ios/scripts/capture-demo.sh` locally yields `demo.mov` + light/dark
  screenshots of real screens. No YAML yet.
- **Phase 2 — on-demand CI:** the `workflow_dispatch` wrapper so GitHub can run
  the same script on demand and upload artifacts.

## Testing approach

- Seam *logic* that can live in `ShutUpAndListenKit` (e.g. the canned-response
  fixture shape, host-match predicate for the `URLProtocol` stub) gets real
  `swift test` coverage in-container.
- The end-to-end pipeline is verified by the developer running Phase 1 on their
  Mac (the devcontainer has no macOS/Xcode). Phase 2 is verified by a manual
  `workflow_dispatch` run once Phase 1 works.

## Cost & limitations

- macOS Actions minutes bill at 10×; a run is roughly 8–15 min. Manual trigger
  keeps spend under developer control.
- Transcript *content* is nondeterministic (real speech recognition of injected
  audio); the design does not depend on exact text.
- Simulator mic injection is the highest-risk step and may behave differently on
  the GitHub runner image than on the developer's Mac — hence Phase 1 validates
  it on real hardware first.

## Out of scope

- Auto PR comments with inline images.
- iPad / multi-device matrix.
- Per-PR automatic runs.
- Visual-regression *diffing* against reference images (this design captures, it
  does not compare).
