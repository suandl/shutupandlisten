---
title: "port: SpeechAnalyzer transcript-core rewrite onto post-PR#37 main"
type: port
status: active
date: 2026-08-02
origin: su-xkmq.1 (epic su-xkmq); rewrite plan docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md
bead: su-xkmq.1
executes_as: su-xkmq.2
---

# port: SpeechAnalyzer transcript-core rewrite onto post-PR#37 main

## Summary

Reconciliation plan for landing the `claude/ios-voice-transcription-review-9ss6cj`
transcript-core rewrite (`27c20ed`) on top of post-PR#37 main (`ad11247`). It fixes
the dispositions once, in writing, so the execution bead (su-xkmq.2) edits
`SessionController` exactly once instead of four times.

Every claim below was checked against the two real trees in a worktree. Where the
filing premises were wrong or incomplete, that is called out explicitly rather
than quietly corrected — three of those corrections change what the execution
bead must do, and two of them are blockers that need an operator decision before
any code is written.

**The geometry is better than the epic feared, and the risk is somewhere else than
the epic looked.** Both branches diverge from exactly one commit, so this is a
true three-way merge, and git will flag the head-on collisions. The danger is the
*silent* set: three obsolete files that PR#37 added and the rewrite has never
seen, which merge cleanly and survive into the port as live, compiling,
wrong code — plus one migration path that drops user data with no error.

---

## 0. Bases, and what was verified

| | commit | |
|---|---|---|
| merge base | `a3437ce` | PR#39's squash — the **only** divergence point |
| post-PR#37 main | `ad11247` | 68 files under `ios/`, +9151/−679 |
| rewrite head | `27c20ed` | 35 files, +6460/−566 |

Both sides branch from `a3437ce`, so `git merge-base ad11247 27c20ed` = `a3437ce`
and a real three-way merge is available. The epic's "one giant squash-commit
behind, diff the trees" caution stands for *reading* PR#37's history, but the
merge itself is not degraded by the squash.

**No Swift toolchain exists in the Linux worktree** (`swift` is absent), so nothing
here is compile-verified. Every claim is source- and diff-derived. That is also why
§6 schedules the operator's Mac gate as a named step rather than a closing hope.

### Corrections to the filing premises

1. **"The rewrite deletes files PR#37 heavily modifies" — true for two files, not
   for the overlap set.** Only `AudioPipeline.swift` and `SpeechTranscriber.swift`
   are modify/delete collisions. `FileTranscriber.swift`,
   `TranscriptReconciler.swift` and `TranscriptStitcher.swift` did **not exist at
   the merge base** — PR#37 *added* them. The rewrite has never seen them, so it
   does not delete them and **git will report no conflict**. They merge in clean
   and keep compiling. Deleting them is a deliberate, unprompted act the execution
   bead must perform; nothing in the merge will remind it. This is the single most
   likely way the port ships wrong.

2. **The UI overlap is missing from the filing.** Five view files are modified by
   *both* sides — `LibraryView`, `OnboardingView`, `SessionDetailView`,
   `SessionView`, `SettingsView`. Each needs a hand-merge (§1).

3. **Two blockers the filing does not mention** — see §0.1 and §0.2. Both need an
   operator ruling before code is written.

### 0.1 BLOCKER — iOS 26 vs. CI's Xcode 16

The rewrite bumps the app target's `IPHONEOS_DEPLOYMENT_TARGET` from `17.0` to
`26.0` (both Debug and Release configs). PR#37's `1187aa5` deliberately moved the
UITest target the *other* way, `26.5` → `17.0`, with the reason in its subject:
"matching the app and CI's Xcode 16".

`.github/workflows/ios-visual.yml` runs `runs-on: macos-14` and
`sudo xcode-select -s /Applications/Xcode_16.app`. Xcode 16 has no iOS 26 SDK and
no `SpeechAnalyzer`. **After this port that workflow cannot build the app at all.**

Two of the epic's must-not-regress items — `capture-demo.sh` failing on UITest
failure (`6f24d22`) and the iOS-17 UITest target (`1187aa5`) — are therefore not
"preserve the code" items. The code survives untouched; the *runner* cannot
execute it. Preserving them requires a macOS runner with Xcode 26.

> **Operator decision required.** Either (a) upgrade the workflow to a
> macOS runner with Xcode 26 and re-pin the UITest target to 26.0, or (b) accept
> that the iOS visual capture workflow is dormant until the runner moves, and say
> so in the PR body. This is not a coding choice, and picking it late invalidates
> the UITest half of the verification plan. The workflow is `workflow_dispatch`-only
> today, which makes (b) survivable — but it must be a decision, not a discovery.

### 0.2 BLOCKER-ish — the app-test target was never wired into Xcode

`ios/ShutUpAndListenAppTests/README.md` (on the rewrite branch) states it plainly:
the target is **"not yet wired into the project"**. So `MigrationTests` (+150) and
`WriterTests` (+274) — 424 lines covering the SwiftData migration and the
persistence writer — **have never run**. The rewrite's `project.pbxproj` delta adds
only the `TranscriptCore` package product, the deployment-target bump, and
`UIBackgroundModes`; it adds no test target.

The migration is the one part of this port that can destroy user data (§5). Landing
it with zero executable coverage is not acceptable. Wiring the target is a Mac/Xcode
GUI step, so it belongs to the operator gate (§6, Gate B).

---

## 1. File-by-file disposition

Legend for provenance: **B** = exists at merge base `a3437ce`, **M** = present in
`ad11247`, **R** = present in `27c20ed`.

### 1a. The head-on collisions (git will conflict — good)

| File | B/M/R | Disposition |
|---|---|---|
| `App/Audio/AudioPipeline.swift` | B M · deleted in R | **Delete** — but first harvest three things it owns that CaptureController lacks: the TTS player node + `ttsFormat`/`playTTS`/`stopTTS` (§3), `start(injecting:)` + `injectForCapture(_:)` (§2), and confirm the RMS VAD constants match (they do: `onsetMarginDb 10`, `absoluteFloorDb −52`, `minSpeechBuffers 3`, `hangoverMs 380` are identical in CaptureController). |
| `App/Audio/SpeechTranscriber.swift` | B M · deleted in R | **Delete.** One live call site outside SessionController: `OnboardingView.swift:135` `SpeechTranscriber.requestAuthorization()` → re-point at the analyzer's authorization path. |
| `App/SessionController.swift` | B M R | **Re-derive, do not merge.** Take the rewrite's 1101-line version as the skeleton and re-apply PR#37's surfaces onto it (§1d). A textual three-way merge here produces garbage — both sides rewrote it (+820 / +798). |
| `App/Support/SessionRecord.swift` | B M R | **Merge deliberately** — one schema, see §5. |
| `App/Audio/SpeechOutput.swift` | B M R | **Take main's wholesale; drop the rewrite's +10.** See §1c — this one looks like a merge and is not. |

### 1b. The silent set (git will NOT conflict — the dangerous ones)

PR#37 added these; the rewrite never saw them; they merge clean and keep compiling.

| File | Disposition |
|---|---|
| `App/Audio/FileTranscriber.swift` (+97) | **Delete.** Its whole job is the second offline STT pass over the `.m4a`. With SpeechAnalyzer the live transcript is authoritative — there is nothing to repair from. |
| `Kit/Sources/TurnEngine/TranscriptReconciler.swift` (+143) | **Delete**, with `Tests/TurnEngineTests/TranscriptReconcilerTests.swift` (+110). |
| `Kit/Sources/TurnEngine/TranscriptStitcher.swift` (+101) | **Delete**, with `Tests/TurnEngineTests/TranscriptStitcherTests.swift` (+144). No duty cycle ⇒ no ~50 s task-rotation seam ⇒ nothing to stitch. |
| `App/Support/SessionRecovery.swift` (+111) | **Keep, narrowed.** Its `adoptOrphanedRecordings` covers "audio file on disk with no owning record" — a failure the rewrite's record-at-start design makes impossible *going forward*, but which real devices can already be in from pre-port builds. Strip its `FileTranscriber.transcribe` call (line 96) and its `transcriptIsReconciled` use; keep the orphan sweep. It is complementary to, not overlapping with, PersistenceWriter's `recording`-state recovery — different failure, different input. |
| `App/Audio/CaptureAudioInjector.swift` (+125) | **Keep**, re-homed onto CaptureController (§2). |
| `App/Support/CaptureSeam.swift`, `CaptureURLProtocol.swift` | **Keep unchanged** — see §2. |

Blast radius of the deletions, verified by grep across `ad11247` (every remaining
reference the execution bead must resolve):

```
App/Audio/CaptureAudioInjector.swift:4   comment → AudioPipeline.injectForCapture
App/Audio/SpeechOutput.swift:26          comment → AudioPipeline
App/SessionController.swift              many (re-derived anyway)
App/Support/SessionRecord.swift:149      TranscriptReconciler.reconcile(...)   ← real call
App/Support/SessionRecovery.swift:96     FileTranscriber.transcribe(...)       ← real call
App/UI/OnboardingView.swift:135          SpeechTranscriber.requestAuthorization() ← real call
ios/README.md:53                         doc
Kit/Sources/ClaudeClient/CaptureSupport.swift:37  comment
ios/scripts/make-fixture-audio.sh:7      comment (VAD hangover rationale — still true)
```

### 1c. `SpeechOutput` — a policy conflict disguised as a merge

Both sides changed it, so it looks mergeable. It is not, and taking both halves
would be wrong.

- **Main (+216)** stopped using `AVSpeechSynthesizer`'s own output entirely. It
  synthesizes to PCM via `synthesizer.write(...)` and renders through the mic's
  voice-processing engine (`TTSPlaybackSink`) so the AEC cancels the app's own
  voice. It has **no `didFinish`/`didCancel` delegate methods at all** — completion
  is derived from the player node's buffer callbacks plus the zero-length end
  marker (`reportFinishedIfDone`).
- **The rewrite (+10)** adds `speechSynthesizer(_:didCancel:)` → `onFinished()`,
  so a cut clip still closes the host's floor bookkeeping.

These are opposite policies on the same event. Main's `stop()` deliberately
*suppresses* completion for a cut clip ("its tail never reports finished"); the
rewrite deliberately *forces* it. Main is self-consistent: `SessionController`'s
`case .bargeIn` (ad11247:813–817) calls `speech.stop()` **and** closes the floor
itself — `lastFloorReleaseMs = t; closeListenerEntry(at: t)`. The bookkeeping the
rewrite was protecting is already done by the barge-in handler.

**Disposition: keep main's file verbatim; drop the rewrite's `didCancel` addition.**
It fixes a bug in code PR#37 deleted. Adding it to main's architecture would feed a
spurious `.tick` after every barge-in. Carry the *reasoning* forward as a test:
assert `onFinished` fires exactly once per clip and never after `stop()`.

### 1d. Take-wholesale (rewrite-only, no main-side counterpart)

`TranscriptCore` module in full — `TranscriptStore` (+433), `TranscriptSegment`
(+165), `StoredEntry` (+87, **but see §5.3**), `ForwarderBatcher` (+73) and its
~1400 lines of tests; `AnalyzerEngine` (+417), `CaptureController` (+693),
`PersistenceWriter` (+274), `TranscriptForwarder` (+137), `AgentFeed` (+67),
`AssetEnsure` (+122); `ShutUpAndListenAppTests/` (+424, and wire the target).

`Kit/Package.swift`: **main never touched it** — take the rewrite's version whole.
It moves tools 5.9 → 6.1, sets `platforms: [.iOS("26.0"), .macOS("14.0")]` (macOS
floor kept low on purpose so headless `swift test` still works), and pins every
pre-rewrite target to `.swiftLanguageMode(.v5)`. That pin is what keeps PR#37's
large TurnEngine/ClaudeClient additions compiling unchanged — verified that `Tier`
is `public enum Tier: String, Codable, CaseIterable, Sendable` identically on both
sides, so `TranscriptSegment`'s `Sendable` conformance holds across the module
boundary.

### 1e. The five both-sides UI files

Strategy for all five: **main's redesign is the base; re-apply the rewrite's
addition on top.** The rewrite's UI deltas are small and feature-scoped.

| File | main | rewrite adds | Note |
|---|---|---|---|
| `LibraryView` | +89 | +25 | `@Query` predicate `state != "recording"` (mandatory under record-at-start, or the live session appears as a row mid-capture) + "Recovered" badge + `.caf`/`.m4a` stem-paired deletion. |
| `OnboardingView` | +133 | +125 | Adds a 4th page: on-device model download with progress (`AssetEnsure`). **Highest-risk UI merge** — both sides restructure the page flow. Also carries the `SpeechTranscriber.requestAuthorization()` fix from §1a. |
| `SessionDetailView` | +309 | +71 | True replay: tap-to-seek + playhead highlight gated on `record.hasTimings`. Main's seek reads `entry.startMs` off `StoredEntry`; the port switches the data source to `record.transcriptSegments` / `audioStart`. Keep main's visual design and its `costUSD` readout (line 29). |
| `SessionView` | +730 | +30 | Adds the paused/resuming capture banner (truthful capture state). Pure addition to main's redesigned live screen. |
| `SettingsView` | +307 | +111 | Adds the opt-in transcript-feed section (off by default) + a DEBUG live-feed view. Pure addition. |

`TranscriptEntry`'s `id` changes `UUID` → `SegmentID` (stable across volatile
revisions). Both are `Hashable`/`Identifiable`, so `ForEach` sites in `SessionView`
need no change — this is a type swap, not a UI rework.

---

## 2. What of PR#37 must be preserved, and how it survives

Verified against the real diffs, not the epic's list.

| Item | Where it lives | Survives how |
|---|---|---|
| **Release-exclusion of the capture seam** (`765c21b`) — SECURITY | `CaptureSeam.swift`, `CaptureURLProtocol.swift`, `CaptureAudioInjector.swift` (whole files `#if DEBUG`); `EXCLUDED_SOURCE_FILE_NAMES` on the app target's **Release** config; every call site in `SessionController` + `ShutUpAndListenApp` guarded | **Two mechanisms, two different risks.** The `#if DEBUG` file guards survive untouched (the rewrite does not touch those files). The `EXCLUDED_SOURCE_FILE_NAMES` block lives in `project.pbxproj` — **which the rewrite also edits, in the same config blocks** (deployment target, `UIBackgroundModes`). A sloppy pbxproj merge silently re-arms the seam in Release. The call-site guards in `SessionController` are **deleted by the re-derivation** and must be re-added by hand. |
| **Keychain overwrite stays gone** (`765c21b`) | `CaptureSeam.installIfNeeded()` — no `KeychainStore.apiKey` write | Survives untouched. Assert by grep that no `KeychainStore.apiKey =` appears under the capture seam. |
| **Seed-flag consistency** (`fd8d4b5`) | `Kit/Sources/ClaudeClient/CaptureSupport.swift` + its tests | **Safe by construction** — entirely in `ClaudeClient`, which the rewrite does not touch. |
| **TTS through the AEC engine** | `SpeechOutput.swift` (`TTSPlaybackSink`) + the player node in `AudioPipeline` | File survives (§1c); **the sink does not** — `AudioPipeline` is deleted and `CaptureController` has no TTS. Must be re-homed (§3). Without this the mic hears the app's own voice. |
| **TTS buffers scheduled from `write`'s async callback** (`6708a05`) | `SpeechOutput.swift`, +117/−24 | Survives with the file, provided §1c is honored. |
| **Analyst late-reply fencing** (`31dba3c`) | `SessionController.swift` **only** (+122/−19) | **Entirely in the re-derived file** — must be hand-carried. See §4.3; the rewrite actively regressed this without knowing. |
| **Analyst pool logic in TurnEngine** | `CandidatePool`, `AnalystCadence`, `AnalystPrompt` + tests | Pure, transport-agnostic, untouched by the rewrite. Survives — but its *anchoring contract* breaks silently (§4.2). |
| **UI redesign, session modes, coverage presets, patience ring** | `UI/*`, `TurnEngine/SessionMode.swift`, `CoveragePresets.swift` | Survive; UI needs the five hand-merges of §1e. |
| **Capture-injection test harness** | `CaptureAudioInjector.swift`, `capture-fixture.json`, `demo-conversation.wav`, `CaptureUITests.swift`, `capture-demo.sh` | Code survives; **the wiring does not** — it feeds `AudioPipeline.injectForCapture`. Re-home onto `CaptureController` (below). Execution blocked by §0.1. |
| **`capture-demo.sh` fails on UITest failure** (`6f24d22`) | `ios/scripts/capture-demo.sh` | File survives untouched. **Runner blocked by §0.1.** |
| **iOS-17 UITest target** (`1187aa5`) | `project.pbxproj` | **Directly contradicted by the port** (§0.1). |
| **Session cost** | `SessionRecord.costUSD`, `SessionCost.swift`, `SessionDetailView:29` | **At risk** — the rewrite's V2 schema has no `costUSD` (§5.2). |

### Re-homing the capture-injection seam

`AudioPipeline` exposes `start(clockOrigin:injecting:)` and
`injectForCapture(_ buffer:)`; when injecting it installs no live tap (the
simulator mic is silent) and pushes fixture buffers through the same downstream
path. `CaptureController` has neither.

Add to `CaptureController`, `#if DEBUG` only:
- an `injecting: Bool` parameter on `start(...)` that skips the input-node tap,
- `injectForCapture(_ buffer: AVAudioPCMBuffer)` that feeds the buffer into the
  **canonical converter** — so injected audio reaches the recording sink, the
  analyzer input stream, the VAD, *and* advances the fed-samples clock exactly as
  live audio does.

That last point is what makes injection honest under the rewrite: because the
canonical timeline is fed-samples, injected fixture audio produces real
`audioStart`/`audioEnd` ranges, and the UITest exercises the replay path too. Under
the old wall-clock stamping it could not.

---

## 3. Re-homing interruption handling and the TTS sink

### 3.1 The new ownership boundary

> **`CaptureController` owns the audio graph. `SessionController` owns the session
> semantics. The interruption *event* belongs to the controller; the session's
> *response* to it does not.**

`CaptureController` already owns, internally and better than `AudioPipeline` did:
`interruptionNotification`, `routeChangeNotification`,
`AVAudioEngineConfigurationChange`, `mediaServicesWereResetNotification`,
`didBecomeActive` retry + backoff, converter/tap rebuild, and voice-processing
re-application. It surfaces the result as `onState: (State) -> Void` and pauses the
canonical clock with the file, so replay stays in sync across gaps by construction.

Main's `handleInterruption(_:)` (`AudioPipeline.Interruption`) is deleted with the
pipeline. But it did **four** things, and CaptureController replaces only two:

| Main's `.began` does | Post-port |
|---|---|
| `pipeline.suspend()` | ✅ CaptureController, internal |
| `persistSession(final: false)` | ✅ obsolete — PersistenceWriter saves per finalized segment |
| `speech.stop()` | ❌ **gap** |
| `parkTurnMachine()` | ❌ **gap** |

### 3.2 The gap, precisely

The rewrite's `onState` handler is two lines — it sets the published
`captureState` for the UI banner and nothing else. `parkTurnMachine()` **does not
exist anywhere in the rewrite's SessionController**; its park sequence
(`detector?.input(.decision(t:outcome:.silence))` + `detector?.dropTurn()`) appears
only inside `stopSession`.

So on the port, an interruption would leave the turn machine holding an open turn
in `pending`/`deciding` across a mic gap of arbitrary length, then resume against
it — and leave a TTS clip mid-flight with the engine stopped underneath it.

**Fix:** restore `parkTurnMachine()` and drive it (plus `speech.stop()`) from the
`onState` transition into `.paused`:

```
capture.onState = { state in
    self.captureState = state                 // existing: UI banner
    if state == .paused, self.isRunning {     // new: session response
        self.speech.stop()
        self.parkTurnMachine()
    }
}
```

Main's `.ended(shouldResume: false)` → `stopSession()` and `.routeLost` → resume
paths are now CaptureController's business (it retries with backoff and reports
`.paused` truthfully rather than pretending to listen), so they do not need
re-homing. The one behavior deliberately *dropped* is main's "finish honestly
rather than pretend to listen to a dead mic" auto-stop — the rewrite's truthful
paused banner supersedes it. Note that in the PR body as an intentional change.

### 3.3 The TTS sink

`SpeechOutput` needs a `TTSPlaybackSink`: `var ttsFormat: AVAudioFormat?`,
`playTTS(_:onComplete:)`, `stopTTS()`. `AudioPipeline` implemented it with an
`AVAudioPlayerNode` attached to the same voice-processing engine that taps the mic
— that shared engine *is* the AEC.

Port those members onto `CaptureController` and conform it to `TTSPlaybackSink`.
Requirements that must not be lost in the move:

- The player node attaches to the **same `AVAudioEngine`** CaptureController runs,
  or AEC does not apply and the mic re-hears the companion.
- `ttsFormat` is `nil` until the engine runs — `SpeechOutput.speak` already
  guards on it.
- The engine rebuild paths (configuration change, media-services reset) must
  re-attach the player node, or TTS goes permanently silent after the first
  route change. `AudioPipeline` had a simpler lifecycle here; CaptureController's
  rebuild is richer, so this is new code, not a copy.
- TTS playback must **not** feed the canonical stream — the recording sink and
  analyzer see the mic tap, and the AEC removes the companion's voice from it.
  Keep the player node downstream of the tap point.

---

## 4. Analyst rewiring onto AgentFeed

### 4.1 What it does today

`ConversationAnalyst` is PR#37-only (it does not exist at the merge base, so the
rewrite has no opinion on it). Two host touchpoints:

- **Content + cadence:** `onTick()` calls
  `analyst.tick(nowMs: now, transcript: transcriber.fullText)` on the 0.1 s timer.
  `tick` expires stale candidates and, if `AnalystCadence.shouldRecompute` allows
  (~25 s min interval, and something pending), starts a cycle.
- **Trigger:** `noteAnalyzablePause(turn:evaluation:text:config:at:)` calls
  `analyst.noteFinishedTurn(atMs:)`, deduped by
  `analyzedPauses.insert(PauseKey(turn:evaluation:))`.

### 4.2 The design on AgentFeed — and the anchoring bug it must not inherit

The seam is a clean fit for content: the rewrite's `SessionController` already
maintains `cachedFullText` from its store subscription (line 602), so
`analyst.tick` has a drop-in source with no new plumbing. `AgentFeed.subscribe()`
is the discoverable version for a consumer that should not reach into the host.

**But there is a real defect waiting here.** `CandidatePool` anchors freshness to a
character offset: `Candidate.anchorPosition = transcript.count` at formation, and
`expire(currentPosition:)` drops candidates where
`currentPosition - anchorPosition > maxDrift` (600). That requires `currentPosition`
to be **monotonically non-decreasing**.

`store.fullText` filters on speaker only, not on `state` — it includes **volatile**
segments. SpeechAnalyzer revises volatile segments in place, and a revision can be
*shorter*. So `cachedFullText.count` can decrease, drift can go negative, and
candidates stop expiring exactly when the transcript is churning.

This is not a hypothetical: `TranscriptSegment.swift`'s own header names it as one
of the two load-bearing reasons the rewrite exists — "the old build anchored
utterances by character offset into a mutable string, which could point past the end
or into different words exactly when the gate evaluated." PR#37 introduced a *second*
character-offset anchor, in the analyst, months after that critique was written and
in ignorance of it.

**Recommendation — anchor on finalized text.** Add
`TranscriptStore.finalizedText` (and/or `finalizedTextLength`) filtering
`state == .final`, and feed *that* to `analyst.tick` for both the analyzed content
and the expiry position. Then:

- `CandidatePool` is **unchanged** — same `Int` character drift, same `maxDrift`,
  same tests still valid.
- Monotonicity holds by construction (finalization is one-way).
- Volatile words never reach the model, consistent with the forwarder's
  finalized-only privacy rule.
- Cost: the analyst sees up to one in-flight segment less. At a ~25 s cadence this
  is noise.

The alternative — re-anchoring on `audioNow` seconds with a time-based `maxDrift` —
is more faithful to the rewrite's canonical timeline but changes `CandidatePool`'s
public shape and invalidates `CandidatePoolTests`. Recommended only if the operator
wants drift measured in conversation time rather than words.

### 4.3 Generation-token fencing — keep it, and extend it

The epic asks whether push-based delivery makes `31dba3c`'s generation token
redundant. **It does not, and the rewrite is currently a regression here.**

The fence guards **model reply** delivery — a network round-trip that can outlive
its session — not transcript delivery. `isCurrent(generation)` is
`isRunning && generation == sessionGeneration`. The rewrite's equivalent guards are
`guard let self, self.isRunning else { return }` (line 838) and
`guard let self, self.isRunning, !reply.isEmpty else { return }` (line 901) —
**`isRunning` alone**, which is precisely the insufficient check `31dba3c` replaced:
stop a session and start another inside one in-flight request, and `isRunning` is
`true` again while the reply belongs to the previous session.

`ConversationAnalyst` holds its own independent `generation`, bumped in `reset()`,
for the same reason. That stays as-is.

**Action:** carry `sessionGeneration` + `isCurrent(_:)` into the re-derived
`SessionController` and apply it to **every** model-reply completion — both PR#37's
paths and the rewrite's two `isRunning`-only sites. Prove it with a test that
stop-then-starts across an in-flight reply. Do not assume the seam fixed it.

### 4.4 `PauseKey` / `analyzedPauses` — unaffected

Honest answer to the epic's question: **the feed change does not touch them.** The
trigger is keyed on `(turn, evaluation)` — both produced by the turn machine's gate
evaluation, not by the transcript. `noteAnalyzablePause` is called from `evaluate`,
reads `wordCount(text)` against the same derived `GateConfig` the gate uses, and
dedupes one pause across evidence-driven re-evaluations. All of that survives the
port verbatim.

### 4.5 One thing that must stay tick-driven

Do **not** make the analyst purely push-driven. `AnalystCadence.shouldRecompute` is
time-based, and the case `31dba3c` exists to serve is warming the pool *during a
substantive pause* — i.e. exactly when no new transcript events are arriving. A
purely event-driven analyst would starve precisely there.

The rewrite keeps a `tickTimer` for the detector. Design: **content and expiry come
from the feed; the "may I run now?" check stays on the clock.**

---

## 5. `SessionRecord` — one migration covering both sides

### 5.1 The three shapes

| Shape | Fields beyond the base | Where it exists |
|---|---|---|
| **Base** (`a3437ce`) | — | Devices running any pre-PR#37 build |
| **PR#37** (`ad11247`) | `costUSD: Double?`, `transcriptIsReconciled: Bool = false`; `StoredEntry` gains `startMs: Int?`, `endMs: Int?` inside the blob | Devices running any build from current main |
| **Rewrite V2** (`27c20ed`) | `state: String`, `transcriptJSON: Data?` (now optional/legacy), `segments: [SegmentRecord]` cascade relationship | The port's target |

The rewrite declares `SessionSchemaV1` as a snapshot of the **base** shape — it has
neither `costUSD` nor `transcriptIsReconciled`, because it never saw them. **Its V1
no longer describes what ships.** Landing it as-is points SwiftData's migration
source at a shape that does not match the store on any device that ran a
current-main build.

### 5.2 The design

**Define V1 as the PR#37 shape, not the base shape.** Both PR#37 additions are
lightweight-inferrable from the true base (`costUSD` is optional;
`transcriptIsReconciled` is defaulted), so a V1 declared at the PR#37 shape opens a
pre-PR#37 store *and* a PR#37 store. **One V1 covers both shipped shapes**, and the
recommendation holds whether or not a PR#37 build ever reached a real device — which
is why it does not need to wait on that answer.

Then one custom stage, V1 → V2:

- **Carry `costUSD` into V2.** The rewrite's V2 omits it. It is written by
  `SessionController` at persist and read by `SessionDetailView:29` behind
  `showCostReadout` — dropping it silently voids the cost readout for every past
  session. This is a straight addition to the V2 model.
- **Drop `transcriptIsReconciled` at V2.** Reconciliation is deleted (§1b); the
  flag has no meaning. Dropping a property is a destructive change, which is
  exactly why the stage must be `.custom` rather than inferred.
- Add `state` (default `complete` for every migrated record — all are finished
  sessions), make `transcriptJSON` optional and retain it as the legacy fallback,
  and materialize ordered `SegmentRecord` rows from the blob with `index` = array
  order.

### 5.3 The silent data-loss path — fix before writing the stage

`TranscriptCore.StoredEntry` declares exactly four fields: `speaker`, `text`,
`tier`, `turn`. **It has no `startMs`/`endMs`.** PR#37's app-level `StoredEntry`
has both, and writes them into `transcriptJSON`.

`JSONDecoder` ignores unknown keys. So the migration would decode a PR#37-era blob
through `TranscriptCore.StoredEntry`, drop the timings without error, emit segments
with zeroed ranges, leave `hasTimings == false`, and permanently deny replay/seek to
every session recorded on current main. No exception, no log line.

**Fix, in `TranscriptCore`:**

1. Add `startMs: Int?` / `endMs: Int?` to `StoredEntry` (optional — base-era blobs
   legitimately lack them).
2. Have `segments(from:)` populate `audioStart`/`audioEnd` from them, `÷ 1000`,
   when present; zero when absent.
3. Have `StoredEntry.init(_ segment:)` write them back, so the export DTO
   round-trips instead of silently flattening new records too.

Then PR#37-era records migrate **with working replay** rather than degraded, and
`hasTimings` becomes true for them.

**Documented approximation:** main's `startMs`/`endMs` are wall-clock ms from
`clockOrigin`; the rewrite's `audioStart`/`audioEnd` are canonical *fed-samples*
audio seconds. They agree except across interruptions, where the wall clock keeps
running and the audio clock does not. For a legacy record that is the best
information that exists, and it is strictly better than zero. Say so in the
migration's doc comment. (The conservative alternative — keep zeroed ranges for
migrated records — loses working replay on every existing session to avoid drift on
the subset that was interrupted. Not recommended.)

### 5.4 What happens to records written by shipped builds

| Store | Outcome |
|---|---|
| Pre-PR#37 | Inferred into V1, then staged to V2. Segments from the blob, zeroed ranges (no timings were ever recorded), `hasTimings == false` → static detail view, exactly as today. Nothing lost. |
| PR#37-era | Matches V1 directly, staged to V2. Segments carry real ranges via §5.3, `costUSD` preserved, `transcriptIsReconciled` dropped. **Gains** working replay. |
| Orphaned `.m4a`, no record | `SessionRecovery.adoptOrphanedRecordings` (§1b) — the reason to keep it. |
| Written by the port | V2 natively; record-at-start, `transcriptJSON == nil`, segments are the truth. |

### 5.5 How `MigrationTests` must change

It currently seeds a store through `Schema(versionedSchema: SessionSchemaV1.self)`,
reopens it with `migrationPlan: SessionMigrationPlan.self`, and asserts ordered rows
/ derived views / the lazy materializer. The shape is right; the fixtures are wrong.

1. **Re-point the V1 fixture at the PR#37 shape** (§5.2) — currently it seeds the
   base shape, which after this port is only one of two real inputs.
2. **Add a `costUSD` preservation test** — non-nil through the stage.
3. **Add a timing-materialization test** — a V1 blob carrying `startMs`/`endMs`
   must produce non-zero `audioStart`/`audioEnd` and `hasTimings == true`. This is
   the regression test for §5.3 and the single most valuable test in the file.
4. **Add a base-shape (pre-PR#37) fixture** so both inbound stores are covered.
5. Keep the existing three tests as-is.
6. **Wire the target** (§0.2) — none of this runs otherwise.

---

## 6. Sequenced work breakdown for su-xkmq.2

All four epic workstreams touch `SessionController`, so stages 3–7 are **one
coherent pass on one branch**, not parallel work. Branch fresh from `ad11247`;
never force-push `claude/ios-voice-transcription-review-9ss6cj` — it is the only
copy of the rewrite until the port is proven.

**Stage 0 — Operator ruling on §0.1 (BLOCKING).** Xcode/runner upgrade, or dormant
visual-capture workflow. Everything downstream assumes the answer.

**Stage 1 — Mechanical adoption.** Take the rewrite-only files and `Package.swift`
wholesale (§1d). Nothing to reconcile; do it first so the tree compiles-in-principle
before the hard parts.

**Stage 2 — The two deletion sets.** (a) the modify/delete conflicts git reports;
(b) **the silent set** (§1b) — `FileTranscriber`, `TranscriptReconciler`,
`TranscriptStitcher` + their two test files. Work the §1b grep list to zero
dangling references. Do this early: it makes the real size of stage 3 visible.

**Stage 3 — Re-derive `SessionController`.** Rewrite's version as skeleton; re-apply
from main: the analyst wiring, session modes, coverage, `sessionGeneration` +
`isCurrent` (§4.3), `costUSD` at persist, `#if DEBUG` capture-seam call sites
(§2), `parkTurnMachine` (§3.2).

**Stage 4 — TTS sink + injection seam onto `CaptureController`** (§2, §3.3). Keep
main's `SpeechOutput` verbatim; drop the rewrite's `didCancel` (§1c).

**Stage 5 — Interruption ownership** (§3.2): `onState` → `speech.stop()` +
`parkTurnMachine()`.

**Stage 6 — Analyst onto the feed** (§4): `finalizedText` accessor, anchor on it,
cadence stays on the clock, fencing extended to the rewrite's two `isRunning`-only
sites.

**Stage 7 — Schema + migration** (§5): V1 at the PR#37 shape, `costUSD` into V2,
`transcriptIsReconciled` out, **and the `StoredEntry` timing fix first** — it is in
`TranscriptCore`, so its tests run headless and can be proven before any Mac is
involved.

**Stage 8 — The five UI merges** (§1e). `OnboardingView` last and most carefully.

**Stage 9 — `project.pbxproj`, by hand.** Merge three independent edits into the
same config blocks: PR#37's `EXCLUDED_SOURCE_FILE_NAMES` (Release), the rewrite's
deployment target + `UIBackgroundModes` + `TranscriptCore` product, and the new
test target. **Then re-read the Release config and confirm the exclusion list is
still there, verbatim.** This is the highest-consequence merge in the port and the
easiest to get silently wrong.

**Stage 10 — Headless gate (agent-runnable, Linux).** `swift test` on
`ShutUpAndListenKit` — requires Swift 6.1. Proves TranscriptCore (~1400 lines incl.
the adversarial suite) and that PR#37's TurnEngine/ClaudeClient additions still
compile under the Swift-5 language-mode pin. Not runnable in the current worktree
(no toolchain) — if the refinery cannot supply Swift 6.1, this folds into Gate A.

---

### Stage 11 — OPERATOR MAC GATE A (early, after stages 1–4)

Deliberately scheduled **mid-port**, not at the end: stages 1–4 change the build
graph (new module, new deployment target, deleted files), and a toolchain failure
discovered here costs four stages of rework instead of eleven.

| # | Command | Proves |
|---|---|---|
| A1 | `xcodebuild -scheme ShutUpAndListen -configuration Debug build` | The iOS 26 target + `TranscriptCore` package product resolve, and the deletions left no dangling reference. **This is where §0.1 becomes real** — if the Mac's Xcode predates 26, stop and return to Stage 0. |
| A2 | `swift test` in `ios/ShutUpAndListenKit` | TranscriptCore green; PR#37's TurnEngine/ClaudeClient additions still compile under the Swift-5 pin. |

### Stage 12 — Finish stages 5–9, then OPERATOR MAC GATE B (full)

| # | Command / action | Proves |
|---|---|---|
| B1 | Wire `ShutUpAndListenAppTests` into the project (File → New → Target → Unit Testing Bundle, host = `ShutUpAndListen`, folder as a file-system-synchronized group) | §0.2 — the migration is testable at all. One-time GUI step. |
| B2 | `⌘U` on an iOS 26 simulator | `MigrationTests` (incl. the new `costUSD` and timing-materialization cases) + `WriterTests`. **The data-safety gate** (§5.3). |
| B3 | `xcodebuild -configuration Release archive` | The port builds for shipping. |
| B4 | Inspect the archive: no `CaptureSeam` / `CaptureURLProtocol` / `CaptureAudioInjector` symbols, no `demo-conversation.wav` | **The security gate** (`765c21b`). Both mechanisms survived stage 9. Non-negotiable. |
| B5 | `./ios/scripts/capture-demo.sh` | The capture-injection harness end-to-end on the re-homed seam (§2). **Only if Stage 0 chose the upgrade path.** |
| B6 | Live session on device: speak, pause, let it reply, barge in; take a call mid-session and return | AEC (own voice not re-transcribed → §3.3), floor bookkeeping on barge-in (§1c), and the interruption park + truthful paused banner (§3.2). The one gate no test replaces. |
| B7 | Upgrade install over a build from current main, with sessions recorded | §5.4 end-to-end on real data: transcripts intact, cost readout intact, replay now working. |

**Stage 13 — PR.** Body states: the §0.1 decision and its consequence for the visual
workflow; that `transcriptIsReconciled` and the reconciler/stitcher/file-transcriber
are deleted deliberately; the dropped auto-stop on `.ended(shouldResume: false)`
(§3.2); and the migration's wall-clock→audio-time approximation (§5.3).

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The silent set survives the merge — dead reconciler/stitcher/file-transcriber compile fine and ship | **High** | Stage 2 is explicit and early; §1b grep list worked to zero |
| `project.pbxproj` merge drops `EXCLUDED_SOURCE_FILE_NAMES` → capture seam ships in Release | **High (security)** | Stage 9 by hand + B4 archive inspection |
| Migration drops `startMs`/`endMs` silently → replay permanently dead for PR#37-era sessions | **High (data)** | §5.3 fix + B2 regression test |
| `costUSD` dropped from V2 | Medium (data) | §5.2 + B2 |
| Generation fencing regressed to `isRunning` | Medium | §4.3 + explicit stop/start test |
| iOS 26 vs Xcode 16 discovered late | Medium | Stage 0 ruling; Gate A1 fails fast |
| Analyst candidates stop expiring on volatile churn | Medium | §4.2 finalized-text anchor |
| TTS player node not re-attached after engine rebuild → silent companion | Medium | §3.3; B6 |
| `OnboardingView` merge (both sides restructure page flow) | Medium | Stage 8, last, unhurried |
| Migration is untestable until the target is wired | Medium | B1 before B2 |

## Open questions for the operator

1. **§0.1 — the toolchain.** Upgrade the runner to Xcode 26, or accept a dormant
   visual-capture workflow? Blocking.
2. **§4.2 — drift units.** Finalized-character drift (recommended, zero change to
   `CandidatePool`) or audio-seconds drift (truer to the canonical timeline, costs
   the pure type's shape and its tests)?
3. **§5.3 — migrated timings.** Carry PR#37's wall-clock timings into the audio
   timeline as a documented approximation (recommended), or keep migrated records
   zeroed and replay-less?
4. **Informational, not blocking:** has any build containing PR#37 been installed on
   a real device or TestFlight? The §5.2 recommendation is safe either way; the
   answer only changes how loudly B7 needs to be exercised.
