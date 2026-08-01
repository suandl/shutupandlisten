---
title: "feat: iOS transcript-core rewrite — SpeechAnalyzer capture spine (iOS 26+, no legacy fallback)"
type: feat
status: active
date: 2026-08-01
deepened: 2026-08-01
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

## Key Decisions

Operator-set (fixed; do not relitigate):

- **iOS 26 minimum deployment target.** Modern OS only. No
  `SFSpeechRecognizer` code remains anywhere in the tree.
- **`SpeechAnalyzer` is the transcription engine.** If a second arm is ever
  wanted (quality A/B), it is WhisperKit — never a legacy Apple API. The
  second arm is explicitly deferred out of this plan (Phase W, unscheduled).
- **Transcription is on-device, always.** The `SpeechTranscriber` locale model
  is downloaded via `AssetInventory` and runs locally. Off-device is
  permitted for *other* features (listener LLM, coverage via the proxy), and
  the agent seam may optionally stream finalized transcript off-device behind
  an explicit user toggle — but recognition itself never leaves the phone.

Technical (set by this plan; each is load-bearing for a review finding):

- **The canonical timeline is recorded-audio position** — seconds of audio
  actually fed/written since session start (the fed-samples clock). The
  detector's wall clock (`systemUptime` ms) and the analyzer's `CMTime`
  audio timeline both convert into it at the capture boundary. After an
  interruption the wall clock keeps running but the audio timeline does not —
  segment times stay file-relative, so replay sync survives gaps by
  construction. The host maintains the fed-samples ↔ wall-clock mapping for
  anything that crosses domains (turn boundaries, listener segments).
- **Segment identity is the engine's job, not the store's.** The
  `TranscriptionEngine` protocol emits events carrying explicit stable
  segment IDs; the store never infers identity from audio ranges. The
  SpeechAnalyzer conformance models the API's real contract: at most one
  open volatile segment at a time, updated in place by successive volatile
  results, closed by finalization (which may split it into sentence-level
  final segments); a new volatile segment opens for subsequent audio.
- **One persistent format converter feeds everything.** A single stateful
  `AVAudioConverter` converts the tap format to a fixed canonical PCM format
  (mono float32 @ 48 kHz); the recording file, the analyzer input, and the
  VAD all consume the canonical stream. A route/configuration change rebuilds
  the converter only — the file format and analyzer format never change
  mid-session.
- **Session audio records to CAF (AAC-in-CAF) during capture**, because
  MPEG-4 finalizes its `moov` atom on close — a crash mid-session leaves an
  unplayable `.m4a`. CAF is append-safe and readable after abrupt
  termination. Graceful stop and launch recovery both remux CAF → `.m4a`;
  playback handles both.
- **Durability policy: save on every finalized segment and every turn start —
  no debounce.** This is what makes R3.1 ("a crash costs at most the current
  volatile segment") literally true. Segment volumes are conversational;
  per-final saves are cheap.
- **Microphone stays built-in; Bluetooth is output-only (A2DP).** Enabling
  the AirPods mic requires HFP, which drops input to narrow-band and would
  visibly cost transcription quality — rejected for v1, recorded here so the
  "AirPods mid-session" acceptance test is understood as an output-route
  event.
- **AEC stays on** (`setVoiceProcessingEnabled(true)`) — barge-in honesty
  outranks the recognition-quality cost. It is applied before `engine.start()`
  with the failure surfaced (not `try?`-swallowed), and re-applied on
  media-services reset. If the Phase 2 feel-test shows material quality loss,
  the recorded fallback position is: disable voice processing while the
  companion does not hold the floor.
- **Speech authorization goes away.** SpeechAnalyzer's on-device recognition
  does not use `SFSpeechRecognizer.requestAuthorization`; the session gates on
  mic permission only. `NSSpeechRecognitionUsageDescription` is removed with
  the legacy gate (verify on device that no API path demands it; restore only
  if the system requires).
- **`TranscriptCore` depends on `TurnEngine`.** `Tier` stays defined once, in
  `TurnEngine` (a pure leaf); "TurnEngine stays dependency-free" means no
  *incoming* dependencies are added to it.

---

## Requirements

**R1 — Reliable listening**
- R1.1 Capture continues with the screen locked and the app backgrounded
  (`UIBackgroundModes: audio`).
- R1.2 Audio interruptions (call, Siri, alarm) and route changes (AirPods
  connect/disconnect) are observed; the engine restarts automatically when
  the session can resume, and the UI truthfully shows a paused/resuming state
  when it cannot. Paused is the default presentation; resume is proven, not
  assumed.
- R1.3 The mic path is deliberate and recorded: AEC on (barge-in honesty),
  built-in mic, A2DP output only — per Key Decisions.

**R2 — Best-in-class on-device transcription**
- R2.1 `SpeechAnalyzer` + `SpeechTranscriber` module with volatile results
  enabled: partial text appears immediately and visibly refines until
  finalized — the Siri-style revising behavior.
- R2.2 No duty-cycle restarts, no dropped-buffer seams: one analyzer session
  spans the whole recording session; graceful stop finalizes and drains
  before the record closes (see AnalyzerEngine stop sequence).
- R2.3 The transcriber is configured to attach audio time ranges
  (`attributeOptions: [.audioTimeRange]`); finalized ranges are trusted for
  seek/replay, volatile ranges treated as approximate.
- R2.4 Utterance boundaries are anchored by **segment identity + canonical
  audio time**, never by character offsets into a mutable string.
- R2.5 Punctuated output feeds `LinguisticEOU`, so its terminal-punctuation
  and trailing-marker cues actually fire.
- R2.6 The locale model is ensured via `AssetInventory` at onboarding
  (download progress surfaced) **and re-verified at every session start**
  (assets can be evicted under storage pressure); session start blocks with a
  clear message until present. Locale reservations are managed
  (release locales no longer needed).

**R3 — Incremental persistence, true replay**
- R3.1 The `SessionRecord` is created at session **start** and marked complete
  at stop; transcript segments are persisted as they finalize (no debounce).
  A crash costs at most the current volatile segment.
- R3.2 On next launch, incomplete records are recovered: transcript-so-far
  kept, CAF audio remuxed and adopted (or the audio reference dropped if the
  file is unreadable — never the transcript), record closed with a
  "recovered" flag. Zero-speech sessions (no finalized thinker segment) are
  deleted together with their audio, at stop and at recovery alike.
- R3.3 Stored segments carry canonical-timeline ranges; the detail view
  supports tap-a-line-to-seek and highlight-follows-audio replay. Records
  without real timings (pre-migration) degrade to today's static view.

**R4 — Agent-readable transcript**
- R4.1 A single observable transcript store is the one source of truth; the
  UI, the turn engine's evidence feed, persistence, and agents are all
  subscribers of the same multicast event log.
- R4.2 An in-process agent API: any feature (coverage, future companions) can
  subscribe to live transcript deltas (volatile) or finalized segments, with
  no polling. A late subscriber gets snapshot-then-deltas; a slow subscriber
  never back-pressures the UI or the evidence feed.
- R4.3 The remote variant is an explicit, off-by-default user toggle that
  batches **finalized** segments to a configurable consumer with seconds of
  delay. Shipping the toggle's UI may lag; the seam must exist from day one.
  This supersedes the blanket "server never sees the running transcript"
  promise with a deliberate, user-controlled choice — README and privacy copy
  updated accordingly.

---

## Architecture

```
AVAudioEngine tap ──► CaptureController (R1: session, interruptions, routes,
        │             config changes, canonical-format converter, CAF sink,
        │             fed-samples clock)
        │ canonical buffers            │ speech-start/end (RMS VAD, unchanged,
        ▼                              ▼  stamped in canonical audio time + wall ms)
AnalyzerEngine (R2)              TurnDetector (unchanged, pure, wall-clock ms)
  SpeechAnalyzer                       ▲
  + SpeechTranscriber                  │ EOU evidence (host-cached utterance text)
        │ engine events                │
        ▼                              │
   TranscriptStore (actor) ────────────┘ (via the host's MainActor cache)
     append-only segment log, multicast per-subscriber streams
        │              │               │
        ▼              ▼               ▼
   SessionView    PersistenceWriter  AgentFeed
   (live UI)      (@ModelActor,      (R4: in-process subscribers,
                   per-final saves)   optional batched remote push)
```

### TranscriptStore (new, `ShutUpAndListenKit/TranscriptCore` — platform-agnostic)

The spine. An actor holding an append-only log of segments:

```swift
public struct TranscriptSegment: Codable, Sendable, Identifiable {
    public let id: SegmentID          // engine-issued, stable volatile → final
    public let speaker: Speaker       // thinker | listener
    public var text: String
    public var state: State           // volatile | final
    public var audioStart: TimeInterval  // canonical timeline (recorded-audio s)
    public var audioEnd: TimeInterval
    public var turn: Int              // derived by the store (see Turn tagging)
    public var tier: Tier?            // listener segments only (TurnEngine.Tier)
    public var bargedIn: Bool         // listener segment cut short by barge-in
    public var index: Int             // monotonic append order
}
```

**Multicast contract.** `AsyncStream` is single-consumer, so the store never
exposes one shared stream. `func updates(replayingSnapshot: Bool = true) ->
AsyncStream<TranscriptEvent>` mints a fresh stream per subscriber; the actor
keeps a registry of continuations, multicasts every event to all live
subscribers, and cleans up in `onTermination`. A late subscriber first
receives the current segments as synthetic `.segmentAdded` events (snapshot),
then live deltas — no holes. Buffering: unbounded for `.segmentFinalized` /
`.turnStarted`; volatile revisions are coalesced latest-wins per segment so a
slow subscriber sees the newest text without unbounded growth and never
back-pressures anyone.

Events: `.segmentAdded`, `.segmentRevised`, `.segmentFinalized`,
`.turnStarted(turn:atAudioTime:)`.

**Turn tagging.** The host calls `startTurn(_ turn: Int, atAudioTime:)` when
the detector emits `turn-start` (boundary stamped in canonical audio time via
the fed-samples clock). The **store** derives each segment's `turn` by
comparing its audio range against the recorded boundary times — the engine
knows nothing about turns:

- A segment is tagged with the turn whose boundary interval contains its
  `audioStart`.
- A revision re-derives the tag (a volatile segment that grows across a
  boundary keeps its start-derived turn until finalization).
- A **finalized** segment straddling a boundary is split at the boundary time
  using its run-level time ranges, so each final segment lies in one turn.
- `utteranceText(turn:)` for the current turn = its finalized segments plus,
  when the open volatile segment straddles the boundary, the portion of its
  text at/after the boundary (best-effort by time-range runs, whole-volatile
  when runs are absent) — defined behavior exactly where the old
  character-offset anchor was undefined.

Other API: `append`/`revise`/`finalize` (engine + host writes only),
`appendListener(text:tier:estimatedRange:)` → `closeListener(id:actualEnd:
bargedIn:)`, `fullText`, `snapshot()`.

Pure Swift, no audio or UI imports — testable headlessly on macOS/Linux
alongside `TurnEngine`.

### TranscriptionEngine protocol + AnalyzerEngine (app target)

```swift
protocol TranscriptionEngine {
    func start(buffers: AsyncStream<AnalyzerBuffer>) async throws
    func stopAndFinalize() async   // drains; returns only when all results landed
    var events: AsyncStream<EngineEvent> { get }  // single consumer: the host bridge
}
enum EngineEvent {
    case volatile(SegmentID, text: String, range: ClosedRange<TimeInterval>)
    case finalized([(SegmentID, text: String, range: ClosedRange<TimeInterval>,
                     runs: [(Range<String.Index>, ClosedRange<TimeInterval>)])])
}
```

The engine owns identity: IDs are stable across volatile revisions, and the
WhisperKit arm must honor the same contract, which keeps the store honest.

The SpeechAnalyzer conformance:

- **Configuration pinned:** `SpeechTranscriber(locale:…)` with
  `reportingOptions: [.volatileResults]`, `attributeOptions:
  [.audioTimeRange]` (start from the transcriber preset that matches, deviate
  consciously). Format from the static
  `SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])`.
  Note: no `contextualStrings` equivalent exists in the iOS 26 API — no
  custom-vocabulary biasing is assumed anywhere in this plan.
- **Volatile identity:** one open volatile segment; successive volatile
  results *replace* it (same `SegmentID`); a finalized result closes it —
  splitting into sentence-level final segments by the finalized text's
  `audioTimeRange` runs — and the next volatile result opens a fresh ID.
  `volatileRangeChangedHandler` tracks the moving volatile/finalized
  boundary.
- **Timing:** result `CMTime`s are on the fed-audio timeline, which *is* the
  canonical timeline (the same converter output is written to the file), so
  no further conversion is needed for segment ranges.
- **Preheat:** `prepareToAnalyze(in:)` is called during session start (after
  asset verification) so first words don't lag — Phase 2's exit measures
  time-to-first-partial on a warmed start.
- **Stop sequence (graceful):** (1) finish the input stream's continuation;
  (2) `analyzer.finalizeAndFinishThroughEndOfInput()`; (3) drain
  `transcriber.results` to completion so trailing finals land in the store;
  (4) only then does the host close the `SessionRecord`. A graceful stop
  therefore loses *nothing* — the crash bound (one volatile segment) is the
  worst case, not the normal case.
- **Assets:** `AssetInventory` ensure at onboarding with progress UI;
  re-verify at every session start (eviction under storage pressure);
  reservation managed, stale locales released; unsupported locale gets a
  clear blocking message.

### CaptureController (rework of AudioPipeline)

- Keeps the RMS VAD algorithm and the AEC'd input tap. VAD events are stamped
  with both wall-clock ms (for the detector, unchanged) and canonical audio
  time (fed-samples), which is how the host stamps turn boundaries for the
  store.
- **Canonical stream:** one persistent `AVAudioConverter` (tap format →
  mono float32 @ 48 kHz) feeds the CAF recording sink, the analyzer input
  stream, and the VAD. Rebuilt only on configuration change; the downstream
  formats never change mid-session.
- **Fed-samples clock:** cumulative samples delivered downstream; exposed as
  `audioNow: TimeInterval` plus a wall-clock mapping (`audioTime(atWallMs:)`)
  used for turn boundaries and listener segments. During an interruption no
  samples flow, so the canonical clock pauses with the file — by
  construction, replay stays in sync across gaps.
- **Observers:** `AVAudioSession.interruptionNotification` (pause; on
  `.ended` + `.shouldResume` attempt resume), `routeChangeNotification`
  (rebuild converter + tap), **`AVAudioEngineConfigurationChange`** (the
  event that actually stops the engine: remove tap, re-query formats, rebuild
  converter, reinstall, restart), `mediaServicesWereResetNotification`
  (rebuild session + engine + voice processing from scratch), and
  `didBecomeActive` (retry resume — `.shouldResume` is not reliably delivered
  while backgrounded; retries also run on a short backoff). Paused state is
  the truthful default until audio actually flows again.
- **Voice processing** is enabled before `engine.start()` with failure
  surfaced to the UI (R1.3), re-applied after media-services reset.
- **Recording sink:** canonical stream → AAC-in-**CAF** during the session;
  remux to `.m4a` at graceful stop and during launch recovery (Key
  Decisions). The file is created and referenced by the `SessionRecord` at
  session start, so it can never be orphaned.

### Host (SessionController) changes

- Drops all transcriber string bookkeeping. The host bridges engine events →
  store writes, and maintains a **MainActor-cached copy of the current
  utterance text**, updated as store events arrive on its subscription task.
  `speech-end` handling and evidence re-fires read the cache synchronously —
  no `await` between a VAD event and its evidence, preserving the strict
  main-actor event ordering the detector relies on. Evidence is stamped at
  delivery (`nowMs`) and dropped unless the machine is in
  `pending`/`deciding`, exactly as today.
- `markUtteranceStart` becomes `store.startTurn(turn, atAudioTime:
  capture.audioTime(atWallMs: t))`.
- Behavior-preserving bridges land with the rewiring (nothing dangles
  between phases): `conversationHistory(before:)`, `askNow`'s current-text
  fallback, and `checkCoverage` all read from `store.snapshot()`;
  `persistSession`'s stop-path work moves to PersistenceWriter.
- Listener replies: appended to the store via `appendListener` with the
  estimated range (start = `audioNow` at speak, end = start + estimate);
  `closeListener` revises `audioEnd` to the actual on `onFinished` or the cut
  point on barge-in, setting `bargedIn` so replay/export never present
  unspoken words as spoken. Replay renders listener segments as timeline
  markers over (AEC-silenced) audio.

### PersistenceWriter (new; rework of persistSession)

- A `@ModelActor` with its own `ModelContext` off the shared
  `ModelContainer` — `ModelContext` is not `Sendable` and the main context
  belongs to the UI. The record is created on the main context at session
  start; the writer receives its `persistentModelID`, never the model object.
- `SessionRecord` gains `state` (`recording`/`complete`/`recovered`) and a
  to-many `SegmentRecord` mirroring `TranscriptSegment` (including `index` —
  SwiftData relationships are unordered; `index` is the order). Title is a
  placeholder at creation, recomputed when the first thinker segment
  finalizes and again at close; duration at close (recovery derives it from
  max(last segment `audioEnd`, audio length)).
- Subscribes to `.segmentFinalized` / `.turnStarted`; saves on every event
  (no debounce — Key Decisions). Volatile revisions are not persisted.
- **Close-out:** runs after the engine's stop sequence drains; zero-speech
  sessions (no finalized thinker segment) delete the record + audio.
- **Launch recovery:** `recording`-state records are closed as `recovered`
  (CAF remuxed; unreadable audio → drop the audio reference, keep the
  transcript; zero-speech → delete). The library's `@Query` filters out
  `recording`-state records so the live session never appears as a row
  mid-capture.
- **Migration:** *not* lightweight-as-in-inferred. A versioned schema
  (`SchemaV1` → `SchemaV2`) with a custom `MigrationStage` — old records keep
  `transcriptJSON` as a legacy optional field; the stage (or a lazy
  first-read materializer) decodes it into `SegmentRecord` rows with
  `index` preserved and zeroed time ranges. `entries`/`markdown`/search/
  `deriveTitle` derive from segments. The segment↔stored-entry mapping logic
  lives in `TranscriptCore` (headless-testable); the SwiftData stage itself
  is exercised in the app test target.

### AgentFeed (new)

- In-process: re-exposes `store.updates()` as the public subscription point
  (R4.2) — each consumer gets its own multicast stream with
  snapshot-then-deltas. Coverage mode becomes its first consumer.
- Remote (seam now, UI later): `TranscriptForwarder`, a subscriber that
  batches **finalized** segments and POSTs them at a configurable cadence
  (default ~5 s) when — and only when — the user enables the toggle. Off by
  default; volatile text never leaves the device; documented in the privacy
  copy. The server-side endpoint is a separate `server/` change and may
  trail; the client seam ships regardless.

---

## Output Structure

```
ios/
  App/
    Audio/
      CaptureController.swift        (replaces AudioPipeline.swift)
      AnalyzerEngine.swift           (SpeechAnalyzer TranscriptionEngine)
      SpeechOutput.swift             (unchanged)
      —                              (SpeechTranscriber.swift DELETED, Phase 2)
    SessionController.swift          (rewired to store + cache)
    Support/
      PersistenceWriter.swift        (@ModelActor incremental writer)
      SessionRecord.swift            (schema V2 + migration plan)
      RecordingStorage.swift         (CAF + remux helpers)
      AssetEnsure.swift              (AssetInventory onboarding/session-start)
    UI/                              (SessionView, SessionDetailView, Onboarding
                                      touched; others unchanged)
  ShutUpAndListenKit/
    Package.swift                    (tools + platform bump)
    Sources/
      TurnEngine/                    (UNCHANGED)
      TranscriptCore/                (NEW: store, segments, events, turn
                                      tagging, entry-mapping helpers)
      ClaudeClient/                  (unchanged)
      sul-demo/                      (kept building; not extended)
    Tests/
      TranscriptCoreTests/           (NEW: revision/tagging/multicast fixtures)
      TurnEngineTests/               (unchanged, stays green)
  ShutUpAndListenAppTests/           (NEW Xcode test target: migration stage,
                                      writer close-out — device/simulator only)
```

---

## Implementation Units

### Phase 0 — Platform baseline (small, independently landable)
**Files:** `project.pbxproj`, `ShutUpAndListenKit/Package.swift`.
- Raise the app deployment target to iOS 26; bump the package
  `swift-tools-version` to the Xcode 26 toolchain and set package platforms
  accordingly. **CI note:** the Linux test path must move to the matching
  Swift toolchain in the same change, or the package tests break silently.
- Add `INFOPLIST_KEY_UIBackgroundModes = audio`.
- No deletions — the legacy transcriber keeps the app runnable until Phase 2
  replaces it.
**Verification:** package tests green on Linux with the new toolchain; on
hardware, mic capture + recording survive screen lock for 5+ minutes.

### Phase 1 — TranscriptCore
**Files:** `Sources/TranscriptCore/*`, `Tests/TranscriptCoreTests/*`.
- Store actor, segment model, multicast `updates()` (snapshot-then-deltas,
  coalescing policy), turn tagging incl. straddle/split rules,
  `utteranceText(turn:)`, listener append/close, entry-mapping helpers for
  persistence and export.
**Test scenarios (headless, macOS/Linux):**
- Volatile replace-in-place: shrink, restructure, finalize; finalize-as-split
  into multiple finals; new volatile after finalization keeps IDs stable.
- Turn tagging: segment fully inside a turn; volatile straddling a boundary
  (tag stays start-derived; `utteranceText` returns the post-boundary
  portion); finalized straddler split at the boundary; revision re-derivation.
- Multicast: two subscribers each receive every event in append order; late
  subscriber gets snapshot then deltas with no hole; a never-consuming
  subscriber does not block the others; volatile coalescing keeps only the
  newest revision per segment.
- Mapping helpers round-trip `StoredEntry` ↔ segments with order preserved.
**Verification:** `swift test` green on Linux; `sul-demo` still builds and
runs (it bypasses the store — README's "exact production path" claim is
updated in Phase 2 to name the store as the app-only layer).

### Phase 2 — AnalyzerEngine + host rewiring (lands as one unit with the deletion)
**Files:** `AnalyzerEngine.swift` (new), `AssetEnsure.swift` (new),
`SessionController.swift`, `SessionView.swift`, `OnboardingView.swift`,
`SpeechTranscriber.swift` (deleted), `ios/README.md`.
- `TranscriptionEngine` protocol + SpeechAnalyzer conformance per the
  architecture section (pinned configuration, volatile identity, preheat,
  stop sequence). Delete the legacy file in the same change — note the name
  collision: the app's own `SpeechTranscriber` class must be gone before any
  file references the framework type of the same name.
- Authorization: remove the speech-recognition gate; mic permission only;
  remove `NSSpeechRecognitionUsageDescription` (restore only if a device run
  demands it).
- Host: engine→store bridge, MainActor utterance cache, evidence stamping
  rules, `startTurn` in audio time, and the behavior-preserving bridges
  (`conversationHistory`, `askNow`, `checkCoverage`, stop-path persistence
  still via the old `persistSession` until Phase 4 — reading
  `store.snapshot()` through the mapping helpers).
- Onboarding: asset-ensure step with download progress; session start
  re-verifies.
**Verification (operator feel-test, hardware):**
- Words appear while speaking and visibly refine; warmed start-to-first-
  partial subjectively immediate.
- A 10+ minute monologue transcribes with no boundary gaps or restart seams.
- Punctuation present; in the live loop a cleanly finished sentence's pause
  scores ≥ 0.85 and a comma/ellipsis-trailing pause scores 0.05 from
  `LinguisticEOU` (the cues the rewrite unlocks — a bare trailing "and"
  scoring 0.1 does NOT count, it passes on the old build too).
- Graceful stop: the last words spoken before tapping stop appear in the
  saved transcript (finalize-and-drain works).
- askNow, coverage, knobs, barge-in, acknowledgments behave as before.

### Phase 3 — Capture reliability
**Files:** `CaptureController.swift` (replaces `AudioPipeline.swift`),
`SessionView.swift` (paused/resuming states).
- Canonical converter + fed-samples clock; CAF sink + remux at stop;
  observer set per architecture (interruption, route, engine config change,
  media-services reset, didBecomeActive + backoff); truthful paused UI.
**Verification (hardware):**
- Phone call mid-session: capture pauses, UI says so, resumes cleanly after.
- AirPods connect/disconnect mid-session: output moves; input stays built-in;
  tap/converter rebuild; recording file remains valid and gap-consistent.
- Post-interruption speech lands at the correct file-relative time (spot-check
  a segment's seek target after a deliberate interruption).
- Screen-locked session continues transcribing (R1.1 end-to-end).

### Phase 4 — Incremental persistence + replay
**Files:** `SessionRecord.swift` (schema V2 + migration), `PersistenceWriter.
swift` (new), `SessionController.swift` (stop path), `LibraryView.swift`
(`recording`-state filter), `SessionDetailView.swift` (seek/highlight),
`ShutUpAndListenAppTests/*` (new target).
- Everything in the PersistenceWriter architecture section: record-at-start,
  per-final saves, close-out, zero-speech deletion, launch recovery, title/
  duration derivation, versioned-schema migration, `hasTimings`-gated replay
  affordances.
**Test scenarios:** mapping + ordering logic in `TranscriptCoreTests`
(headless); migration stage + writer close-out + recovery in the app test
target (simulator); on hardware: force-kill mid-session → relaunch → session
present with all finalized segments and playable (remuxed) audio; zero-speech
force-kill → nothing in the library; migrated old records render in order
with static (non-seek) view.
**Verification:** tap a line → playback seeks to its `audioStart`; highlight
follows the playhead; both disabled for zeroed-timing records.

### Phase 5 — AgentFeed
**Files:** `AgentFeed.swift` (new, app target), `TranscriptForwarder.swift`
(new), `SettingsView.swift` (toggle, default off), `SessionController.swift`
(coverage onto the feed), `README.md` + `ios/README.md` (privacy contract).
- Public in-process subscription API over `store.updates()`; migrate coverage
  mode from direct store reads onto it.
- `TranscriptForwarder` batching finalized segments at ~5 s cadence behind
  the toggle; privacy copy updated per R4.3. (Server endpoint: separate
  `server/` work, out of scope here.)
**Verification:** a debug in-process subscriber shows live deltas within ~1 s
of speech (hardware); with the toggle on, batches observed at the configured
cadence containing only finalized text; with it off (default), zero
transcript egress.

### Phase W — WhisperKit arm (deferred, unscheduled)
- Second `TranscriptionEngine` conformance for on-device quality A/B against
  the SpeechAnalyzer arm — same stable-ID contract. Not started until the
  primary arm's quality is measured and found wanting. Named here only so
  nobody reaches for a legacy API instead.

---

## Scope boundaries

- **Not touched:** `TurnEngine` (detector, gate, golden vectors, knobs),
  `ResponseHierarchy`, the listener prompt, `ClaudeClient`/`ProxyClient`,
  the RMS VAD algorithm, TTS/`SpeechOutput`, the web build, the spec,
  `sul-demo` (kept building, not extended through the store).
- **Unchanged product behavior:** the patience-first contract, the response
  hierarchy, coverage mode semantics, developer mode, askNow.
- **Deferred:** WhisperKit arm (Phase W); the `server/` endpoint for the
  remote transcript feed; Silero VAD port; smart-turn v3 port (the
  punctuation fix materially improves `LinguisticEOU`, lowering the urgency).

## Risks & Dependencies

- **Toolchain:** building the app requires Xcode 26 / the iOS 26 SDK; the
  headless path (Linux/macOS `swift test`) covers `TurnEngine` +
  `TranscriptCore` only — the analyzer engine, capture controller, and
  SwiftData layer are verified on hardware/simulator (see the operator
  checklist). Mitigation: keep the app-side layers thin; all logic that can
  be pure lives in `TranscriptCore`.
- **API-surface drift:** the SpeechAnalyzer conformance is written against
  the iOS 26 SDK as documented; exact symbol names/shapes (preset names,
  `volatileRangeChangedHandler`, finalize methods) must be reconciled against
  the real SDK at first build — treat mismatches as mechanical fixes inside
  `AnalyzerEngine` only; the protocol seam insulates everything else.
- **Locale asset availability:** first-run requires network + storage for
  the model; assets can be evicted later. Mitigation: onboarding ensure +
  session-start re-verify (R2.6).
- **AEC vs. recognition quality:** measured during the Phase 2 feel-test;
  recorded fallback: disable voice processing while the companion does not
  hold the floor.
- **SwiftData migration:** custom stage, covered in the app test target with
  fixture stores; old records additionally guarded by the lazy-materialize
  fallback path.
- **iOS 26 floor shrinks the installable base.** Accepted by the operator —
  modern OS only is a product decision, not a risk to mitigate.

## Acceptance (maps to the four premises)

1. **Listen:** a session survives screen lock, a phone call, and an AirPods
   swap, with truthful UI throughout.
2. **Transcribe:** live, visibly-revising, punctuated on-device transcription
   with no restart seams over a 10+ minute session; graceful stop loses
   nothing.
3. **Persist/replay:** force-kill loses at most the current volatile segment
   and the audio remains playable; saved sessions support tap-to-seek and
   follow-along replay.
4. **Agent:** an in-process subscriber sees transcript deltas in ~1 s; the
   opt-in forwarder ships finalized text in batched seconds-delay pushes;
   default is zero egress; the privacy contract states this explicitly.

### Operator checklist (all manual verification, consolidated)

Phase 0: screen-lock capture survives 5 min.
Phase 2: revising partials; 10-min seamless monologue; punctuation cues
(≥0.85 / 0.05) live; graceful-stop tail preserved; askNow/coverage/knobs/
barge-in regression pass; first-partial latency on warmed start.
Phase 3: call interruption pause/resume; AirPods swap; post-interruption
seek correctness; locked-screen transcription.
Phase 4: force-kill recovery (transcript + playable audio); zero-speech
force-kill leaves no record; migrated records render ordered/static.
Phase 5: debug subscriber ~1 s deltas; forwarder cadence + finalized-only;
toggle-off zero egress.

## Open Questions

None blocking — the previously open points are decided in Key Decisions
(canonical timeline; engine-owned segment identity; CAF-then-remux; no-
debounce saves; built-in mic / A2DP-only; AEC stays on; speech authorization
removed; TranscriptCore depends on TurnEngine). If a device run contradicts
the authorization or API-surface assumptions, resolve inside `AnalyzerEngine`
per the API-surface-drift risk.

## Sources

- Review findings on branch `claude/ios-voice-transcription-review-9ss6cj`
  (this plan's Problem Frame).
- `spec/turn-state-machine.md` — the detector contract the host must keep
  honoring (evidence-driven re-evaluation §6, evaluate/decision §4a,
  utterance identity §4b).
- `web/src/transcript.ts`, `web/src/knobs.ts` — the web build's transcript
  alignment and shared knob defaults.
- Apple: Speech framework (iOS 26) — `SpeechAnalyzer`, `SpeechTranscriber`,
  `AssetInventory`; AVFAudio — voice processing, session notifications,
  `AVAudioEngineConfigurationChange`; SwiftData — `VersionedSchema`,
  `SchemaMigrationPlan`, `@ModelActor`.
