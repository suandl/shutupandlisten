---
title: "port: SpeechAnalyzer transcript-core rewrite onto post-PR#37 main"
type: port
status: active
date: 2026-08-02
origin: su-xkmq.1 (epic su-xkmq)
bead: su-xkmq.1
executes_as: su-xkmq.2
---

> **Companion document, not on this branch.** The rewrite's own plan lives at
> `docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md` **on
> `claude/ios-voice-transcription-review-9ss6cj` (`27c20ed`) only** — it is not on
> `main` and not on this branch, so that path does not resolve here. Read it with
> `git show 27c20ed:docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md`.
> It arrives in-tree with the port (Stage 1).

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
GUI step, so it belongs to the operator (§6, Stage 11), and B1 is written to **fail
if it was skipped** — `-only-testing` errors out when the identifier is not in the
target, and B1 names the §5.5 cases individually, so an unwired target and a wired
but incomplete one both fail by name.

---

## 1. File-by-file disposition

Legend for provenance: **B** = exists at merge base `a3437ce`, **M** = present in
`ad11247`, **R** = present in `27c20ed`.

**The both-sides set is exactly fourteen files, and every one of them is
dispositioned** — thirteen in §§1a–1f, and `project.pbxproj` in §2 and Stages 4 and
11. Derive the set rather than trusting the list; if it returns a name this plan
never names, the plan is incomplete and the execution bead must stop and say so:

```bash
LC_ALL=C comm -12 \
  <(git diff --name-only a3437ce..ad11247 | sort) \
  <(git diff --name-only a3437ce..27c20ed | sort)
```

Eleven of the fourteen are the audio/session/schema/UI/pbxproj files the epic
anticipated (§1a, §1c, §1e, §2). The other three — `ShutUpAndListenApp.swift`,
`RecordingStorage.swift`, `ios/README.md` — are **not** in the epic's framing and
carry load-bearing behavior from both sides; they are §1f.

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
| `App/Support/SessionRecovery.swift` (+111) | **Keep, narrowed — and re-shape its insert for V2 (see below).** Its `adoptOrphanedRecordings` covers "audio file on disk with no owning record" — a failure the rewrite's record-at-start design makes impossible *going forward*, but which real devices can already be in from pre-port builds. Strip its `FileTranscriber.transcribe` call (line 96) and its `transcriptIsReconciled` use; keep the orphan sweep. It is complementary to, not overlapping with, PersistenceWriter's `recording`-state recovery — different failure, different input. |
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

#### `SessionRecovery`'s adopted row must be V2-shaped, or it is invisible

The narrowing above is not sufficient on its own, and the residue **compiles
silently**. `adoptOrphanedRecordings` inserts with main's V1-shaped call
(`ad11247:SessionRecovery.swift:51`):

```swift
context.insert(SessionRecord(
    startedAt: created, duration: duration, title: "Recovered recording",
    transcriptJSON: Data("[]".utf8), criteriaText: "", audioFileName: fileName
))
```

Every one of those arguments still type-checks against V2's initializer —
`transcriptJSON` merely widened to `Data?`. But V2's init declares
**`state: SessionState = .recording`** (`27c20ed:SessionRecord.swift:126`), and
`LibraryView`'s query is `#Predicate<SessionRecord> { $0.state != "recording" }`
(§1e). So the adopted record lands in a *live-session* state, the library filters
it out, and the recovery path silently produces rows no user can ever see — the
exact failure the sweep exists to prevent. No compiler error, no runtime error.

**Required in the execution bead:** pass `state: .recovered` explicitly at that
insert. `.recovered` already exists in `SessionState`
(`enum SessionState: String { case recording, complete, recovered }`) and is a
*visible terminal* state — `LibraryView` renders it with the "Recovered" badge
it already ships. Audit the same way for any other `SessionRecord(...)`
construction that survives the port: **under V2 the default is `recording`, so
every non-live insert must name its state.** Covered by the regression test
`recovered orphan row is visible` in §7.

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

### 1f. The three both-sides files outside the epic's framing

Both sides changed each of these, and taking either side wholesale silently drops
something the other side needs. None of them is a UI merge, so none belongs in §1e.

| File | main | rewrite | Disposition |
|---|---|---|---|
| `App/ShutUpAndListenApp.swift` | +54/−1 | +38/−1 | **Merge deliberately** — rewrite's container + recovery, main's seam + root + scene phase (below). |
| `App/Support/RecordingStorage.swift` | +12 | +23/−2 | **Union both additions** (below). |
| `ios/README.md` | +139/−38 | +49/−19 | **Main's is the base; re-apply the rewrite's engine-facing edits** (below). |

#### `ShutUpAndListenApp.swift` — the migration's delivery vehicle *and* the seam's arming point

Take the **rewrite's** file as the skeleton, because two things in it cannot be
expressed any other way:

- The explicit `ModelContainer` built from `Schema(versionedSchema: SessionSchemaV2.self)`
  with `migrationPlan: SessionMigrationPlan.self`. Main uses the
  `.modelContainer(for: SessionRecord.self)` convenience modifier, **which cannot
  carry a migration plan.** Keep main's line and §5's custom stage never runs:
  SwiftData attempts a lightweight migration into V2 on its own, so
  `materializeLegacySegments` is never called, no `SegmentRecord` rows exist, and
  every migrated record limps along on the lazy read-path fallback instead.
  Nothing errors. This is the single highest-consequence line in the file.
- Launch recovery: `PersistenceWriter.recoverIncompleteSessions(container:)` on a
  detached task, then `await RecoveryGate.shared.markDone()`. The gate is awaited
  by `SessionController.startSession` (`27c20ed:SessionController.swift:237`), so
  dropping `markDone()` does not fail loudly — it **hangs every session start
  forever**.

Then re-apply from main, by hand — the rewrite's file has none of it:

- [ ] `#if DEBUG CaptureSeam.installIfNeeded() #endif` in `init()`. This is where
      the capture harness is armed; the `#if DEBUG` guard is one of the two
      mechanisms in §2's security row, and the rewrite's `init()` has no trace of
      it. A3/B5 check the *Release* half; nothing checks that the Debug half still
      exists, so it must be on this checklist.
- [ ] The `RootView` navigation shell in full: root `NavigationStack`, the
      post-stop landing (`onChange(of: controller.lastSavedRecordID)` → fetch →
      `path.append(record)`), and the `onChange(of: controller.isRunning)` reset
      that surfaces the live screen when a Shortcut starts a session.
- [ ] **Root at `SessionView`, not `LibraryView`.** The rewrite roots the
      `WindowGroup` at `LibraryView`; main's talk-first root is the PR#37 redesign
      (§2) and wins. Taking the rewrite's line here reverts the product's opening
      screen — a change no compiler and no test in this plan would catch.
- [ ] `@Environment(\.scenePhase)` + `.onChange(of: scenePhase) { controller.scenePhaseChanged($1) }`.
      The controller owns the checkpoint-on-background and idle-timer policy; the
      rewrite dropped the reporting half.

#### `RecordingStorage.swift` — union, and the sweep stays `.m4a`-only on purpose

Neither side's additions can be dropped:

- **From main:** `allRecordingFileNames()` — the sole input to
  `SessionRecovery.adoptOrphanedRecordings` (`ad11247:SessionRecovery.swift:32`),
  which §1b keeps. The rewrite deleted it, having no orphan sweep.
- **From the rewrite:** `cafFileName(stem:)`, `m4aFileName(stem:)`, `stem(of:)`,
  `deleteBoth(stem:)` — the CAF/M4A naming convention. Fifteen call sites across
  `SessionController`, `PersistenceWriter`, `LibraryView` and `WriterTests` depend
  on them, including §1e's stem-paired deletion.

`allRecordingFileNames()` filters `.m4a` and **stays that way.** Under
record-at-start every live capture has a record from its first sample, so a
crash-orphaned `.caf` is never record-less — `PersistenceWriter.recoverIncompleteSessions`
owns it, by record state. Widening the sweep to `.caf` would make the two recovery
paths race for the same file. The only true orphans left are `.m4a` files from
pre-port builds, which is exactly what the sweep is narrowed to. Say this in the
function's doc comment, or the next reader "fixes" it.

#### Recovery ordering — the two sweeps are not commutative

`adoptOrphanedRecordings` documents its own precondition: *"Called once per launch,
before any new session can start recording — so every .m4a on disk without a record
is genuinely an orphan, never an active file."* Under the port there is a second
launch sweep, and the precondition now cuts the other way:

`recoverIncompleteSessions` **remuxes a crashed CAF to `.m4a` and then adopts it
into its record.** Between the remux and the save there is a window where a
finished-looking `.m4a` exists whose record does not yet point at it. An orphan
sweep running in that window adopts a duplicate "Recovered recording" for audio
that already has a home.

**Required:** the orphan sweep runs **after** `RecoveryGate` completes — the same
latch `startSession` already waits on. In practice that means moving the call out of
`configure(modelContext:accountStore:)`'s synchronous body and behind
`await RecoveryGate.shared.waitUntilDone()`. Stage 5 owns the edit (the call site is
in the re-derived file); §7's `orphan sweep runs after launch recovery` pins it.

`reconcilePendingTranscripts` is a different matter: **delete it outright**, along
with its call site. It exists only to drive `FileTranscriber` (deleted, §1b) and to
settle `transcriptIsReconciled` (dropped at V2, §5.2). §1b's "narrowed" means the
orphan sweep survives and this function does not.

#### `ios/README.md`

Main's is the base — it documents the PR#37 redesign, session modes and the capture
harness, and is the larger rewrite of the two. Re-apply the rewrite's engine-facing
edits on top: the `TranscriptCore` package in the layout tree, SpeechAnalyzer in
place of `SFSpeechRecognizer`, the CAF-during-capture/remux-at-close storage note,
and the iOS-26 requirement. Then fix what the port falsifies: the `AudioPipeline`
reference at `README:53` (§1b's grep list) and any text describing the second
offline transcription pass. Docs-only, but it is the first thing the next agent
reads.

---

## 2. What of PR#37 must be preserved, and how it survives

Verified against the real diffs, not the epic's list.

| Item | Where it lives | Survives how |
|---|---|---|
| **Release-exclusion of the capture seam** (`765c21b`) — SECURITY | `CaptureSeam.swift`, `CaptureURLProtocol.swift`, `CaptureAudioInjector.swift` (whole files `#if DEBUG`); `EXCLUDED_SOURCE_FILE_NAMES` on the app target's **Release** config; every call site in `SessionController` + `ShutUpAndListenApp` guarded | **Two mechanisms, two different risks.** The `#if DEBUG` file guards survive untouched (the rewrite does not touch those files). The `EXCLUDED_SOURCE_FILE_NAMES` block lives in `project.pbxproj` — **which the rewrite also edits, in the same config blocks** (deployment target, `UIBackgroundModes`). A sloppy pbxproj merge silently re-arms the seam in Release. The call-site guards in `SessionController` are **deleted by the re-derivation** and must be re-added by hand — as must `CaptureSeam.installIfNeeded()` itself, which arms the seam from `ShutUpAndListenApp.init()` and is absent from the rewrite's version of that file (§1f). |
| **Keychain overwrite stays gone** (`765c21b`) | `CaptureSeam.installIfNeeded()` — no `KeychainStore.apiKey` write | Survives untouched. Assert by grep that no `KeychainStore.apiKey =` appears under the capture seam. |
| **Seed-flag consistency** (`fd8d4b5`) | `Kit/Sources/ClaudeClient/CaptureSupport.swift` + its tests | **Safe by construction** — entirely in `ClaudeClient`, which the rewrite does not touch. |
| **TTS through the AEC engine** | `SpeechOutput.swift` (`TTSPlaybackSink`) + the player node in `AudioPipeline` | File survives (§1c); **the sink does not** — `AudioPipeline` is deleted and `CaptureController` has no TTS. Must be re-homed (§3). Without this the mic hears the app's own voice. |
| **TTS buffers scheduled from `write`'s async callback** (`6708a05`) | `SpeechOutput.swift`, +117/−24 | Survives with the file, provided §1c is honored. |
| **Analyst late-reply fencing** (`31dba3c`) | `SessionController.swift` **only** (+122/−19) | **Entirely in the re-derived file** — must be hand-carried. See §4.3; the rewrite actively regressed this without knowing. |
| **Analyst pool logic in TurnEngine** | `CandidatePool`, `AnalystCadence`, `AnalystPrompt` + tests | Pure, transport-agnostic, untouched by the rewrite. Survives — but its *anchoring contract* breaks silently (§4.2). |
| **UI redesign, session modes, coverage presets, patience ring** | `UI/*`, `TurnEngine/SessionMode.swift`, `CoveragePresets.swift` | Survive; UI needs the five hand-merges of §1e. |
| **Talk-first root, post-stop landing, scene-phase policy** | `ShutUpAndListenApp.swift` (`RootView`, `scenePhaseChanged`) | **At risk, silently.** The rewrite roots the `WindowGroup` at `LibraryView` and drops the scene-phase forwarding; both compile fine either way. Re-applied by §1f. |
| **Orphan-recording adoption** | `SessionRecovery.adoptOrphanedRecordings` + `RecordingStorage.allRecordingFileNames()` | Kept (§1b), but its input helper is deleted on the rewrite side and its call site is deleted by the re-derivation — §1f restores both, behind `RecoveryGate`. |
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
pipeline. But it did **four** things — and `pipeline.suspend()` was itself two —
so CaptureController replaces only two of five:

| Main's `.began` does | Post-port |
|---|---|
| `pipeline.suspend()` → `engine.pause()` | ✅ CaptureController, internal (`pause()`) |
| `pipeline.suspend()` → **VAD reset** (`inSpeech = false`, `speechBufferRun = 0`) | ❌ **gap** — see §3.2a |
| `persistSession(final: false)` | ✅ obsolete — PersistenceWriter saves per finalized segment |
| `speech.stop()` | ❌ **gap** — and it is not enough on its own, see §3.2b |
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

**Fix:** restore `parkTurnMachine()` and drive it (plus `speech.stop()` **and the
listener-segment close**) from the `onState` transition into `.paused`:

```
capture.onState = { state in
    self.captureState = state                  // existing: UI banner
    if state == .paused, self.isRunning {      // new: session response
        self.speech.stop()
        self.closeOpenListener(bargedIn: true)  // §3.2b — cut point, synchronously
        self.lastFloorReleaseMs = self.nowMs()  // §3.2b — WALL-clock ms, not audioNow
        self.parkTurnMachine()
    }
}
```

### 3.2a The VAD reset — `CaptureController.pause()` does not do it

`AudioPipeline.suspend()` was explicit about this, in a comment naming the reason
(`ad11247:AudioPipeline.swift:150`): *"VAD state so a half-formed onset doesn't
survive the gap."* Its body is `engine.pause(); inSpeech = false;
speechBufferRun = 0`.

`CaptureController.pause()` (`27c20ed:CaptureController.swift:581`) is
`engine.pause(); setState(.paused); scheduleResumeRetry()` — **no VAD reset.**
CaptureController *does* reset that state, but only in `start()` (line ~188), under
a comment that explains exactly why it lives there: *"VAD state resets live HERE
(not in stop): this runs before the tap exists, so no audio-thread write can race
them."* An interruption never goes through `start()`, so across a pause the VAD
keeps `inSpeech`, `speechBufferRun`, `lastVoiceMs` and `noiseFloorDb` from before
the gap. Post-resume, a half-formed onset completes against pre-gap buffers, or an
`inSpeech == true` carried across a five-minute phone call fires a hangover-driven
end-of-speech the moment audio returns — either way the first turn after an
interruption is decided on stale evidence.

**Required in the execution bead** — this is `CaptureController`'s own state, so it
is CaptureController's job, not `SessionController`'s:

1. Reset the VAD window on the way **into** pause: `inSpeech = false`,
   `speechBufferRun = 0`, and `lastVoiceMs = 0` so the hangover timer cannot fire
   against a pre-gap voice timestamp.
2. Leave `noiseFloorDb` to re-converge rather than resetting it to `-50` — the room
   is usually the same room, and `start()`'s hard reset is for a genuinely new
   session. (If the resume path rebuilds the engine for a *route* change, the
   floor should reset with it; fold that into the existing rebuild path.)
3. **Respect `start()`'s race argument.** Those fields are written from the audio
   thread. `start()` can write them lock-free only because it runs before the tap
   exists; `pause()` cannot make that claim — the tap is still installed and a
   buffer can be in flight. Do the reset either under the same lock discipline the
   clock fields use (`clockLock`), or by setting a `resetVADOnNextBuffer` flag that
   the tap callback consumes (mirroring the existing `proveResumeOnNextBuffer`
   pattern, which solves this identical problem for the clock). **The flag form is
   the recommendation** — it reuses a pattern already proven in this file and keeps
   the audio thread the only writer.
4. Cover it with **both** §7 rows: `pause/resume clears half-formed onset` (items 1's
   state fields) and `pause/resume clears the stale voice timestamp, before the first
   buffer` (item 1's `lastVoiceMs` and item 3's ordering). The first alone passes
   against a reset applied after the first post-resume buffer, which is the bug.

### 3.2b Pausing mid-clip must close the open listener segment

`speech.stop()` alone is not the whole of the pause response, for the same reason
it is not the whole of the *stop* response. The rewrite already treats these as
inseparable in both places that cut a clip:

- `stopSession()` — `speech.stop()` then `closeOpenListener(bargedIn: true)`, under
  a comment stating the invariant: *"a stop mid-speech must never persist unspoken
  words as spoken"* (`27c20ed:SessionController.swift:456`–`463`).
- `case .bargeIn` — `speech.stop()`, `lastFloorReleaseMs = t`, then
  `closeOpenListener(bargedIn: true)` (line 714–716).

An interruption is the same event class: a clip is cut part-way through. Without
the close, `openListenerSegmentID` stays open across the gap with its **estimated**
end (`start + SpeechOutput.estimateDurationMs(...)`, set at append time), so the
persisted segment claims the companion said words it was cut off before speaking —
and on a long interruption that estimate can land arbitrarily far from any audio
that exists.

**Required in the execution bead:**

- Call `closeOpenListener(bargedIn: true)` on the pause path, **before**
  `parkTurnMachine()`. `bargedIn: true` is the correct semantic: the clip was cut,
  not finished. The cut point is `capture?.audioNow` read inside
  `closeOpenListener` — which is right, because the fed-samples clock stops with
  the engine, so `audioNow` *is* the last real audio position.
- It is already idempotent and already ordered correctly: the close is enqueued on
  the serial write chain and nils `openListenerSegmentID` at execution time, so a
  late `didCancel`-driven `onFinished` finds nothing open and no-ops. The same
  reasoning `stopSession` documents applies verbatim.
- Also set `lastFloorReleaseMs`, as `.bargeIn` does — otherwise the floor
  bookkeeping believes the companion still holds the floor across the gap.
  **Mind the units: this one is wall-clock ms, not the audio clock.**
  `lastFloorReleaseMs` is a `Double` fed from `nowMs()` and consumed as
  `now - lastFloorReleaseMs` (`27c20ed:SessionController.swift:188`, `774`), whereas
  `closeOpenListener`'s cut point is `capture?.audioNow` in audio *seconds*. The two
  are not interchangeable, and they diverge by exactly the interruption's length —
  which is the whole subject of this section. Use `nowMs()`.
- Cover it: `pause mid-clip closes the listener segment at the cut point` in §7.

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

**Recommendation — anchor on finalized text.** Stated as three concrete edits, not
as a direction, because "feed it finalized text" has a wrong reading that compiles
and silently disables expiry (below).

**Edit 1 — `TranscriptCore`, Stage 3.** Add the projection next to `fullText`,
mirroring it exactly so the two are comparable (same speaker filter, same
empty-drop, same `" "` join — the separator is part of the length basis):

```swift
/// The THINKER's settled text only — the analyst's drift basis. Mirrors
/// `fullText` except for `state == .final`: volatile segments are excluded, so
/// the length is monotonically non-decreasing (finalization is one-way) and a
/// shortening revision cannot move it backwards.
public var finalizedText: String {
    segments
        .filter { $0.speaker == .thinker && $0.state == .final && !$0.text.isEmpty }
        .map(\.text)
        .joined(separator: " ")
}
```

**Edit 2 — `SessionController`, Stage 5: cache it where `fullText` is already
cached.** `startStoreSubscription` (`27c20ed:SessionController.swift:592`) already
awaits `store.fullText` on every event and parks it on the main actor. Add one more
await and one more stored property beside it:

```swift
let full      = await store.fullText
let finalized = await store.finalizedText     // new
self.cachedFullText      = full
self.cachedFinalizedText = finalized          // new
```

This is deliberately **not** a second subscription. The reason is a hard constraint,
not a preference: `analyst.candidate(for:transcriptLength:)` is called synchronously
inside the gate's decision path (`ad11247:SessionController.swift:905`–`906`) and **cannot
await**. The basis has to be a main-actor value that is already in hand at decision
time, which is exactly what the existing subscription produces.

**Edit 3 — `SessionController`, Stage 5: move both analyst call sites to that
basis, and only those two.**

| Site | main today | Port |
|---|---|---|
| `ad11247:761` | `analyst.tick(nowMs: now, transcript: transcriber.fullText)` | `analyst.tick(nowMs: now, transcript: cachedFinalizedText)` |
| `ad11247:905`–`906` | `analyst.candidate(for: decision.tier, transcriptLength: transcriber.fullText.count)` | `…, transcriptLength: cachedFinalizedText.count` |

The formation anchor needs no edit and **must not get one**:
`recompute(nowMs:transcript:)` stamps `let anchor = transcript.count`
(`ad11247:ConversationAnalyst.swift:100`) from the very string `tick` was handed, so
it follows Edit 3 automatically. That is precisely why the two rows above have to
move **together**.

> **The wrong reading, and why it is silent.** `CandidatePool.expire` drops a
> candidate when `currentPosition - anchorPosition > maxDrift`. Move `tick` to
> `finalizedText` but leave line 906 on `fullText.count` and every anchor is stamped
> short while the gate's expiry position is stamped long — drift is systematically
> **over**-stated and fresh candidates are dropped at the moment they would be
> spoken. Do the reverse and drift goes negative and nothing ever expires — the
> original bug, now permanent. Both compile, both are silent, and one basis per
> `CandidatePool` is the whole invariant.

**Leave `fullText` alone at its other two uses.** `askNow()`
(`ad11247:1012`) and `checkCoverage()` (`ad11247:1082`) want the live text
*including* the in-flight utterance and are not drift-anchored to anything. A
global replace of `transcriber.fullText` breaks both. Only the two analyst sites
move.

**Where `AgentFeed` fits.** `AgentFeed` is the right seam for a consumer that
should not reach into the host — its `finalizedSegments(replayingSnapshot:)`
(`27c20ed:AgentFeed.swift`) already yields exactly the finalized-only stream, and a
future out-of-host analyst should ride it. It is *not* the right mechanism for this
anchor, for a reason worth writing down: an accumulator fed by events is monotonic
only if every segment is finalized exactly once, and `finalizeAll` republishes a
`.segmentFinalized` per **replacement** segment when a volatile splits
(`27c20ed:TranscriptStore.swift:250`), so a naive `+=` double-counts. The projection
above is recomputed from the append-only log and is monotonic by construction.
**Use the feed for consumers; use the cached projection for the basis.** If a later
change does move the analyst behind `AgentFeed`, it must carry the accumulated
finalized *length* on the feed itself rather than re-deriving it per subscriber.

Consequences of the recommendation:

- `CandidatePool` is **unchanged** — same `Int` character drift, same `maxDrift`,
  same tests still valid.
- Monotonicity holds by construction; pinned by
  `TranscriptStoreTests/testFinalizedTextIsMonotonic` (§7, headless at Stage 7).
- The two-site agreement is pinned by
  `AnalystFeedTests/testAnalystTickAndCandidateShareFinalizedBasis` (§7, at B3) —
  the host-level test that fails on exactly the wrong reading boxed above.
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

**Fix, part 1 — in `TranscriptCore`** (package-local, headless-provable, Stage 3):

1. Add `startMs: Int?` / `endMs: Int?` to `StoredEntry` (optional — base-era blobs
   legitimately lack them).
2. Have `segments(from:)` populate `audioStart`/`audioEnd` from them, `÷ 1000`,
   when present; zero when absent.
3. Have `StoredEntry.init(_ segment:)` write them back, so the export DTO
   round-trips instead of silently flattening new records too.

**Fix, part 2 — in the app-side row materializer** (Stage 8). **Part 1 alone does
not migrate a single timing**, because the migration stage does not go through
`TranscriptCore.segments(from:)` at all. `SessionMigrationPlan.migrateV1toV2`'s
`didMigrate` calls `record.materializeLegacySegments(in:)`
(`27c20ed:SessionRecord.swift:216`), and that function hardcodes the zeros
(line 306):

```swift
func materializeLegacySegments(in context: ModelContext) {
    guard segments.isEmpty else { return }
    for (position, entry) in legacyEntries.enumerated() {
        let row = SegmentRecord(
            speaker: entry.speaker, text: entry.text, tier: entry.tier,
            turn: entry.turn,
            audioStart: 0, audioEnd: 0,        // ← the drop happens HERE
            bargedIn: false, index: position
        )
        …
    }
}
```

`legacyEntries` decodes through `TranscriptCore.StoredEntry`, so after part 1 the
timings are *available* on `entry` — and still discarded. Required:

4. **`materializeLegacySegments(in:)` must carry the timings through**:
   `audioStart: entry.startMs.map { Double($0) / 1000 } ?? 0`, likewise `audioEnd`.
   This is the function the migration actually runs; without this edit findings
   §5.3(1–3) change nothing observable and every PR#37-era session still migrates
   replay-less.
5. **Fix the doc comments that assert the zeros**, or the next reader re-derives
   the old behavior from them. Three of them are now conditionally wrong:
   `materializeLegacySegments`' own *"index = array order, zeroed ranges"*;
   `orderedSegments`' *"Migrated rows carry all-zero ranges and fall back to pure
   index order through the tiebreak"*; and `hasTimings`' *"Legacy-materialized rows
   are zeroed, so migrated records degrade to the static view."* Each becomes
   "…when the legacy blob carried no timings (pre-PR#37 records); PR#37-era blobs
   materialize with real ranges." The `orderedSegments` sort is unaffected either
   way — real ranges sort correctly by `(audioStart, index)`, and the index
   tiebreak still covers the all-zero case.
6. **Same treatment for the read-path fallback.** `transcriptSegments` falls back to
   `TranscriptCore.segments(from: legacyEntries)` for records the stage never
   touched; part 1 fixes that path automatically, and the two must agree — a record
   must not gain or lose replay depending on whether the migration reached it.
   Assert that agreement in the tests (§5.5).

Then PR#37-era records migrate **with working replay** rather than degraded, and
`hasTimings` becomes true for them — via both the materialized rows and the lazy
fallback.

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
3. **Add a timing-materialization test** — a V1 blob carrying `startMs`/`endMs`,
   seeded and reopened **through `SessionMigrationPlan`** (not by calling
   `segments(from:)` directly), must produce `SegmentRecord` rows with non-zero
   `audioStart`/`audioEnd` and `hasTimings == true`. Going through the real plan is
   the point: it is the only thing that exercises `materializeLegacySegments(in:)`,
   which is where the drop actually happens (§5.3 part 2). A test that asserts on
   `TranscriptCore.segments(from:)` passes with the bug intact. This is the single
   most valuable test in the file.
4. **Add a materializer/fallback agreement test** — for the same blob, the
   migrated rows (`orderedSegments`) and the lazy read-path fallback
   (`transcriptSegments` on a record with no rows) must yield the same ranges, so a
   record cannot gain or lose replay depending on whether the stage reached it
   (§5.3 part 2, item 6).
5. **Add a base-shape (pre-PR#37) fixture** so both inbound stores are covered —
   and assert the *negative*: no timings in, zeroed ranges out,
   `hasTimings == false`. That is what keeps the fix from becoming "invent timings".
6. Keep the existing three tests as-is —
   `testMigrationMaterializesOrderedSegmentRows`,
   `testMigratedRecordDerivedViewsComeFromSegments`,
   `testLazyMaterializerDecodesLegacyBlobOnRead`.
7. **Wire the target** (§0.2) — none of this runs otherwise.

Items 1–5 are the five new method names B1 passes to `-only-testing`:
`testV1FixtureIsPR37Shape`, `testCostUSDSurvivesV1ToV2`,
`testMigrationCarriesPR37Timings`, `testMaterializedRowsAgreeWithLazyFallback`,
`testBaseShapeYieldsZeroedRangesAndNoTimings`. **B1 names item 6's three as well** —
all eight, individually — so "keep them" is enforced rather than hoped for. Rename
one and B1 fails by name, which is the intended coupling, not an accident to route
around.

---

## 6. Sequenced work breakdown for su-xkmq.2

Branch fresh from `ad11247`; never force-push
`claude/ios-voice-transcription-review-9ss6cj` — it is the only copy of the rewrite
until the port is proven.

**`SessionController` is edited exactly once, in Stage 5.** All four epic
workstreams land in that file, and the whole reason this plan exists is to make
that one pass instead of four. Stage 5 therefore carries the *complete*
integration checklist — interruption response and analyst rewiring included — and
no later stage reopens the file. Where a later stage refers to §3.2 or §4, it is a
**validation checkpoint on work Stage 5 already did**, not a second edit.

**Stages are numbered in execution order, gates included.** A gate's number is its
position in the sequence: Gate A is Stage 10 because it runs after Stage 9 and
before Stage 11. There is no "do this stage out of order" anywhere below.

**Stage 0 — Operator ruling on §0.1 (BLOCKING), and the toolchain probe.**
Xcode/runner upgrade, or dormant visual-capture workflow. Everything downstream
assumes the answer. Before any code is written, run the probe below on the Mac that
will execute Gates A and B. It needs no compiling tree, which is exactly why it
belongs here rather than at a build failure ten stages later:

```bash
xcodebuild -version
xcodebuild -showsdks | grep -qE 'iphoneos2[6-9]' \
  || { echo 'BLOCKED (§0.1): no iOS 26 SDK on this Mac — Xcode 26 is required' >&2; exit 1; }
echo 'Stage 0 OK — iOS 26 SDK present'
```

This answers the operator-Mac half of §0.1. The CI half — whether
`ios-visual.yml`'s runner moves to Xcode 26 or the workflow goes dormant — is the
ruling itself, and is not something a probe can settle.

**Stage 1 — Mechanical adoption.** Take the rewrite-only files and `Package.swift`
wholesale (§1d). Nothing to reconcile; do it first so the tree compiles-in-principle
before the hard parts.

**Stage 2 — The two deletion sets.** (a) the modify/delete conflicts git reports;
(b) **the silent set** (§1b) — `FileTranscriber`, `TranscriptReconciler`,
`TranscriptStitcher` + their two test files. Work the §1b grep list to zero
dangling references. Do this early: it makes the real size of Stage 5 visible.

**Stage 3 — `TranscriptCore`: the timing fix and the finalized-text projection.**

- §5.3 **part 1** — `StoredEntry` gains `startMs`/`endMs`; `segments(from:)` and
  `StoredEntry.init(_:)` carry them. Prerequisite for the app-side migration in
  Stage 8, which reads the timings this stage makes available.
- §4.2 **Edit 1** — `TranscriptStore.finalizedText`, the analyst's drift basis.
  It belongs here, and before Stage 5 consumes it.

Both are package-local and headless-provable, so both are proven at Stage 7 before
any Mac is involved. Their §7 rows name four package selectors —
`StoredEntryTests/testStoredEntryDecodesPR37Timings`,
`StoredEntryTests/testSegmentsFromEntriesCarryTimings`,
`StoredEntryTests/testStoredEntryRoundTripsTimings` and
`TranscriptStoreTests/testFinalizedTextIsMonotonic` — and they are what Stage 7,
A2 and B2 actually run.

**Stage 4 — `project.pbxproj`, part 1: the build graph.** By hand. Merge the
rewrite's deployment target + `UIBackgroundModes` + `TranscriptCore` product into
the same config blocks that hold PR#37's `EXCLUDED_SOURCE_FILE_NAMES` (Release).
**Then re-read the Release config and confirm the exclusion list is still there,
verbatim** — this is the highest-consequence merge in the port and the easiest to
get silently wrong. Split out from the test-target wiring (Stage 11) and moved
early because **Gate A cannot build the app without it**. The direct build-setting
check is A3.

**Stage 5 — Re-derive `SessionController` — THE SINGLE PASS.** Rewrite's 1101-line
version as the skeleton; re-apply from main. This checklist is exhaustive; nothing
below reopens this file:

- [ ] analyst wiring, session modes, coverage presets, patience ring (§2)
- [ ] `sessionGeneration` + `isCurrent(_:)`, applied to **every** model-reply
      completion including the rewrite's two `isRunning`-only sites (§4.3)
- [ ] `costUSD` written at persist (§5.2)
- [ ] `#if DEBUG` capture-seam call sites, re-added by hand — the re-derivation
      deletes them (§2)
- [ ] `parkTurnMachine()` restored, and driven from `onState` → `.paused` (§3.2)
- [ ] `closeOpenListener(bargedIn: true)` + `lastFloorReleaseMs` on that same
      pause path, before the park (§3.2b)
- [ ] `cachedFinalizedText` added beside `cachedFullText` in
      `startStoreSubscription` (§4.2 Edit 2)
- [ ] **both** analyst sites moved to that basis — `tick` (761) and
      `candidate(for:transcriptLength:)` (906) — and `askNow`/`checkCoverage` left
      on `fullText`; cadence left on the clock (§4.2 Edit 3, §4.5)
- [ ] `SessionRecovery`'s adopted row given `state: .recovered` explicitly, and
      every other surviving `SessionRecord(...)` insert audited for a named state
      (§1b)
- [ ] `SessionRecovery.adoptOrphanedRecordings` call site restored — the
      re-derivation deletes it with `configure(...)` — and moved behind
      `await RecoveryGate.shared.waitUntilDone()` (§1f)
- [ ] `SessionRecovery.reconcilePendingTranscripts` and its call site **deleted**
      (§1f): it drives the deleted `FileTranscriber` and the dropped
      `transcriptIsReconciled`

**Stage 6 — `CaptureController` + `SpeechOutput`.** The other audio-owning files,
so genuinely separate work, not a second pass at Stage 5:

- [ ] TTS sink re-homed onto `CaptureController`; conform to `TTSPlaybackSink`;
      player node re-attached by the engine-rebuild paths (§3.3)
- [ ] `#if DEBUG` injection seam — `start(injecting:)` + `injectForCapture(_:)`
      through the canonical converter (§2)
- [ ] VAD reset on `pause()` via the `proveResumeOnNextBuffer`-style flag (§3.2a)
- [ ] `SpeechOutput` kept verbatim from main; the rewrite's `didCancel` dropped
      (§1c)

**Stage 7 — HEADLESS GATE (agent-runnable, Linux).** `swift test` on
`ShutUpAndListenKit` — requires Swift 6.1. Proves TranscriptCore (~1400 lines incl.
the adversarial suite) and that PR#37's TurnEngine/ClaudeClient additions still
compile under the Swift-5 language-mode pin. Not runnable in the current worktree
(no toolchain) — if the refinery cannot supply Swift 6.1, this folds into Gate A2.
**Re-run after Stage 8** if that stage touches the package.

The whole-suite run is the gate. Stage 3's own cases are additionally named, so a
run that is green because they were never written can be caught directly:

```bash
swift test --package-path ios/ShutUpAndListenKit --filter \
  'TranscriptCoreTests\.(StoredEntryTests/(testStoredEntryDecodesPR37Timings|testSegmentsFromEntriesCarryTimings|testStoredEntryRoundTripsTimings)|TranscriptStoreTests/testFinalizedTextIsMonotonic)'
```

`--filter` takes a regex over `Target.Class/method` and **exits nonzero when it
matches nothing**, so a missing case fails here the same way a missing
`-only-testing` identifier fails B1/B3. These four are §7's Stage-3 package rows,
and they run again unchanged at A2 and B2 (§7's fifth package row,
`CandidatePoolTests/testCandidatesExpireWhileVolatileChurns`, is Stage 5's and
belongs to the same three gates).

---

### Stage 8 — Schema, migration, and the app-side storage/entry seam

The schema work:

- §5.2 — V1 declared at the PR#37 shape, `costUSD` into V2,
  `transcriptIsReconciled` out.
- §5.3 **part 2** — the row materializer `materializeLegacySegments(in:)` carries
  the timings; the doc comments asserting zeros corrected.
- §5.5 — the `MigrationTests` changes.

Stage 3 is a hard prerequisite — without it there are no timings on `entry` to
carry.

The §1f files land here too, because each one is bound to this stage's types:

- [ ] **`ShutUpAndListenApp.swift`** (§1f) — the explicit `ModelContainer` with
      `migrationPlan:`, launch recovery + `RecoveryGate.markDone()`, and re-applied
      from main: `CaptureSeam.installIfNeeded()`, the `RootView` shell,
      `SessionView` as the root, and the scene-phase forwarding. It cannot land
      earlier: the container line does not compile until `SessionSchemaV2` and
      `SessionMigrationPlan` exist, and this is where they are defined. It must
      not land later either — **it is what makes the migration run at all.**
- [ ] **`RecordingStorage.swift`** (§1f) — union: main's `allRecordingFileNames()`
      (kept `.m4a`-only, with the reason in its doc comment) plus the rewrite's
      CAF/M4A stem helpers.
- [ ] **`ios/README.md`** (§1f) — main's as the base, the rewrite's engine-facing
      edits re-applied, the `AudioPipeline` reference at `README:53` corrected.

**Compile-critical, hence before Gate A.** Stage 5's checklist writes `costUSD` at
persist against a V2 model that does not declare it until this stage lands;
`transcriptIsReconciled` survives on the model until this stage drops it; and Stage
5's restored orphan-sweep call awaits a `RecoveryGate` that nothing marks done until
this stage's app-entry merge.

### Stage 9 — The five UI merges

§1e. `OnboardingView` last and most carefully. `LibraryView`'s
`state != "recording"` predicate is mandatory, and is what makes the Stage 5
`.recovered` fix observable.

**Compile-critical, hence before Gate A.** Three of the five do not compile against
the ported tree until they are merged: `OnboardingView:135` still calls the deleted
`SpeechTranscriber.requestAuthorization()` (§1a, §1b); `SessionDetailView` still
seeks through `StoredEntry.startMs` rather than
`record.transcriptSegments`/`audioStart`, and reads the `costUSD` that Stage 8 puts
on V2; and `TranscriptEntry.id` is a `UUID` where the port supplies a `SegmentID`
(§1e).

### Stage 10 — OPERATOR MAC GATE A

The first gate that builds the app, placed at the **earliest point where a full app
build is a fair test**: every agent-side reconciliation (Stages 1–9) has landed,
and all that remains is the operator's GUI target-wiring (Stage 11) and Gate B.
It cannot run earlier — A1 builds the whole app, and the app does not compile until
Stages 8 and 9 land (see each stage's compile-critical note). A gate scheduled
against known-pending work fails for a reason it was not built to detect: it would
report the port's own unfinished edges as a build failure and say nothing about the
toolchain, which is the one thing it was placed early to learn.

Nothing is lost by not being earlier, because the cheap half of the question is
already answered: **Stage 0's probe settles §0.1 before a line of code is written**,
with no compiling tree required. What Gate A adds is the half that genuinely needs
the assembled port — that the build graph resolves, that the deletions left no
dangling reference, and that the Release exclusions survived the pbxproj merge —
and it still runs two stages ahead of the archive at B5.

| # | Command | Proves |
|---|---|---|
| A1 | `xcodebuild -project ios/ShutUpAndListen.xcodeproj -scheme ShutUpAndListen -configuration Debug -destination 'generic/platform=iOS Simulator' build` | The iOS 26 target + `TranscriptCore` package product resolve, and the deletions left no dangling reference. Stage 0's probe said the SDK exists; this says the port compiles against it. If it does not, and the cause is the toolchain rather than the port, return to Stage 0. |
| A2 | `swift test --package-path ios/ShutUpAndListenKit` | TranscriptCore green (incl. Stage 3); PR#37's TurnEngine/ClaudeClient additions still compile under the Swift-5 pin. Redundant with Stage 7 when the refinery has Swift 6.1 — run it anyway, the Mac toolchain is the one that ships. |
| A3 | **Release build-setting check** — see below | Stage 4 did not drop the capture-seam exclusions. Catches the security regression *now*, before the archive would. |

**A3 — the direct `EXCLUDED_SOURCE_FILE_NAMES` check.** Archive inspection (B5) is
a good backstop but a late and indirect one: it reads symbol *absence*, which can
also be produced by dead-stripping, and it only runs at the very end. Read the
setting itself, and assert **all five** artifacts by name — a check that greps for
one of them reports OK while the other four are silently dropped, which is the
whole failure this gate exists to catch:

```bash
required='CaptureSeam.swift CaptureURLProtocol.swift CaptureAudioInjector.swift demo-conversation.wav capture-fixture.json'

# Deliberately no `set -e`: an unset setting must reach the explicit message
# below rather than killing the shell on grep's nonzero exit.
excluded=$(xcodebuild -project ios/ShutUpAndListen.xcodeproj \
                      -target ShutUpAndListen \
                      -configuration Release \
                      -showBuildSettings 2>/dev/null \
           | grep -E '^[[:space:]]*EXCLUDED_SOURCE_FILE_NAMES[[:space:]]*=')

echo "${excluded:-<EXCLUDED_SOURCE_FILE_NAMES is unset in Release>}"

missing=''
for f in $required; do
  case "$excluded" in
    *"$f"*) ;;
    *)      missing="$missing $f" ;;
  esac
done

if [ -n "$missing" ]; then
  echo "SECURITY: not excluded from the Release build:$missing" >&2
  exit 1
fi
echo 'A3 OK — all five capture artifacts excluded in Release'
```

Resolved settings are the right thing to read — they reflect what the build will
actually do after xcconfig layering and any `$(inherited)` expansion, which a
`grep` of `project.pbxproj` does not. An unset `EXCLUDED_SOURCE_FILE_NAMES` fails
exactly as a partial one does: `$excluded` is empty, every name is missing, and the
message names all five. Re-run A3 after Stage 11, since that stage edits the same
file, and keep the output for the PR body (Stage 13).

> **The fifth artifact, `capture-fixture.json`, was added in su-a71zn.** As
> written on 2026-08-02 this list held four names, and the fixture was copied
> into the Release bundle by the file-system-synchronized `App/Resources` group
> the whole time. It was the mildest of the five and never exploitable — no
> credential in the file, and its only reader, `CaptureSeam.loadFixture()`, is
> itself `#if DEBUG` **and** on this exclusion list, so no Release binary could
> read it even while it shipped. What it did contradict is the design intent
> asserted everywhere else in this plan: that the *whole* capture seam is
> compiled out of Release. It is now named in all five places that must move
> together: here, `gate-a3-release-exclusions.sh`, the bundle-side `find` in
> `gate-b5-release-archive.sh`, the app target's Release config, and the gate
> table in `ios/README.md`. That spread is why su-uzy9.6 filed this rather than
> folding a fifth name into the gate it was landing — and the README row, which
> still read "all four" until this change, is what a one-line pbxproj fix would
> have left stale.

### Stage 11 — `project.pbxproj`, part 2: wire the app-test target

Operator GUI step (File → New → Target → Unit Testing Bundle, host =
`ShutUpAndListen`, folder as a file-system-synchronized group). Resolves §0.2 — the
migration becomes testable at all. **Re-run A3 afterwards**: this edits the same
config blocks the exclusion list lives in.

### Stage 12 — OPERATOR MAC GATE B (full)

| # | Command / action | Proves |
|---|---|---|
| B1 | **App-test run, explicit** — see below | `MigrationTests` (incl. the new `costUSD`, timing-materialization, agreement and base-shape cases) + `WriterTests` **actually ran**, nonzero, both classes. **The data-safety gate** (§5.3). |
| B2 | `swift test --package-path ios/ShutUpAndListenKit` re-run | Stage 8 did not regress the package. |
| B3 | **Scheduled regression run, explicit** — see below | Every §7 app-test row named in that table actually ran and passed: fencing, TTS rebuild + `onFinished`, injection, VAD reset (state *and* stale timestamp), listener-close, turn-machine park, analyst finalized basis, recovered-row, recovery ordering. The package rows of §7 are covered by B2. |
| B4 | `xcodebuild -project ios/ShutUpAndListen.xcodeproj -scheme ShutUpAndListen -configuration Release archive -archivePath /tmp/sual.xcarchive` | The port builds for shipping. |
| B5 | **Archive inspection, explicit** — see below | **The security gate** (`765c21b`), second mechanism. A3 proved the setting; this proves the artifact. Non-negotiable — both, not either. |
| B6 | `./ios/scripts/capture-demo.sh` | The capture-injection harness end-to-end on the re-homed seam (§2). **Only if Stage 0 chose the upgrade path** — otherwise §7's `injection feeds the canonical converter` test is the standing substitute. |
| B7 | Live session on device: speak, pause, let it reply, barge in; take a call mid-session and return | AEC (own voice not re-transcribed → §3.3), floor bookkeeping on barge-in (§1c), the interruption park + truthful paused banner (§3.2), and that speech after the call starts a fresh turn (§3.2a). The one gate no test replaces. |
| B8 | Upgrade install over a build from current main, with sessions recorded | §5.4 end-to-end on real data: transcripts intact, cost readout intact, replay now working. |

**B1 — the app-test run, stated as a command with a proof.** `⌘U` is not a gate:
it is green when a test target exists but contains nothing runnable, and it leaves
no artifact to check. Name the tests, gate on the exit status, and assert the
bundle:

```bash
# `-u -o pipefail` but deliberately NOT `-e`: the xcodebuild status is captured
# and reported explicitly below, which `-e` would pre-empt with a bare exit.
set -uo pipefail

RB=/tmp/sual-apptests.xcresult
rm -rf "$RB"

xcodebuild test \
  -project ios/ShutUpAndListen.xcodeproj \
  -scheme ShutUpAndListen \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=26.0' \
  -resultBundlePath "$RB" \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testV1FixtureIsPR37Shape \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testCostUSDSurvivesV1ToV2 \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testMigrationCarriesPR37Timings \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testMaterializedRowsAgreeWithLazyFallback \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testBaseShapeYieldsZeroedRangesAndNoTimings \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testMigrationMaterializesOrderedSegmentRows \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testMigratedRecordDerivedViewsComeFromSegments \
  -only-testing:ShutUpAndListenAppTests/MigrationTests/testLazyMaterializerDecodesLegacyBlobOnRead \
  -only-testing:ShutUpAndListenAppTests/WriterTests \
  CODE_SIGNING_ALLOWED=NO
xc=$?
[ "$xc" -eq 0 ] || { echo "B1 FAILED: xcodebuild test exited $xc" >&2; exit 1; }

# Second mechanism: the bundle must show cases, and none of them failed.
xcrun xcresulttool get test-results tests --path "$RB" --format json \
  | jq -e '
      [.. | objects | select((.nodeType? // "") == "Test Case")]        as $cases
      | ($cases | map(select((.result? // "") == "Failed")) | length)   as $failed
      | if ($cases | length) >= 14 and $failed == 0 then true
        else error("B1: \($cases | length) cases ran (expected >= 14), \($failed) failed")
        end' > /dev/null \
  || { echo 'B1 FAILED: result-bundle assertion' >&2; exit 1; }

echo "B1 OK — result bundle at $RB"
```

Four things make this a gate rather than a ritual. `-only-testing` **fails the
build outright when the identifier is not in the target** — at method granularity
that covers both the §0.2 failure mode (no test class wired) and the §5.5 one (the
class is wired but a required case was never written), so "nonzero count per class"
is enforced by xcodebuild itself rather than by name-matching in `jq`. The explicit
`$xc` gate means a failing test run cannot be followed by a passing count: without
it, `jq` is reached however `xcodebuild` exited, and a red suite with a
well-populated result bundle reports green. The `jq -e` assertion independently
requires that cases ran and that none
carry `result == "Failed"`, so a bundle that is green-but-empty also fails. And the
result bundle is a durable artifact someone else can re-check — attach `$RB` to the
PR.

**Eight `MigrationTests` selectors, not five.** The first five are §5.5 items 1–5,
the new cases. The last three are the class's **existing** tests, which §5.5 item 6
keeps as-is — and a kept test that no gate names is a test the port can delete
without anything going red. Naming them here gives them the same fail-by-name
protection the new ones get. The count floor of **14** is those eight plus
`WriterTests`' six methods; raise it as §7 rows are added to this list, and raise it
with `WriterTests` if that class grows. (On a toolchain where the `test-results`
subcommand is unavailable, use
`xcrun xcresulttool get --legacy --format json --path "$RB"`, count
`ActionTestMetadata` entries and assert none has `testStatus == "Failure"` — the
same two properties.)

> **Since su-uzy9.6, B1 is automated** as `ios/scripts/gate-b1-app-tests.sh`, run
> by `.github/workflows/ios-app-gates.yml` on every push/PR that touches the App.
> The script is this block, with one deliberate change: the destination
> `platform=iOS Simulator,name=iPhone 16,OS=26.0` is **stale on `macos-26`**,
> which ships no iPhone 16 family device except the 16e — the lookup misses and
> the run dies at destination resolution before a test executes. The script
> resolves the device by name → UDID the way `capture-demo.sh` does. Do not
> "correct" it back to the literal above. Gate semantics — the selector list, the
> `$xc` gate, the count floor of 14 — are unchanged.

**B3 — the scheduled regression run, stated as a command.** §7 is a list of named
tests; this is the command that proves the list is real. Same shape as B1: one
`-only-testing` per §7 app-test row, so a row that was never written fails the
build by name instead of quietly not running.

```bash
set -uo pipefail   # not -e, for the same reason as B1

RB=/tmp/sual-regression.xcresult
rm -rf "$RB"

xcodebuild test \
  -project ios/ShutUpAndListen.xcodeproj \
  -scheme ShutUpAndListen \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=26.0' \
  -resultBundlePath "$RB" \
  -only-testing:ShutUpAndListenAppTests/FencingTests/testStaleGenerationReplyIsDropped \
  -only-testing:ShutUpAndListenAppTests/TTSSinkTests/testPlayerNodeReattachedAfterEngineRebuild \
  -only-testing:ShutUpAndListenAppTests/TTSSinkTests/testOnFinishedFiresOncePerClipAndNeverAfterStop \
  -only-testing:ShutUpAndListenAppTests/InjectionTests/testInjectedFixtureReachesConverterAndAdvancesClock \
  -only-testing:ShutUpAndListenAppTests/VADResetTests/testPauseClearsOnsetState \
  -only-testing:ShutUpAndListenAppTests/VADResetTests/testPauseClearsStaleVoiceTimestampAndFirstBufferIsFresh \
  -only-testing:ShutUpAndListenAppTests/ListenerSegmentTests/testPauseMidClipClosesListenerSegmentAtCut \
  -only-testing:ShutUpAndListenAppTests/InterruptionTests/testPauseParksPendingTurnMachine \
  -only-testing:ShutUpAndListenAppTests/AnalystFeedTests/testAnalystTickAndCandidateShareFinalizedBasis \
  -only-testing:ShutUpAndListenAppTests/RecoveryTests/testAdoptedOrphanRowIsRecoveredAndVisible \
  -only-testing:ShutUpAndListenAppTests/RecoveryTests/testOrphanSweepRunsAfterRecoveryGate \
  CODE_SIGNING_ALLOWED=NO
xc=$?
[ "$xc" -eq 0 ] || { echo "B3 FAILED: xcodebuild test exited $xc" >&2; exit 1; }

# All eleven §7 app-test rows, none failing.
xcrun xcresulttool get test-results tests --path "$RB" --format json \
  | jq -e '
      [.. | objects | select((.nodeType? // "") == "Test Case")]      as $cases
      | ($cases | map(select((.result? // "") == "Failed")) | length) as $failed
      | if ($cases | length) >= 11 and $failed == 0 then true
        else error("B3: \($cases | length) cases ran (expected >= 11), \($failed) failed")
        end' > /dev/null \
  || { echo 'B3 FAILED: result-bundle assertion' >&2; exit 1; }

echo "B3 OK — result bundle at $RB"
```

The selector list and the count floor are the §7 table's app-test rows, in order;
**both move together whenever a row is added there.** §7's package rows are not
here — they are `swift test` cases, proven at Stage 7, A2 and B2.

**B5 — the archive check, stated as a command with a log.** "Inspect the archive"
is not a gate: it is an instruction to look, it produces no artifact, and it is the
last thing anyone does at the end of a long day. B4 wrote an archive; this reads it
and exits nonzero.

```bash
set -uo pipefail   # pipefail is load-bearing: the body runs through `tee` below,
                   # and without it the pipeline would report tee's exit, not the
                   # check's. Not -e — every finding must be printed before exit.

ARCHIVE=/tmp/sual.xcarchive               # written by B4
LOG=/tmp/sual-b5-archive-check.log

check() {
  APP=$(find "$ARCHIVE/Products/Applications" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null)
  [ -n "${APP:-}" ] || { echo "B5 FAILED: no .app under $ARCHIVE/Products/Applications" >&2; return 1; }

  EXE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist" 2>/dev/null)
  BIN="$APP/${EXE:-}"
  [ -f "$BIN" ] || { echo "B5 FAILED: no executable inside $APP" >&2; return 1; }
  echo "B5 inspecting: $BIN"

  fail=0

  # 1. Neither capture fixture may ship — any name match, anywhere in the
  #    bundle. This is the check dead-stripping cannot fake: a resource is
  #    either copied into the bundle or it is not.
  hits=$(find "$APP" \( -name 'demo-conversation.wav' -o -name 'capture-fixture.json' \))
  if [ -n "$hits" ]; then
    echo "SECURITY: capture fixture present in the archived bundle:" >&2
    echo "$hits" >&2
    fail=1
  fi

  # 2. No capture-seam type names in the binary. Read the symbol table AND the
  #    raw strings: a Release binary is stripped of local symbols, but Swift
  #    type names survive in metadata/reflection sections, so `strings` sees
  #    what `nm` no longer does. Either hit is a failure.
  #
  #    Dump ONCE to a file and grep the FILE. Never `grep -q` a live producer
  #    here: `grep -q` exits at its first match and closes the pipe, the
  #    `nm`/`strings` producer then dies of SIGPIPE (141), and `pipefail` —
  #    load-bearing for the `tee` below — makes the whole pipeline nonzero. The
  #    `if` would take the *else* branch on a real hit, leaving `fail` unset, and
  #    B5 would print OK with the seam shipped. That is a fail-OPEN on precisely
  #    the condition this gate exists to catch. A file has no producer to kill,
  #    so the early exit is harmless. (Buffering into a shell variable does not
  #    fix it: `printf '%s' "$SYMS" | grep -q` re-creates the same pipe and the
  #    builtin takes the same EPIPE.)
  SYMS=$(mktemp "${TMPDIR:-/tmp}/sual-b5-syms.XXXXXX") \
    || { echo 'B5 FAILED: could not create the symbol-dump temp file' >&2; return 1; }
  { nm -a "$BIN" 2>/dev/null; strings -a "$BIN" 2>/dev/null; } > "$SYMS"

  # Both tools silent means the binary was not read at all — an unreadable
  # binary is indistinguishable from a clean one by grep alone, so fail closed
  # rather than reporting "no seam symbols found".
  if [ ! -s "$SYMS" ]; then
    echo "B5 FAILED: nm and strings both produced no output for $BIN" >&2
    rm -f "$SYMS"
    return 1
  fi

  for sym in CaptureSeam CaptureURLProtocol CaptureAudioInjector; do
    if grep -q "$sym" "$SYMS"; then
      echo "SECURITY: '$sym' found in the archived binary" >&2
      fail=1
    fi
  done
  rm -f "$SYMS"

  [ "$fail" -eq 0 ] || { echo 'B5 FAILED: archive is not clean' >&2; return 1; }
  echo 'B5 OK — no capture fixtures, no capture-seam symbols in the Release archive'
}

check 2>&1 | tee "$LOG"
```

**Attach `$LOG` to the PR (Stage 13).** A3's output and this log are the two halves
of the security row in §2 and in Risks — the setting and the artifact — and a
reviewer must be able to read both without a Mac.

Read the symbol half honestly: **absence is necessary, not sufficient.** Dead
stripping can remove a symbol that was compiled in, so a clean `nm`/`strings` does
not by itself prove the source was excluded — that is A3's job, and it is why the
two gates are not interchangeable. The resource check is the stronger of the two
halves here, and the one that fails loudly if the pbxproj merge dropped only the
`demo-conversation.wav` or `capture-fixture.json` entry from
`EXCLUDED_SOURCE_FILE_NAMES`.

> **Since su-uzy9.6, A3 and B5 are automated too** — `ios/scripts/gate-a3-release-exclusions.sh`
> and `ios/scripts/gate-b5-release-archive.sh` (which does B4's archive first), run
> together with B1 by `.github/workflows/ios-app-gates.yml`. Both assert exactly
> what these blocks assert. The one addition is B4's invocation: it is built **unsigned**
> (`CODE_SIGNING_ALLOWED=NO` plus emptied identity/team/profile/entitlements and
> `CODE_SIGN_STYLE=Manual`), since a signature changes neither the bundled
> resources nor the binary's symbols, and CI must not hold a team credential.
> `$LOG` moves from `/tmp` to `ios/build/gates/` so the workflow can upload it.

**Stage 13 — PR.** Body states: the §0.1 decision and its consequence for the visual
workflow; that `transcriptIsReconciled` and the reconciler/stitcher/file-transcriber
are deleted deliberately; the dropped auto-stop on `.ended(shouldResume: false)`
(§3.2); the migration's wall-clock→audio-time approximation (§5.3); and, if Stage 0
chose the dormant path, which §7 tests stand in for `capture-demo.sh`. Attach the
B1 and B3 result bundles, the A3 output, and the B5 archive-check log
(`/tmp/sual-b5-archive-check.log`) — A3 and B5 together are the reviewable evidence
for the security row, and neither is re-runnable by a reviewer without a Mac.

---

## 7. Scheduled regression coverage

Every behavior this plan restores by hand is a behavior a future edit can quietly
drop again — the port itself is the proof, since PR#37 re-introduced a
character-offset anchor the rewrite had already been written to remove (§4.2). Each
row below is a **named test the execution bead must write**, not a hope. "Where"
decides which gate can run it: package tests run headless (Stage 7), app tests need
the target wired (Stage 11) and run at B1 or B3.

**Every row names its selector**, because a gate can only run what it can name: B1
and B3 pass these identifiers to `-only-testing`, so a row that was never written
fails the build by name rather than quietly not running. The selector *is* the
contract — rename a method and you must rename it in the gate.

Two selector forms, because two runners: **app** rows are
`ShutUpAndListenAppTests/Class/method` for `xcodebuild -only-testing` (B1, B3);
**package** rows are `Target.Class/method` for `swift test --filter`, which takes a
regex over exactly that string (Stage 7, A2, B2). Both fail nonzero on a name that
matches nothing, which is what makes either one a gate.

| Test | Pins | Selector | Runs at |
|---|---|---|---|
| `stop-then-start across an in-flight reply drops the stale reply` | Generation-token fencing (§4.3) — the regression the rewrite's `isRunning`-only guards would reintroduce. Drive a reply completion whose `generation` is stale and assert nothing is appended. | `ShutUpAndListenAppTests/FencingTests/testStaleGenerationReplyIsDropped` | B3 |
| `finalizedText length is monotonically non-decreasing across volatile revisions` | The analyst drift anchor (§4.2 Edit 1). Feed a shortening volatile revision and assert the finalized length never decreases. | `TranscriptCoreTests.TranscriptStoreTests/testFinalizedTextIsMonotonic` | Stage 7, A2, B2 |
| `candidates still expire while volatile text churns` | The same defect one layer up: `CandidatePool.expire(currentPosition:)` fed from `finalizedText` keeps expiring. | `TurnEngineTests.CandidatePoolTests/testCandidatesExpireWhileVolatileChurns` | Stage 7, A2, B2 |
| `a PR#37-era blob's startMs/endMs decode into StoredEntry` | §5.3 part 1 item 1 — the optional fields exist and a base-era blob without them still decodes. | `TranscriptCoreTests.StoredEntryTests/testStoredEntryDecodesPR37Timings` | Stage 7, A2, B2 |
| `segments(from:) maps startMs/endMs onto audioStart/audioEnd` | §5.3 part 1 item 2 — the ÷1000 conversion, and zeroed ranges when the entry carries no timings. | `TranscriptCoreTests.StoredEntryTests/testSegmentsFromEntriesCarryTimings` | Stage 7, A2, B2 |
| `StoredEntry.init(_:) writes the timings back` | §5.3 part 1 item 3 — the export DTO round-trips instead of flattening new records; assert `storedEntries(from:)` → `segments(from:)` preserves the ranges. | `TranscriptCoreTests.StoredEntryTests/testStoredEntryRoundTripsTimings` | Stage 7, A2, B2 |
| `analyst tick and the gate's candidate lookup share one finalized basis` | §4.2 Edit 3 — the host-level proof of the seam. Drive a shortening volatile revision, then assert both `tick`'s transcript and `candidate(for:transcriptLength:)`'s length come from `cachedFinalizedText` and are equal at the same instant. Fails on the mixed-basis reading, which is the whole hazard. | `ShutUpAndListenAppTests/AnalystFeedTests/testAnalystTickAndCandidateShareFinalizedBasis` | B3 |
| `pause parks the pending turn machine` | §3.2 — the third of the five things main's `.began` did. Open a turn, drive `onState` → `.paused`, and assert the machine is parked (silence decision + `dropTurn`) rather than left holding a `pending`/`deciding` turn across the gap. | `ShutUpAndListenAppTests/InterruptionTests/testPauseParksPendingTurnMachine` | B3 |
| `orphan sweep runs after launch recovery` | §1f — the two launch sweeps are not commutative. Assert `adoptOrphanedRecordings` observes a completed `RecoveryGate`, so a CAF remuxed by `recoverIncompleteSessions` is never adopted a second time as an orphan. | `ShutUpAndListenAppTests/RecoveryTests/testOrphanSweepRunsAfterRecoveryGate` | B3 |
| `TTS player node is re-attached after an engine rebuild` | §3.3 — the silent-companion failure after a route change or media-services reset. Drive `CaptureController`'s rebuild path and assert `ttsFormat != nil` and the node is attached to the live engine afterwards. | `ShutUpAndListenAppTests/TTSSinkTests/testPlayerNodeReattachedAfterEngineRebuild` | B3 |
| `injection feeds the canonical converter` | §2 — injected fixture audio must reach the recording sink, the analyzer, the VAD, **and** advance the fed-samples clock. Assert a `TranscriptSegment` with a non-zero `audioStart`/`audioEnd` after injecting the fixture. **This is the standing substitute for `capture-demo.sh` (B6) if Stage 0 chose the dormant path** — without it, the injection seam ships with no coverage at all. | `ShutUpAndListenAppTests/InjectionTests/testInjectedFixtureReachesConverterAndAdvancesClock` | B3 |
| `pause/resume clears half-formed onset` | §3.2a item 1 — assert `inSpeech`/`speechBufferRun` are cleared across a pause so post-resume speech starts a fresh turn. | `ShutUpAndListenAppTests/VADResetTests/testPauseClearsOnsetState` | B3 |
| `pause/resume clears the stale voice timestamp, before the first buffer` | §3.2a items 1 and 3 — the half that state-only assertions miss. Assert `lastVoiceMs == 0` after the pause, so the hangover timer cannot fire against a pre-gap voice timestamp; then feed **one** buffer after resume and assert it is evaluated against already-reset state (`inSpeech == false`, `speechBufferRun == 0`, `lastVoiceMs == 0` on entry) — that is the `resetVADOnNextBuffer` ordering, and it is what makes the audio thread the only writer. A reset applied *after* that first buffer passes an `inSpeech`-only test and still decides the first post-interruption turn on stale evidence. | `ShutUpAndListenAppTests/VADResetTests/testPauseClearsStaleVoiceTimestampAndFirstBufferIsFresh` | B3 |
| `pause mid-clip closes the listener segment at the cut point` | §3.2b — assert the open listener segment is closed, `bargedIn == true`, `audioEnd` at the cut, before the park. | `ShutUpAndListenAppTests/ListenerSegmentTests/testPauseMidClipClosesListenerSegmentAtCut` | B3 |
| `recovered orphan row is visible` | §1b — assert `adoptOrphanedRecordings` produces `state == "recovered"` and that the row survives `LibraryView`'s `state != "recording"` predicate. | `ShutUpAndListenAppTests/RecoveryTests/testAdoptedOrphanRowIsRecoveredAndVisible` | B3 |
| `onFinished fires exactly once per clip, never after stop()` | §1c — the reasoning behind the dropped `didCancel` addition, carried forward as a test rather than as code. | `ShutUpAndListenAppTests/TTSSinkTests/testOnFinishedFiresOncePerClipAndNeverAfterStop` | B3 |
| `migration carries PR#37 timings` + agreement + base-shape negative + `costUSD` + PR#37-shaped V1 fixture | §5.3, §5.5 items 1–5 — the data-safety set. | `ShutUpAndListenAppTests/MigrationTests/` + the five method names listed in B1 | B1 |

Class homes are chosen so each gate selects whole coherent groups: `MigrationTests`
and `WriterTests` are the data-safety gate (B1); `FencingTests`, `TTSSinkTests`,
`InjectionTests`, `VADResetTests`, `ListenerSegmentTests`, `InterruptionTests`,
`AnalystFeedTests` and `RecoveryTests` are the regression gate (B3). **Adding a row here means adding its selector to B1's or
B3's `-only-testing` list and raising that command's count floor** — the two move
together, or the gate silently stops covering the new row. **If the visual-capture
workflow is dormant (§0.1 option b), the `injection` and `TTS rebuild` rows are not
optional** — they are the only remaining coverage of the seam `capture-demo.sh`
would have exercised, and B7's manual pass is the only other check on either.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The silent set survives the merge — dead reconciler/stitcher/file-transcriber compile fine and ship | **High** | Stage 2 is explicit and early; §1b grep list worked to zero |
| `project.pbxproj` merge drops `EXCLUDED_SOURCE_FILE_NAMES` → capture seam ships in Release | **High (security)** | Stage 4 by hand; **A3 reads the resolved Release setting** right after, and again after Stage 11; B5 archive inspection as the second mechanism |
| Migration drops `startMs`/`endMs` silently → replay permanently dead for PR#37-era sessions | **High (data)** | §5.3 **part 1 (Stage 3) AND part 2 (Stage 8)** — part 1 alone changes nothing, because the migration runs `materializeLegacySegments`, not `segments(from:)`; proven at B1 through the real migration plan |
| The app-test gate is green without running anything | **High** | B1 and B3 run `-only-testing` at method granularity (fails outright if a case is absent), gate explicitly on the `xcodebuild` exit status, and assert case counts with zero failures from the result bundle; `⌘U` is explicitly not the gate |
| **The migration never runs** — the app-entry merge keeps main's `.modelContainer(for:)`, which cannot carry a migration plan | **High (data)** | §1f + Stage 8's checklist. Note honestly that **B1 does not catch this**: it seeds and reopens the store through `SessionMigrationPlan` directly, so it proves the stage, not that the app installs it. B8 (upgrade install) is the only end-to-end check |
| App-entry merge silently drops the capture-seam arming, the talk-first root, or the scene-phase policy | **High** (seam) / Medium (UX) | §1f checklist on Stage 8. The Release half of the seam is covered by A3 + B5; the **Debug** arming and the root view have no automated check by construction — they are checklist items, which is why they are enumerated per line rather than described |
| Both launch sweeps race → duplicate "Recovered recording" rows | Medium (data) | §1f ordering rule; `RecoveryTests/testOrphanSweepRunsAfterRecoveryGate` at B3 |
| Turn machine holds an open turn across an interruption | Medium | §3.2, in the Stage 5 checklist; `InterruptionTests/testPauseParksPendingTurnMachine` at B3 |
| `costUSD` dropped from V2 | Medium (data) | §5.2 + B1 |
| Generation fencing regressed to `isRunning` | Medium | §4.3, in the Stage 5 checklist; §7 `stop-then-start…` test at B3 |
| iOS 26 vs Xcode 16 discovered late | Medium | Stage 0's ruling **and its SDK probe**, both before any code is written; Gate A1 confirms it against the assembled port |
| Analyst candidates stop expiring on volatile churn | Medium | §4.2 finalized-text anchor; §7 monotonicity + expiry tests, headless at Stage 7 |
| Analyst basis mixed — one call site on `finalizedText`, the other on `fullText` | Medium | §4.2 Edit 3 moves both sites together; `AnalystFeedTests/testAnalystTickAndCandidateShareFinalizedBasis` at B3 fails on exactly this |
| VAD state survives an interruption → first post-resume turn decided on stale evidence | Medium | §3.2a — the reset is CaptureController's (Stage 6), via the `proveResumeOnNextBuffer`-style flag; §7 test; B7 |
| Pause mid-clip persists unspoken words as spoken | Medium (data) | §3.2b — `closeOpenListener(bargedIn: true)` in the Stage 5 checklist; §7 test |
| Recovered orphan rows land in `recording` state and are invisible in the library | Medium | §1b — explicit `state: .recovered`; the V2 init's default is the trap; §7 test |
| TTS player node not re-attached after engine rebuild → silent companion | Medium | §3.3; §7 rebuild test at B3; B7 |
| `OnboardingView` merge (both sides restructure page flow) | Medium | Stage 9, last of the code stages, unhurried |
| Migration is untestable until the target is wired | Medium | Stage 11 before B1 |
| Injection seam ships uncovered because the visual workflow is dormant | Medium | §7 `injection feeds the canonical converter` is mandatory under §0.1 option (b) |

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
   answer only changes how loudly B8 (upgrade install) needs to be exercised.
