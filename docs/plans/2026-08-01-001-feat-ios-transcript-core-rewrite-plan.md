---
title: "feat: iOS transcript-core rewrite — SpeechAnalyzer capture spine (iOS 26+, no legacy fallback)"
type: feat
status: active
date: 2026-08-01
origin: iOS voice/transcription review (branch claude/ios-voice-transcription-review-9ss6cj)
---

# feat: iOS transcript-core rewrite — SpeechAnalyzer capture spine (iOS 26+)

## Summary

Rebuild the iOS app's capture layer around the transcript as the core product
artifact. Four premises must hold, in order: (1) the app listens reliably,
(2) transcription is best-in-class — on-device, streaming, visibly revising as
more words arrive, (3) the transcript is persisted incrementally and replayable
in sync with the audio, and (4) any agent can read the running transcript
behind the scenes, live or with seconds of delay.

The rewrite replaces `SFSpeechRecognizer` with the iOS 26 Speech framework
(`SpeechAnalyzer` + its `SpeechTranscriber` module) as the **only** Apple
transcription path — no legacy fallback; the deployment target moves to
iOS 26. The only alternate transcription arm, if one is ever added, is
WhisperKit, behind the same engine protocol. Transcription is always
on-device; off-device remains acceptable for other features (the listener
LLM via the account proxy is unchanged).

The turn engine (`TurnEngine`: detector, gate, golden vectors) is **not**
rewritten — it is the healthiest, best-tested code in the iOS build. The
rewrite is of everything around it: audio capture, transcription, transcript
state, persistence, and the agent seam.

---

## Problem Frame

The current build centers the turn state machine and treats transcription as a
disposable adapter feeding it. The review found the four core premises each
failing in ways that compound:

- **Listening is fragile.** No `UIBackgroundModes: audio` (screen lock kills
  capture), no `AVAudioSession` interruption or route-change handling (a phone
  call or connecting AirPods silently stops the engine while the UI still says
  "listening").
- **Transcription is built on the legacy API and loses data at every seam.**
  `SFSpeechRecognizer`'s duty-cycle limit forces task restarts
  (`App/Audio/SpeechTranscriber.swift`): buffers arriving in the restart gap
  are dropped (`request?.append` with `request == nil`), in-flight volatile
  partials are frozen as final on error, and the recognizer's context resets
  at each boundary. The utterance anchor is a character offset into a mutable
  string that partials revise — it can point past the end or into different
  words exactly when the gate evaluates. `addsPunctuation` is never set, so
  `LinguisticEOU`'s strongest cues (terminal punctuation, trailing
  comma/ellipsis) essentially never fire and most pauses fall through to the
  flat 0.6 default — above the 0.5 threshold, so the incomplete-veto rarely
  triggers and the smart-turn arm quietly collapses toward the baseline arm.
  Per-segment timestamps and confidences are discarded.
- **Persistence is all-or-nothing.** The transcript is saved only in
  `stopSession()`; a crash, app kill, or unhandled interruption loses the
  whole session (the incrementally-written audio survives as an orphan no
  record references). No timestamps are stored, so "replay" is an audio player
  next to a static transcript — no tap-to-seek, no highlight sync.
- **No agent seam exists.** The running transcript lives only in memory on
  `SessionController`/`SpeechTranscriber`. The only reads are point-in-time
  snapshots when the gate escalates and the explicit coverage check. A
  background agent has nothing to attach to — and the server contract
  ("the server never sees audio or the running transcript") forecloses the
  remote variant silently rather than by decision.

These failures cascade: dropped words → broken anchoring → junk EOU evidence →
the patience machine evaluates the wrong text at the wrong time → the flagship
behavior misfires and the turn engine takes the blame.

## Decisions (operator-set)

- **iOS 26 minimum deployment target.** Modern OS only. No
  `SFSpeechRecognizer` code remains anywhere in the tree.
- **`SpeechAnalyzer` is the transcription engine.** If a second arm is ever
  wanted (quality A/B), it is WhisperKit — never a legacy Apple API. The
  second arm is explicitly deferred out of this plan (Phase W, unscheduled).
- **Transcription is on-device, always.** `SpeechTranscriber`'s locale model
  is downloaded via `AssetInventory` and runs locally. Off-device is
  permitted for *other* features (listener LLM, coverage via the proxy), and
  the agent seam may optionally stream finalized transcript off-device behind
  an explicit user toggle — but recognition itself never leaves the phone.

---

## Requirements

**R1 — Reliable listening**
- R1.1 Capture continues with the screen locked and the app backgrounded
  (`UIBackgroundModes: audio`).
- R1.2 Audio interruptions (call, Siri, alarm) and route changes (AirPods
  connect/disconnect) are observed; the engine restarts automatically when
  the session can resume, and the UI truthfully shows a paused/resuming state
  when it cannot.
- R1.3 The recording and the recognizer are fed from a deliberate mic path:
  voice processing (AEC) stays on for barge-in honesty, and this trade-off is
  recorded as a knob-visible fact, not an accident.

**R2 — Best-in-class on-device transcription**
- R2.1 `SpeechAnalyzer` + `SpeechTranscriber` module with volatile results
  enabled: partial text appears immediately and visibly refines until
  finalized — the Siri-style revising behavior.
- R2.2 No duty-cycle restarts, no dropped-buffer seams: one analyzer session
  spans the whole recording session.
- R2.3 Every result carries its `audioTimeRange`; segment timing is kept, not
  flattened away.
- R2.4 Utterance boundaries are anchored by **segment identity + audio time**,
  never by character offsets into a mutable string.
- R2.5 Punctuated output feeds `LinguisticEOU`, so its terminal-punctuation
  and trailing-marker cues actually fire.
- R2.6 The locale model is ensured at onboarding via `AssetInventory`
  (download progress surfaced; graceful message when the locale is
  unsupported).

**R3 — Incremental persistence, true replay**
- R3.1 The `SessionRecord` is created at session **start** and marked complete
  at stop; transcript segments are persisted as they finalize. A crash costs
  at most the current volatile segment.
- R3.2 On next launch, incomplete records are recovered (transcript-so-far +
  audio adopted, record closed) — never silently deleted.
- R3.3 Stored segments carry time ranges; the detail view supports
  tap-a-line-to-seek and highlight-follows-audio replay.

**R4 — Agent-readable transcript**
- R4.1 A single observable transcript store is the one source of truth; the
  UI, the turn engine's evidence feed, persistence, and agents are all
  subscribers of the same stream.
- R4.2 An in-process agent API: any feature (coverage, future companions) can
  subscribe to live transcript deltas (volatile) or finalized segments, with
  no polling.
- R4.3 The remote variant is an explicit, off-by-default user toggle that
  batches **finalized** segments to a configurable consumer with seconds of
  delay. Shipping the toggle's UI may lag; the seam must exist from day one.
  This supersedes the blanket "server never sees the running transcript"
  promise with a deliberate, user-controlled choice — README and privacy copy
  updated accordingly.

---

## Architecture

```
AVAudioEngine tap ──► CaptureController (R1: session, interruptions, routes)
        │                      │
        │ buffers              │ speech-start/end (RMS VAD, unchanged)
        ▼                      ▼
AnalyzerEngine (R2)      TurnDetector (unchanged, pure)
  SpeechAnalyzer               ▲
  + SpeechTranscriber          │ EOU evidence (from store text)
        │ volatile/final       │
        ▼                      │
   TranscriptStore (actor) ────┘
     append-only segment log, AsyncStream subscriptions
        │              │               │
        ▼              ▼               ▼
   SessionView    PersistenceWriter  AgentFeed
   (live UI)      (R3, incremental)  (R4: in-process subscribers,
                                      optional batched remote push)
```

### TranscriptStore (new, in ShutUpAndListenKit — platform-agnostic)

The spine. An actor holding an append-only log of segments:

```swift
struct TranscriptSegment: Codable, Sendable, Identifiable {
    let id: SegmentID            // stable across volatile → final
    let speaker: Speaker         // thinker | listener
    var text: String
    var state: State             // volatile | final
    var audioStart: TimeInterval // seconds from session start
    var audioEnd: TimeInterval
    var turn: Int                // set by the host at turn boundaries
    var tier: Tier?              // listener segments only
}
```

API surface:
- `append/update(_:)` — engine and host write here, nowhere else.
- `updates: AsyncStream<TranscriptEvent>` — `.segmentAdded`, `.segmentRevised`,
  `.segmentFinalized`, `.turnStarted` (multiple independent subscribers).
- `utteranceText(turn:)` — the whole current utterance, assembled from
  segments tagged with that turn. Replaces `currentUtteranceText` character
  math; correct under revision by construction.
- `fullText`, `snapshot()` — for coverage checks and export.

Pure Swift, no audio or UI imports — testable headlessly on macOS/Linux
alongside `TurnEngine`, including scripted volatile-revision fixtures
(partials that shrink, restructure, and finalize) that the old design could
not survive.

### AnalyzerEngine (new, app target)

Owns one `SpeechAnalyzer` with a `SpeechTranscriber` module per session:

- Configured for volatile + finalized results with audio time ranges;
  on-device locale asset ensured via `AssetInventory` before first session
  (onboarding step with download progress).
- Input: an `AsyncStream<AnalyzerInput>` bridged from the engine tap,
  converted to the analyzer's `bestAvailableAudioFormat`.
- Output: translates analyzer results into `TranscriptStore` writes. Volatile
  results update the segment in place (same `SegmentID`, keyed by the
  result's audio range); finalized results mark it `.final`.
- A conformance to a small `TranscriptionEngine` protocol
  (`start(buffers:) / stop() / events`), so WhisperKit can slot in later as
  the alternate arm without touching the store, the host, or the UI.

### CaptureController (rework of AudioPipeline)

- Keeps the RMS VAD and the AEC'd input tap (they are fine; the patience floor
  sits above VAD jitter).
- Adds: `UIBackgroundModes: audio`; `AVAudioSession` interruption observer
  (pause → attempt resume on `.shouldResume`, else surface a truthful paused
  state); route-change observer (rebuild the tap on device change);
  `mediaServicesWereReset` recovery.
- Recording sink unchanged in mechanism (incremental `.m4a` off the tap), but
  the file is *adopted by the record at session start* (R3.1), so it can never
  be orphaned.

### Host (SessionController) changes

- Drops all transcriber string bookkeeping; reads utterance text from the
  store; `markUtteranceStart` becomes `store.startTurn(turn, at: audioTime)`.
- EOU evidence: subscribes to store updates; while `pending`/`deciding`,
  fresh volatile text re-fires `LinguisticEOU` exactly as today (spec §6
  evidence-driven re-evaluation) — now with punctuation present, so the cue
  table works as designed.
- Listener replies are appended to the store as listener segments with the
  spoken clip's time range, giving replay the companion's side in sync too.

### PersistenceWriter (rework of persistSession)

- `SessionRecord` gains `state` (`recording`/`complete`) and a one-to-many
  `SegmentRecord` (`@Model`) mirroring `TranscriptSegment` with time ranges.
  `transcriptJSON` is retired; `entries`/`markdown`/search derive from
  segments. Lightweight SwiftData migration for existing records (their
  stored entries map to segments with zeroed time ranges).
- Subscribes to `.segmentFinalized` and `.turnStarted`; inserts/saves
  incrementally (debounced save, e.g. once per finalized segment).
- Launch-time recovery: any `recording`-state record is closed out as
  `complete` with a "recovered" flag; its audio file is already referenced.

### AgentFeed (new)

- In-process: re-exposes the store's `AsyncStream` as the public subscription
  point (R4.2). Coverage mode becomes its first consumer: reads
  `snapshot().fullText` instead of reaching into the transcriber.
- Remote (seam now, UI later): a `TranscriptForwarder` subscriber that batches
  finalized segments and POSTs them at a configurable cadence (default ~5 s)
  when — and only when — the user enables the toggle. Off by default;
  no forwarding of volatile text; documented in the privacy copy.

---

## Phases

### Phase 0 — Platform baseline
- Raise the deployment target to iOS 26 (project + package platforms).
- Delete `App/Audio/SpeechTranscriber.swift` and every `Speech` legacy import.
- Add `UIBackgroundModes: audio`; verify mic + analyzer keep running locked.
- Exit: app builds and runs on an iOS 26 device with capture surviving screen
  lock (transcription temporarily dark between Phase 0 and 2 if landed
  separately; Phases 0–2 may land as one PR).

### Phase 1 — TranscriptStore
- Implement the store + segment model + streams in `ShutUpAndListenKit`
  (new `TranscriptCore` target; `TurnEngine` stays dependency-free).
- Headless tests: revision fixtures (volatile shrink/restructure/finalize),
  turn tagging, `utteranceText(turn:)` correctness under revision,
  multi-subscriber delivery.
- Exit: `swift test` green on macOS/Linux.

### Phase 2 — AnalyzerEngine
- Implement `TranscriptionEngine` protocol + `SpeechAnalyzer` conformance;
  bridge the tap; wire volatile/final results into the store.
- `AssetInventory` locale ensure in onboarding (progress UI, unsupported-
  locale message).
- Rewire `SessionController` and `SessionView` to the store; delete the
  character-offset anchor and the `refreshThinkerEntry` string patching.
- Exit criteria (operator feel-test, on hardware): words appear while
  speaking and visibly refine; a 10+ minute monologue transcribes with no
  boundary gaps; punctuation present; `LinguisticEOU` observed returning
  sub-0.5 on trailing-conjunction pauses in the live loop.

### Phase 3 — Capture reliability
- Interruption/route/media-reset observers in `CaptureController`; truthful
  paused/resuming UI states; auto-resume where allowed.
- Exit: phone call mid-session pauses and resumes cleanly; AirPods
  connect/disconnect mid-session does not kill the tap; both verified on
  hardware.

### Phase 4 — Incremental persistence + replay
- `SegmentRecord`, record-at-start, incremental writer, launch recovery,
  SwiftData migration.
- Detail view: tap-to-seek from a segment's `audioStart`; highlight the
  segment under the playhead during playback.
- Exit: force-kill mid-session → relaunch shows the session with everything
  up to the last finalized segment plus playable audio; replay highlight
  tracks within a segment's duration.

### Phase 5 — AgentFeed
- Public in-process subscription API; migrate coverage mode onto it.
- `TranscriptForwarder` behind a Settings toggle (default off) posting
  batched finalized segments; README + privacy copy updated to the new,
  explicit contract (R4.3). Server-side endpoint is a separate `server/`
  change and may trail; the client seam ships regardless.
- Exit: a demo in-process subscriber (debug screen) shows live deltas within
  ~1 s of speech; with the toggle on, batches observed at the configured
  cadence containing only finalized text.

### Phase W — WhisperKit arm (deferred, unscheduled)
- Second `TranscriptionEngine` conformance for on-device quality A/B against
  the SpeechAnalyzer arm. Not started until the primary arm's quality is
  measured and found wanting. Named here only so nobody reaches for a legacy
  API instead.

---

## Scope boundaries

- **Not touched:** `TurnEngine` (detector, gate, golden vectors, knobs),
  `ResponseHierarchy`, the listener prompt, `ClaudeClient`/`ProxyClient`,
  the RMS VAD algorithm, TTS/`SpeechOutput`, the web build, the spec.
- **Unchanged product behavior:** the patience-first contract, the response
  hierarchy, coverage mode semantics, developer mode.
- **Deferred:** WhisperKit arm (Phase W); the server endpoint for the remote
  transcript feed; Silero VAD port; smart-turn v3 port (the punctuation fix
  materially improves `LinguisticEOU`, which lowers the urgency).

## Risks

- **Toolchain:** building requires Xcode 26 / the iOS 26 SDK; CI and the
  Linux `swift test` path only cover `TurnEngine` + `TranscriptCore` — the
  analyzer engine is hardware-verified by the operator feel-test, same as
  the existing VAD/TTS adapters. Mitigation: keep the engine thin; all logic
  that can be pure lives in `TranscriptCore`.
- **Locale asset availability:** `SpeechTranscriber` locale models are
  downloaded assets; first-run requires network + storage. Mitigation:
  onboarding ensure-step with progress; session start blocks with a clear
  message until the asset is present.
- **AEC vs. recognition quality:** the voice-processed mic path may cost
  transcription accuracy for quiet/far-field speech. Mitigation: measured
  during the Phase 2 feel-test; if material, trial disabling voice processing
  when no TTS is pending (barge-in only matters while the companion holds
  the floor).
- **SwiftData migration:** existing installs carry `transcriptJSON` records.
  Mitigation: additive schema + derived accessors; migration covered by a
  unit test with a fixture store.
- **iOS 26 floor shrinks the installable base.** Accepted by the operator —
  modern OS only is a product decision, not a risk to mitigate.

## Acceptance (maps to the four premises)

1. **Listen:** a session survives screen lock, a phone call, and an AirPods
   swap, with truthful UI throughout.
2. **Transcribe:** live, visibly-revising, punctuated on-device transcription
   with no restart seams over a 10+ minute session.
3. **Persist/replay:** force-kill loses at most the current volatile segment;
   saved sessions support tap-to-seek and follow-along replay.
4. **Agent:** an in-process subscriber sees transcript deltas in ~1 s; the
   opt-in forwarder ships finalized text in batched seconds-delay pushes;
   the privacy contract states this explicitly.
