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
    Audio/                    mic pipeline (VAD, AEC, interruptions), STT, TTS
    UI/                       session screen + patience ring, library, settings
    Support/                  SwiftData records, crash recovery, keychain, account
    Intents/                  App Intents — Siri / Shortcuts / Action button (in flight)
  ShutUpAndListenKit/         Swift package: the pure core + Claude adapter
    Sources/TurnEngine/       spec ports — testable headlessly, no audio, no UI
    Sources/ClaudeClient/     raw-HTTP Messages API adapter
    Tests/                    golden-vector parity, gate, mode & preset tests
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

- **VAD** — `App/Audio/AudioPipeline.swift`: adaptive RMS energy detection with
  a ~380 ms hangover (mirroring the web VAD's redemption default), plus voice
  processing (AEC) on the input node so the companion's own speech never reads
  as thinker speech — which is what keeps barge-in honest. A Silero port can
  replace it behind the same two callbacks. The pipeline also owns the
  survival seam: `AVAudioSession` interruptions, route loss, and
  media-services resets surface through one callback, and
  `SessionController` decides whether to park, resume, or finalize.
- **EOU** — there is no smart-turn v3 port on iOS yet, so
  `TurnEngine/LinguisticEOU.swift` stands in: a transcript-only P(complete)
  heuristic (trailing "and…"/comma ⇒ incomplete; terminal punctuation or a
  wrap-up phrase ⇒ complete). It feeds the same **asymmetric veto** (spec §2):
  a wrong reading can only make the companion *more* patient, never cut you
  off. Toggle it off in the developer Tuning sheet for the patience-only
  baseline arm.
- **STT** — `SFSpeechRecognizer`, preferring on-device recognition (the
  repo's off-host economics). New partial words while a pause is being timed
  are fed to the machine as fresh EOU **evidence**, so re-evaluation stays
  evidence-driven, never clock-driven (spec §6).
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
  talk. The stage is a single breathing **patience ring**
  (`App/UI/PatienceRing.swift`) in one warm accent — an inner glow answers
  the mic level while you talk, and the ring fills as the patience window
  runs; resumed speech dissolves it. Three lowercase state words
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
- **App Shortcuts** — App Intents for starting/stopping a session and
  pulling a thread (Siri, Shortcuts, the Action button), with an
  `AppShortcutsProvider`, are landing under `App/Intents/` in a parallel
  work stream on this branch.

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

Open `ios/ShutUpAndListen.xcodeproj` in Xcode 16+, set your signing team, and
run on an iOS 17+ device (the mic + speech pipeline is best exercised on
hardware). The target declares the `audio` background mode, and the Sign in
with Apple capability is wired via `App/ShutUpAndListen.entitlements`. To
point the app at your own proxy deployment, or to skip sign-in and use a
personal Claude API key, unlock the Developer section first (tap the version
row in Settings five times).

Note: this branch has been validated headlessly only — the Kit test suite
runs on Linux and every App file is parse-checked, but the app has not yet
been built or run on a device or simulator. Background continuation,
interruption recovery, haptics, and sign-in are device-only claims until a
hardware pass confirms them.

## Tests

The engine package is platform-agnostic:

```sh
cd ios/ShutUpAndListenKit && swift test
```

runs the golden-vector parity suite (all `spec/turn-vectors/scenarios/`
vectors, exact-output) plus the gate's rule tests and the mode / just-listen
/ coverage-preset tests (61 tests) — on macOS or Linux; the
tests read the vectors from the repo checkout, so run them from a full clone.
The Swift port's algorithm was additionally cross-checked against all 11
scenario vectors via an instruction-level mirror at port time. The full
suite runs green on Linux; the app target itself is not covered by it (see
the Building note).

## Knobs

Defaults match `web/src/knobs.ts`: a 200 ms silence floor (the su-lou.10.6
operator feel-test verdict — responsive, with the asymmetric EOU veto carrying
the don't-cut-thinkers-off guarantee), +4 s incomplete extension, threshold
0.5. The sliders are a developer surface now — consumers ship the defaults;
the Tuning sheet (with the baseline-arm toggle) lives behind Settings →
Developer. There, the silence floor, extension, and completion threshold are
live-tunable mid-session, and the completion threshold moves the detector
*and* the gate together — one slider, both readers.
