# Continuous capture, reliable transcript, and an ambient analysis brain

**Date:** 2026-07-27
**Branch:** `claude/ios-app-evaluation-wre62e`
**Status:** Design approved — ready for implementation plan

## Problem

Field feedback on the iOS app surfaced two classes of problem.

**Minor bugs / behavior:**

1. The first spoken reply in a session is a filler grunt ("mhn").
2. The live transcript on the session screen shows almost nothing — one head-truncated line that resets on pauses.
3. "Pull a thread" sometimes returns a deferral ("that's fine, take your time…") instead of a question.
4. The listening ring's constant motion is annoying.

**One structural issue:**

5. The saved transcript drops text that was shown live, while the audio recording is complete.

### Root causes (verified in code)

- **"mhn" (1):** the gate's *acknowledge* rung speaks a rotating backchannel
  (`["mm","yeah","mhm","right","mm-hm"]`, `ResponseHierarchy.swift:40,234`) and
  `speakAcknowledgments` defaults to `true` (`SessionController.swift:109`). The
  first short pause of a session triggers a spoken grunt. No warm-up concept.
- **Tiny/resetting text (2):** the live screen shows only `lastThinkerLine`,
  one line, `.lineLimit(1)`, head-truncated (`SessionView.swift:320-343`). Each
  turn is a new transcript entry, so a turn boundary resets the peek. Full text
  is hidden behind a tap.
- **Pull-a-thread deferral (3):** `askNow()` sends a `.question` request with the
  restraint-heavy listener prompt (`SessionController.swift:735-752`); with little
  or ambiguous content the model performs patience instead of asking.
- **Obnoxious ring (4):** `PatienceRing` runs perpetual breathing + a drifting
  shimmer at 20fps whenever the session is live (`PatienceRing.swift:51-96`).
- **Dropped transcript (5):** the transcript is a lossy real-time derivative of
  `SFSpeechRecognizer` used for *both* live turn-taking *and* the saved record,
  never reconciled against the ground-truth `.m4a`. It loses text two ways:
  - **Restart seam** (`SpeechTranscriber.swift:114-123`): on a task's final
    result or duty-cycle death, `request = nil` and a new task starts; buffers
    arriving on the audio thread during the hop are dropped.
  - **Final shrinks the partial** (`:107-109,128-135`): `SFSpeechRecognizer`'s
    final `bestTranscription` is often shorter/re-segmented than the partials it
    already streamed; committing the final overwrites words already shown.

The `.m4a` recording is already continuous and complete
(`AudioPipeline.startRecording` / `process`), so half the core principle —
"reliably record" — already holds. The gap is that transcription for turn-taking
and the authoritative transcript of what was said are the same lossy object.

## Design

### 1. Transcript reliability — two tiers

**Live tier** (drives display + turn-taking), patched so it stops losing text:

- **Close the restart seam.** Keep a small ring buffer of the most recent mic
  buffers. When a recognition task ends, start the replacement task *and replay
  the buffered tail* into it, so words spoken during the handoff are not lost.
- **Never shrink.** When a final `bestTranscription` is shorter/re-segmented than
  the partial already shown, commit the *longer* of the two. Displayed text only
  grows within an utterance.
- **Proactive rotation.** Rotate the task a few seconds *before* the duty-cycle
  limit rather than waiting for the abrupt cutoff, so the seam is predictable.

**Authoritative tier** (the saved record), reconciled from ground-truth audio:

- On session end, run a file-based `SFSpeechURLRecognitionRequest` (on-device)
  over the finalized `.m4a`. No live duty-cycle gaps; results carry per-segment
  timestamps.
- Map segments back onto the turn timestamps the machine already records
  (`startMs`/`endMs` per turn) so speaker attribution and **tap-to-seek** in
  `SessionDetailView` survive. Listener (TTS) lines are inserted from what we
  synthesized at their recorded timestamps — they are not in the mic `.m4a`
  because the AEC removes our own speech.
- **Fail-safe & resumable.** The record is saved with the live transcript first
  (nothing lost if reconciliation fails or the app is killed), then *upgraded*
  to the reconciled transcript when the pass completes. A session whose
  reconciliation did not finish re-runs it on next open. If the on-device file
  request has a duration cap, long recordings are chunked and stitched.
- The record carries a flag distinguishing a live vs. reconciled transcript.

### 2. The reflective analysis — one brain, two surfaces

A new background `ConversationAnalyst` maintains a single live understanding of
the whole conversation and, from it, a small **ranked pool of ready-to-speak
candidate interjections**.

- **Candidate pool.** Up to ~3 candidates, each: short, anchored to something
  specific the thinker actually said, and tagged by register (reflection vs.
  question). Each candidate is stamped with the transcript position it was
  formed against.
- **Cadence (the deliberate faculty's trigger).** The analyst has no pause to
  fire on, so: recompute after each *finished substantive turn*, debounced by a
  short silence and rate-limited to a minimum interval (~20–30s). It always
  analyzes the *whole* transcript, not the fragment since the last run.
- **Screen surface.** The top 1–2 candidates surface as silent, quietly-updating
  **hints** — the reward for a glance. Adaptive in content: a thread to pull, a
  noticed tension, a "you haven't said why yet" — whatever fits *now*.
- **Voice surface.** When the reactive gate (unchanged in *when* it fires) hits a
  good pause and decides to speak a reflection/question, it **picks the
  best-fitting still-fresh candidate from the pool and speaks it immediately** —
  no cold model call at the moment of the pause. What is heard is exactly what
  was already on screen, and the interjection lands fast instead of after a
  round-trip.
- **Freshness.** A candidate is speakable only while still relevant; it is
  expired once the thinker has clearly moved past what it was anchored to. If the
  gate wants to speak but nothing fresh fits, fall back to a single live model
  call (today's behavior — the safety net), or silence when offline. **The pool
  is an optimization + coherence layer, never a correctness dependency.**
- **Graceful degradation.** No account / offline / signed-out simply leaves the
  hint empty and the pool cold; the screen-free experience and the fallback
  spoken path are unaffected.

### 3. Live screen — transcript is the stage

- The scrolling, accumulating transcript becomes the main view: thinker text
  flowing continuously, auto-scrolling, **never resetting per turn**; listener
  lines styled distinctly inline. This replaces the one-line peek + tap-to-open
  duplication.
- A persistent, quietly-updating **hint line** sits with the transcript (the
  glance reward). The most-recent spoken response is also visible.
- **Patience indicator:** a small, calm element that is inert and invisible
  during normal talking and only animates — gently — while a pause is actually
  being timed (`patienceProgress != nil`). No perpetual breathing, no 20fps
  shimmer.
- Start/stop and "pull a thread" stay as bottom controls. The staged question
  moment (`QuestionCard`) + haptic are preserved.

### 4. Behavior fixes

- **Acknowledgments off by default.** `speakAcknowledgments = false`. The listener
  speaks only real reflections/questions unless opted in. Fix a subtlety: even
  when silent, the gate still *records* the acknowledge decision for
  question-cooldown bookkeeping (today it rewrites it to `.silence`, distorting
  spacing — `SessionController.swift:651-655`).
- **"Pull a thread" always asks.** The invited path speaks the top *question*
  candidate immediately, or force-generates one with a dedicated instruction:
  "You were explicitly asked to pull a thread; ask ONE specific question anchored
  to what they've said. If genuinely too little has been said, say that plainly —
  never tell them to take their time." No inherited restraint, no deferral, no
  silent empty reply.

## Preserved behavior

Coverage-mode checklist, session modes, and the question haptic are unchanged.
**Just-listen** disables the *speaking* of hints and interjections but **still
shows the on-screen hints** — the mode means "don't talk to me," not "go dark."

## Tradeoffs (accepted)

- **Cost/usage.** The analyst means periodic model calls *during* a session, not
  just rare interjections. Rate-limiting keeps it modest, but it is more usage
  than today and requires the account/proxy (or dev key). The candidate pool
  partly offsets this by avoiding a fresh call at each spoken pause.
- **Privacy.** Analysis sends transcript to the proxy/model more often than
  today's rare reflections — same data path, higher frequency. Audio never
  leaves the phone.

## Out of scope

- Replacing `SFSpeechRecognizer` with a different STT engine (e.g. a
  Whisper-class model). The two-tier + reconcile approach meets the reliability
  principle without a new dependency.
- Changes to the pure `TurnDetector` state machine's timing logic. The reactive
  gate fires *when* it fires today; only the *source* of the spoken reply (pool
  vs. cold call) changes.

## Success criteria

- Nothing shown in the live transcript is missing from the saved transcript.
- Saved transcript tap-to-seek still lands on the right audio position.
- The first thing a session ever speaks is never a filler grunt.
- Glancing at the screen mid-session shows a meaningful, current hint.
- A spoken interjection matches a hint that was already on screen.
- "Pull a thread" always produces a specific question or an honest "not yet."
- The session screen has no perpetual motion while the thinker is talking.
