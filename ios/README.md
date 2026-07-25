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
  ShutUpAndListen.xcodeproj   Xcode 16 project (file-system-synchronized)
  App/                        SwiftUI app target (iOS 17+)
  ShutUpAndListenKit/         Swift package: the pure core + Claude adapter
    Sources/TurnEngine/       spec ports — testable headlessly, no audio, no UI
    Sources/ClaudeClient/     raw-HTTP Messages API adapter
    Tests/TurnEngineTests/    golden-vector parity tests + gate tests
```

## How it maps to the repo's spec

This is a second runtime of `spec/turn-state-machine.md` — per the spec's
two-runtimes note, it reimplements the **document**, sharing the algorithm and
the golden vectors with `web/src/`, not the code.

| Piece | Source of truth | iOS implementation |
|---|---|---|
| Turn state machine (patience floor + asymmetric EOU veto, `evaluate` → host decision, utterance/evaluation split) | `spec/turn-state-machine.md` | `TurnEngine/TurnDetector.swift` |
| Golden vectors | `spec/turn-vectors/scenarios/` | replayed by `TurnEngineTests/GoldenVectorTests.swift` (read from the repo checkout — single source of truth) |
| Response hierarchy gate (silence → ack → reflection → question; escalate slowly) | `web/src/response-hierarchy.ts` | `TurnEngine/ResponseHierarchy.swift` |
| Shared completion threshold (one constant, two readers) | `web/src/completion-threshold.ts` | `TurnEngine/CompletionThreshold.swift` |
| Listener system prompt | `prompts/claude.md` | embedded in `TurnEngine/ListenerPrompt.swift` (re-sync on change) |
| Live knobs (silence floor, extension, threshold, baseline arm) | `web/src/knobs.ts` | `SessionController.knobs` + `KnobsView` |

The pipeline is the repo's favored delivery architecture (CONCEPTS.md):
endpointing → STT → text LLM → TTS, run in the **reduced role** — the rules
layer answers silence and acknowledgments with *no model call*; only the rare
substantive tiers (a short reflection, or one anchored question) reach Claude.

### iOS adapters (and their substitutions)

- **VAD** — `App/Audio/AudioPipeline.swift`: adaptive RMS energy detection with
  a ~380 ms hangover (mirroring the web VAD's redemption default), plus voice
  processing (AEC) on the input node so the companion's own speech never reads
  as thinker speech — which is what keeps barge-in honest. A Silero port can
  replace it behind the same two callbacks.
- **EOU** — there is no smart-turn v3 port on iOS yet, so
  `TurnEngine/LinguisticEOU.swift` stands in: a transcript-only P(complete)
  heuristic (trailing "and…"/comma ⇒ incomplete; terminal punctuation or a
  wrap-up phrase ⇒ complete). It feeds the same **asymmetric veto** (spec §2):
  a wrong reading can only make the companion *more* patient, never cut you
  off. Toggle it off in the knobs for the patience-only baseline arm.
- **STT** — `SFSpeechRecognizer`, preferring on-device recognition (the
  repo's off-host economics). New partial words while a pause is being timed
  are fed to the machine as fresh EOU **evidence**, so re-evaluation stays
  evidence-driven, never clock-driven (spec §6).
- **TTS** — `AVSpeechSynthesizer`. The host sizes the machine's response
  window from a duration estimate just before answering `speak`; a barge-in
  cuts the clip instantly (usefulness bar B2).
- **Listener LLM** — Claude (`claude-opus-4-8`) over raw HTTP
  (`ClaudeClient`), since Swift has no official SDK. Your API key lives in the
  Keychain, entered in Settings. An empty reply from the model is treated as a
  `silence` decision — the prompt tells it silence is usually correct, and
  declining is free (spec §4a).

## The customer build

The app is a product, not a developer harness — no API key required:

- **Onboarding** teaches the one non-obvious contract up front: the app
  deliberately does not respond when you pause. A self-running patience-bar
  demo shows a pause filling the window, speech resetting it, and the single
  thread-pull arriving only when the idea lands. A first-session tip
  reinforces it live the first time the machine visibly waits.
- **Account mode** — Sign in with Apple exchanges an identity token with the
  proxy (`server/`, contract in `server/API.md`) for a session token stored in
  the Keychain. The proxy holds the Anthropic key; the app never sees it, and
  the server never sees audio or the running transcript — only the rare
  substantive-tier requests the gate escalates, and explicit coverage checks.
  `ListenerService` is the seam: `ProxyClient` (account) and `ClaudeClient`
  (developer mode, the original BYOK path, now tucked into a Settings
  disclosure) are interchangeable behind it.
- **Session library** — every session is saved (SwiftData): title derived
  from the first words, full transcript, coverage snapshot, and the session
  audio (AAC, recorded off the same mic tap). The library is the home screen:
  search, swipe-to-delete, per-session detail with audio playback and a
  Markdown export via the share sheet. The detail screen also shares the
  session as an **eval fixture** (`sul-fixture-<id>.json`): thinker turns
  only, text exactly as recognized, matching the replay contract in
  `promptfoo/fixtures/README.md` — so a real dictation becomes a
  deterministic regression input for the eval harness. The encoder is the
  platform-agnostic `TurnEngine/FixtureExport.swift`, cross-checked against
  the harness's own Node validator in `TurnEngineTests`.

### Beyond idea-dictation

- **Pull a thread now** — the upon-prompting path: a button that requests the
  one anchored question immediately, bypassing the gate's earned-question
  spacing (you invited it).
- **Coverage mode** — enter a checklist (one topic per line) in Settings; the
  checklist button evaluates the recording so far against it (structured
  outputs, so results parse reliably) and returns one nudge toward the most
  important gap. When a checklist is set, an earned thread-pull may also steer
  toward an untouched topic — but never before the current thought is out.

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

Open `ios/ShutUpAndListen.xcodeproj` in Xcode 16+, set your signing team, and
run on an iOS 17+ device (the mic + speech pipeline is best exercised on
hardware). The Sign in with Apple capability is wired via
`App/ShutUpAndListen.entitlements`; point the app at your proxy deployment in
Settings → Server (or skip sign-in and use developer mode with a personal
Claude API key under Settings → Developer mode).

## Tests

The engine package is platform-agnostic:

```sh
cd ios/ShutUpAndListenKit && swift test
```

runs the golden-vector parity suite (all `spec/turn-vectors/scenarios/`
vectors, exact-output) plus the gate's rule tests — on macOS or Linux; the
tests read the vectors from the repo checkout, so run them from a full clone.
The Swift port's algorithm was additionally cross-checked against all 11
scenario vectors via an instruction-level mirror at port time. The suite is
validated on Linux (Swift 6.3.3 / Ubuntu 24.04, all 42 tests green) and runs
in CI on every PR or push touching the engine, the vectors, or the spec —
see `.github/workflows/swift-tests.yml`.

## Knobs

Defaults match `web/src/knobs.ts`: a 200 ms silence floor (the su-lou.10.6
operator feel-test verdict — responsive, with the asymmetric EOU veto carrying
the don't-cut-thinkers-off guarantee), +4 s incomplete extension, threshold
0.5. The silence floor, extension, and
completion threshold are live-tunable mid-session from the sliders sheet; the
completion threshold moves the detector *and* the gate together — one slider,
both readers.
