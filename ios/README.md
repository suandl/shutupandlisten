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

### Beyond idea-dictation

- **Pull a thread now** — the upon-prompting path: a button that requests the
  one anchored question immediately, bypassing the gate's earned-question
  spacing (you invited it).
- **Coverage mode** — enter a checklist (one topic per line) in Settings; the
  checklist button evaluates the recording so far against it (structured
  outputs, so results parse reliably) and returns one nudge toward the most
  important gap. When a checklist is set, an earned thread-pull may also steer
  toward an untouched topic — but never before the current thought is out.

## Building

Open `ios/ShutUpAndListen.xcodeproj` in Xcode 16+, set your signing team, and
run on an iOS 17+ device (the mic + speech pipeline is best exercised on
hardware). On first launch: grant microphone and speech-recognition access,
then add a Claude API key in Settings.

## Tests

The engine package is platform-agnostic:

```sh
cd ios/ShutUpAndListenKit && swift test
```

runs the golden-vector parity suite (all `spec/turn-vectors/scenarios/`
vectors, exact-output) plus the gate's rule tests — on macOS or Linux; the
tests read the vectors from the repo checkout, so run them from a full clone.
The Swift port's algorithm was additionally cross-checked against all 11
scenario vectors via an instruction-level mirror at port time. No Swift
toolchain was available in the authoring environment, so run `swift test`
locally before relying on changes to the engine.

## Knobs

Defaults bias to "keep listening" (2 s floor, +4 s incomplete extension,
threshold 0.5), matching `web/src/knobs.ts`. The silence floor, extension, and
completion threshold are live-tunable mid-session from the sliders sheet; the
completion threshold moves the detector *and* the gate together — one slider,
both readers.
