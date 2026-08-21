# shutupandlisten for iOS

A native iOS build of the quiet thought companion: it listens like a voice
recorder while you think out loud, waits out your pauses, and — only when a
thought has actually landed, or when you ask — pulls on one specific thread of
what you said to help you take the idea further.

Silence and timing are the product. The app never treats a pause as its cue:
end-of-turn is decided by the same patience-first state machine as the web
build, and even then the model is *asked* whether to speak — declining costs
nothing.

## Layout

```
ios/
  ShutUpAndListen.xcodeproj   Xcode 26 project (file-system-synchronized)
  App/                        SwiftUI app target (iOS 26+)
    Audio/                    capture graph (VAD, AEC, interruptions), STT, TTS
    UI/                       session screen + horizon line, library, settings
    Support/                  SwiftData records, crash recovery, keychain, account
    Intents/                  App Intents — Siri / Shortcuts / Action button
  ShutUpAndListenKit/         Swift package: the pure core + Claude adapter
    Sources/TurnEngine/       spec ports — testable headlessly, no audio, no UI
    Sources/ClaudeClient/     raw-HTTP Messages API adapter
    Sources/TranscriptCore/   the transcript spine: append-only store actor,
                              multicast events, turn tagging, storage mapping
    Tests/                    golden-vector parity, gate, mode & preset tests,
                              store revision/tagging/multicast fixtures
  mockups/                    self-contained HTML design mockups + identity spec
```

## How it maps to the repo's spec

This is a second runtime of `spec/turn-state-machine.md` — per the spec's
two-runtimes note, it reimplements the **document**, sharing the algorithm and
the golden vectors with `web/src/`, not the code.

| Piece | Source of truth | iOS implementation |
|---|---|---|
| Turn state machine (patience floor + asymmetric EOU veto, `evaluate` → host decision, utterance/evaluation split) | `spec/turn-state-machine.md` | `TurnEngine/TurnDetector.swift` |
| Golden vectors | `spec/turn-vectors/scenarios/` | replayed by `TurnEngineTests/GoldenVectorTests.swift` (read from the repo checkout — single source of truth) |
| B1 bar vectors (does the gate hold silence through an unfinished thought?) | `spec/turn-vectors/gate/` + `docs/usefulness-bar.md` | replayed by `TurnEngineTests/B1GateReplayTests.swift` through the whole gate path |
| Response hierarchy gate (silence → ack → reflection → question; escalate slowly) | `web/src/response-hierarchy.ts` | `TurnEngine/ResponseHierarchy.swift` |
| Shared completion threshold (one constant, two readers) | `web/src/completion-threshold.ts` | `TurnEngine/CompletionThreshold.swift` |
| Listener system prompt | `prompts/claude.md` | embedded in `TurnEngine/ListenerPrompt.swift` (re-sync on change) |
| Live knobs (silence floor, extension, threshold, baseline arm) | `web/src/knobs.ts` | `SessionController.knobs` + the Tuning sheet (Settings → Developer) |
| Session modes & just-listen (prompt tints + gate cap on the same engine) | this branch | `TurnEngine/SessionMode.swift`, `ResponseHierarchy.GateConfig.justListen` |

The pipeline is the repo's favored delivery architecture (CONCEPTS.md):
endpointing → STT → text LLM → TTS, run in the **reduced role** — the rules
layer answers silence and acknowledgments with *no model call*; only the rare
substantive tiers (a short reflection, or one anchored question) reach Claude.

### iOS adapters (and their substitutions)

- **VAD** — `App/Audio/CaptureController.swift`: adaptive RMS energy detection
  with a ~380 ms hangover (mirroring the web VAD's redemption default), plus
  voice processing (AEC) on the input node so the companion's own speech never
  reads as thinker speech — which is what keeps barge-in honest. A Silero port
  can replace it behind the same two callbacks. The controller also owns
  capture reliability: session interruptions, route changes, engine
  configuration changes, and media-services resets all pause/rebuild/resume
  the engine, with a truthful paused/resuming state in the UI, and the
  canonical fed-samples clock keeps transcript timings file-relative across
  gaps. It reports the *event*; `SessionController` decides the session's
  response (park the turn machine, close an open listener segment, release the
  floor).
- **EOU** — there is no smart-turn v3 port on iOS yet, so
  `TurnEngine/LinguisticEOU.swift` stands in: a transcript-only P(complete)
  heuristic (trailing "and…"/comma ⇒ incomplete; terminal punctuation or a
  wrap-up phrase ⇒ complete). It feeds the same **asymmetric veto** (spec §2):
  a wrong reading can only make the companion *more* patient, never cut you
  off. Toggle it off in the developer Tuning sheet for the patience-only
  baseline arm.
- **STT** — the iOS 26 Speech framework: `SpeechAnalyzer` + its
  `SpeechTranscriber` module (`App/Audio/AnalyzerEngine.swift`, behind the
  `TranscriptionEngine` protocol), on-device always, with the locale model
  ensured via `AssetInventory` at onboarding and re-verified at every session
  start. Volatile results stream and visibly refine until finalized — the
  Siri-style revising behavior — one analyzer session spans the whole
  recording (no duty-cycle restarts), and finalized text carries punctuation
  and audio time ranges. Engine events flow into the `TranscriptCore` store
  (stable segment identity, canonical-timeline ranges); new words while a
  pause is being timed are fed to the machine as fresh EOU **evidence**, so
  re-evaluation stays evidence-driven, never clock-driven (spec §6). There is
  no second offline pass over the recording: with one uninterrupted analyzer
  session the live transcript IS the authoritative one.
- **TTS** — `AVSpeechSynthesizer`. The host sizes the machine's response
  window from a duration estimate just before answering `speak`; a barge-in
  cuts the clip instantly (usefulness bar B2).
- **Listener LLM** — Claude (`claude-opus-4-8`) over raw HTTP
  (`ClaudeClient`), since Swift has no official SDK. In developer mode your
  API key lives in the Keychain (Settings → Developer). An empty reply from
  the model is treated as a `silence` decision — the prompt tells it silence
  is usually correct, and declining is free (spec §4a).

## The customer build

The app is a product, not a developer harness — no API key required, and
every operator surface (tuning sliders, BYOK, proxy URL, the baseline arm)
is hidden behind a developer gate: tap the version row in Settings five
times.

- **Talk-first root** — the app opens *into* the session screen: one tap to
  talk. The stage is a single **horizon line**
  (`App/UI/HorizonLine.swift`) in one warm accent — a hairline that
  *brightens* rather than fills. It burns with your voice while you talk (the
  "am I being heard" answer) and gathers weight while a pause is held; resumed
  speech lets it settle. It carries no percentage and has no end to arrive at,
  because a pause is not a deadline. Three lowercase state words
  (listening / waiting / speaking) replace status chrome; the transcript
  collapses to a one-line peek (tap for the full flowing text). Library and
  settings live behind toolbar icons.
- **The question moment** — when the gate finally escalates, the one
  anchored question arrives staged: a gentle haptic and a card
  (`App/UI/QuestionCard.swift`) that stays pinned until you resume, spoken
  aloud. No tier jargon anywhere on screen.
- **Session survival** — a session must outlive real life. The audio
  background mode keeps the pipeline alive with the screen locked or the app
  backgrounded; interruptions (call, Siri, alarm) park the session and
  auto-resume or finalize it; route loss falls back to the built-in mic. The
  record is **checkpointed** to SwiftData on interruption, on backgrounding,
  and every ~30 s, so a crash loses seconds, not the session — and on next
  launch `App/Support/SessionRecovery.swift` adopts any orphaned recording
  as a playable "Recovered recording". The idle timer is disabled while a
  session runs.
- **Onboarding** teaches the one non-obvious contract: the app deliberately
  does not respond when you pause. Two pages — the promise, then the
  self-running patience demo (a pause filling the window, speech resetting
  it, the single thread-pull arriving only when the idea lands) — followed by
  the mic + speech permission ask. A first-session tip reinforces the
  contract live the first time the machine visibly waits. Sign-in is *not*
  asked up front: it's offered contextually the first time a question
  actually needs the model.
- **Account mode** — Sign in with Apple exchanges an identity token with the
  proxy (`server/`, contract in `server/API.md`) for a session token stored in
  the Keychain. The proxy holds the Anthropic key; the app never sees it, and
  the server never sees audio or the running transcript — only the rare
  substantive-tier requests the gate escalates, and explicit coverage checks.
  `ListenerService` is the seam: `ProxyClient` (account) and `ClaudeClient`
  (developer mode, the original BYOK path, now behind the developer gate)
  are interchangeable behind it. A privacy panel in Settings states —
  verbatim-checkable against the code — what leaves the device and when.
  (Sign in with Apple is compiled out of personal-team builds — see
  [Building](#sign-in-with-apple-is-off-by-default-personal-team-builds).)
- **Session library** — behind a toolbar icon (the session screen is home).
  Every session is saved (SwiftData) with per-utterance **timestamps**:
  title derived from the first words, full transcript, coverage snapshot,
  and the session audio (AAC, recorded off the same mic tap). Rows lead with
  the open question the listener left you with; the detail view headlines
  "The question you left with", supports tap-to-seek between transcript and
  audio, and shares the audio or a Markdown export with YAML frontmatter,
  `[mm:ss]` stamps, and a closing open-question block. Search matches your
  words only, never the listener's. Ending a session lands on the saved
  record — the artifact, not a toast.

### Beyond idea-dictation

- **Pull a thread now** — the upon-prompting path: a button that requests the
  one anchored question immediately, bypassing the gate's earned-question
  spacing (you invited it).
- **Session modes** — chosen on the session screen before you start and
  frozen at session start (never inferred, never switched mid-thought):
  `open` (the default — byte-identical to the base listener prompt,
  test-pinned), `rehearsal` (the listener is your audience; its one question
  is the one they would ask), `debrief` (the question targets the recall gap
  you'll wish you'd captured). Tints on one prompt, not forks of the
  listener.
- **Just listen** — a questions-off toggle: the gate deterministically caps
  every uninvited turn at a quiet acknowledgment — no model call can slip
  through. Pull a thread still asks on demand.
- **Coverage mode** — pick a named checklist preset in Settings (decision,
  weekly retro, standup prep, Feynman study, pitch rehearsal, sales-call
  debrief) or write a custom one, one topic per line. The check evaluates
  the recording so far against it (structured outputs, so results parse
  reliably) and returns one nudge toward the most important gap. When a
  checklist is set, an earned thread-pull may also steer toward an untouched
  topic — but never before the current thought is out. A preset may
  *suggest* its paired mode; it never sets one silently.
- **App Shortcuts** — one zero-parameter hook, `StartListeningIntent`,
  opens straight into a running session; `StopListeningIntent` and
  `PullThreadIntent` act on the live session without foregrounding the
  app, and `StartListeningWithModeIntent` takes a mode for custom
  Shortcuts. All are registered by `SulAppShortcuts` with
  dictation-friendly phrases, so Siri, Spotlight, the Shortcuts app,
  the Action button, and Back Tap work with zero user setup
  (`App/Intents/`).

Design directions still under discussion — the Live Activity / Dynamic
Island, threads & resume, ask-your-library, the on-demand idea page, and the
visual identity — live as self-contained HTML mockups in
[`mockups/`](mockups/README.md).

## Try it without a device

The decision loop is demonstrable from a terminal on macOS or Linux — no
Xcode, no microphone:

```sh
cd ios/ShutUpAndListenKit
swift run sul-demo               # deterministic replay, canned listener replies
swift run sul-demo --realtime    # paced replay — feel the silences
ANTHROPIC_API_KEY=… swift run sul-demo --live   # real Claude replies
```

It replays a scripted thinking-out-loud session (the reading-app idea from
`prompts/claude.md`) through the exact production path — detector → gate →
listener — and prints the timeline. (The demo pins the 2000 ms floor its
script was authored against; the shipped default is 200 ms — see Knobs.)
The run walks every branch: a sub-floor
breath pause waited out, an "and…" pause the veto extends, a patience window
that closes mid-thought and is **declined** (same turn continues — declining
is free), a rules-only backchannel, and one anchored thread-pull:

```
[ 17.80s]         ⏸ pause  (EOU heuristic: P(complete) = 0.05)
[ 23.80s] ⏱ patience window closed (evaluation 1, extended, deadline) → should the listener speak?
[ 23.80s]    gate: detector held turn open (incomplete) — holding silence → silence
[ 23.80s]    ↳ declined — the thinker was never interrupted (free)
[ 24.60s] thinker ▶ “so this one just hides all of it. …”
   …
[ 54.00s]    gate: substantive turn (46w), question cooldown elapsed → question
[ 54.00s]    listener ✦ (thread-pull) “You said you start reading to move the number —
            with the number gone, what makes someone open the app again tomorrow?”
```

## Building

Open `ios/ShutUpAndListen.xcodeproj` in Xcode 26+, set your signing team, and
run on an iOS 26+ device (`SpeechAnalyzer` is iOS 26, and the mic + speech
pipeline is best exercised on hardware). Session audio is written as
AAC-in-CAF while capturing — append-safe, so a crash leaves a readable file —
and remuxed to `.m4a` at graceful stop or by launch recovery. The target declares the `audio` background mode. To point the app
at your own proxy deployment, or to skip sign-in and use a personal Claude API
key, unlock the Developer section first (tap the version row in Settings five
times).

### Sign in with Apple is off by default (personal-team builds)

Sign in with Apple cannot be provisioned by a free/personal Apple Developer
team — automatic signing fails with *"Personal development teams do not
support the Sign In with Apple capability."* So the default build ships the
feature **compiled out**: the active entitlements
(`App/ShutUpAndListen.entitlements`) are empty, the `APPLE_SIGN_IN` compilation
flag is unset, and the account surface falls back to Developer mode (BYOK). The
app builds and signs on a personal token as-is.

To restore the account path on a **paid** team:

1. Add `APPLE_SIGN_IN` to `SWIFT_ACTIVE_COMPILATION_CONDITIONS` for the app
   target (both Debug and Release configs).
2. Point `CODE_SIGN_ENTITLEMENTS` at
   `App/ShutUpAndListen-AppleSignIn.entitlements` (or copy its `<dict>` into
   the active entitlements file) — it carries the
   `com.apple.developer.applesignin` capability.

Nothing else changes: the plumbing (`App/Support/AppleSignIn.swift`, the
sign-in sheet, the Settings account section) is preserved behind the flag.

Note: no hardware pass yet. The app **has** been built and run on a simulator —
`ios-visual.yml` run 31768705979 (2026-08-14, macos-26 / Xcode 26.6) drove a
real session end to end and returned green — and `ios-app-gates.yml` now builds
the app target on every App-touching PR. But background continuation,
interruption recovery, haptics, AEC, and sign-in remain device-only claims until
someone confirms them on a phone.

## Tests

The engine package is platform-agnostic:

```sh
cd ios/ShutUpAndListenKit && swift test
```

runs the golden-vector parity suite (all `spec/turn-vectors/scenarios/`
vectors, exact-output) plus the gate's rule tests, the mode / just-listen
/ coverage-preset tests, and the B1 bar measurement below — on macOS or Linux; the
tests read the vectors from the repo checkout, so run them from a full clone.
The Swift port's algorithm was additionally cross-checked against all 11
scenario vectors via an instruction-level mirror at port time. The app target
itself is not covered by it — that is the app gates below.

`.github/workflows/kit-tests.yml` runs exactly this on every push/PR that
touches the Kit or the vectors — an `ubuntu-latest` runner in the official
`swift:6.1` image, since nothing in the package needs Xcode or a simulator.
It is the repo's first automatically-triggered iOS job. The suite is split
across two steps — the B1 measurement alone, then everything else — so that the
expected-red measurement below cannot mask an unrelated Kit regression.

**The B1 measurement was red, and is not any more — structurally.**
`B1GateReplayTests` measures the gate against usefulness-bar **B1** ("holds
silence through an unfinished thought"). It failed on
`b1-03-unpunctuated-pause-no-cue`: a mid-thought pause carrying no lexical cue
scores `LinguisticEOU`'s 0.6 "no strong cue" default, which is *above* the 0.5
completion threshold, so the veto never fired and the 200 ms floor let the
companion speak into an unfinished sentence
(`docs/findings/b1-gate-measurement-2026-08.md`). `su-uzy9.5` fixed it by
decoupling the two mechanisms that were both reading that one number, rather
than by moving the constant, and the gate now holds all four vectors
(`docs/findings/b1-gate-remeasure-2026-08.md`; the job has been green on `main`
since 2026-08-13). **The standing rule outlives the red: never make this suite
green by weakening a vector.** A failure here is a measurement result to
escalate, per `docs/on-device-quiet-companion-recommendation.md` — which is why
it still runs as its own step, ahead of and separate from the rest of the Kit.

A second test was red when this work started and is not any more:
`AnalystPromptTests.testGrowingTranscriptLeavesEarlierChunksByteIdentical` failed
on a clean `main` too (197 tests, 1 failure at c8c0365). It compared whole
`SystemBlock` values as the transcript grows, but `cached` marks where the cache
breakpoint sits and that marker legitimately advances onto each newly-frozen
chunk; the chunk *text* is byte-identical, which is what a cache hit actually
needs. Filed as `su-3885` and **fixed on `main` in #56** (197 tests, 1 failure →
0 at that point). With `su-uzy9.5`'s fix on top, the whole suite is green: 201
tests, 0 failures. Nothing ran `swift test` before this workflow existed, which
is how it stayed red unnoticed — and is the case for the workflow.

### App gates (the target `swift test` cannot reach)

The Kit is headless; `App/` is not. `.github/workflows/ios-app-gates.yml` is the
`macos-26` counterpart that builds the **app target** and runs the port plan's
non-negotiable gates on every push/PR touching `ios/App`, the app-test target,
the `.xcodeproj`, the Kit's `Package.swift`, or the gate scripts themselves.
Each gate is a script you can run by hand on a Mac — the workflow is a thin
wrapper, the way `capture-demo.sh` is for the visual capture:

| Gate | Script | Proves |
|---|---|---|
| **A3** | `ios/scripts/gate-a3-release-exclusions.sh` | All five capture-seam artifacts are named in the app target's *resolved* Release `EXCLUDED_SOURCE_FILE_NAMES`. Seconds, no build. |
| **B1** | `ios/scripts/gate-b1-app-tests.sh` | The data-safety gate: `MigrationTests`' eight named cases and all of `WriterTests` **actually ran** on a simulator, nonzero and none failed. |
| **B5** | `ios/scripts/gate-b5-release-archive.sh` | The security gate: a Release archive (built unsigned) carries neither capture fixture (`demo-conversation.wav`, `capture-fixture.json`) nor any capture-seam type name. |

A3 and B5 are two mechanisms for one property and the plan requires **both, not
either** — B5 reads symbol *absence*, which dead-stripping can also produce, so
it cannot by itself prove the source was excluded; A3 reads the intent. B1 is a
gate rather than a `⌘U` ritual because `-only-testing` fails the build outright
on an identifier the target does not contain, and because a `jq` assertion over
the result bundle independently requires that cases ran. **Move B1's selector
list and its count floor together** — that is §7's rule, and the floor is a
literal in the script rather than an env knob for the same reason.

The gates run as three steps of one job (one 10x runner, three legible
verdicts), and the later steps use `if: !cancelled()` so a red gate never hides
the one after it. Both proofs — B1's `.xcresult` and B5's log — upload as
`ios-app-gate-artifacts`.

`ios-visual.yml` deliberately stays `workflow_dispatch`: it produces demo video
and screenshots for a human to look at, and is not a gate.

## Knobs

Defaults match `web/src/knobs.ts`: a 200 ms silence floor (the su-lou.10.6
operator feel-test verdict — responsive, with the asymmetric EOU veto carrying
the don't-cut-thinkers-off guarantee), +4 s incomplete extension, threshold
0.5. The sliders are a developer surface now — consumers ship the defaults;
the Tuning sheet (with the baseline-arm toggle) lives behind Settings →
Developer. There, the silence floor, extension, and completion threshold are
live-tunable mid-session, and the completion threshold moves the detector
*and* the gate together — one slider, both readers.
