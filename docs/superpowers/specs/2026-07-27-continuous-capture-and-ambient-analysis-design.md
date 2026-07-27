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

### 1. Recording + transcription as one standalone primitive

Today capture, VAD, and STT are split across `AudioPipeline` and
`SpeechTranscriber`, and the transcript they produce is consumed directly as
*both* the live display and the saved record. Reframe this as a self-contained
**voice recorder with real-time transcription** — a primitive that does one job
and does it reliably, with no notion of turns or interjections. It exposes:

- **Continuous audio → `.m4a`** (ground truth; already reliable).
- **One growing, seamless real-time transcript** with timestamps.
- **Raw VAD signals** (speech-start / speech-end, level).

Two clarifications the first draft muddied:

- **"Recognition task" is an internal STT detail, not a product concept.**
  `SFSpeechRecognizer` has an Apple duty-cycle limit (~1 min), so the primitive
  rotates its recognition task internally and stitches the results into one
  continuous transcript. Consumers never see the rotation, and it has nothing to
  do with when the listener comments. To keep the live transcript from dropping
  words across a rotation, the primitive replays a short tail of buffered mic
  audio into the replacement task and rotates a beat *before* the hard limit —
  but this is a cosmetic concern for the live view only (see next point).
- **The saved transcript is derived from the audio file, not the live stream —
  so there is no "keep the longer string" heuristic.** The live transcript is
  best-effort: it may revise a word in-flight as recognition refines (normal
  dictation behavior). On session end, the primitive re-transcribes the
  finalized `.m4a` with a file-based `SFSpeechURLRecognitionRequest` (no
  duty-cycle gaps, stable, timestamped) to produce the **authoritative** saved
  transcript. A longer-but-wrong live string is never promoted; the file is the
  source of truth. Fail-safe and resumable: the live transcript is saved first
  so nothing is lost if reconciliation fails or the app is killed; it is
  *upgraded* to the file-derived transcript when the pass completes, and a
  session whose reconciliation didn't finish re-runs it on next open. Segments
  map onto the turn timestamps the machine already records (`startMs`/`endMs`)
  so speaker attribution and **tap-to-seek** in `SessionDetailView` survive;
  listener (TTS) lines are inserted from what we synthesized (they're not in the
  mic `.m4a` — the AEC removes our own speech). Long recordings are chunked and
  stitched if the file request has a duration cap. The record carries a flag
  distinguishing a live vs. reconciled transcript.

The primitive alone satisfies "reliably record, transcribe, and play back
everything"; the live transcript's only job is responsiveness.

### 1a. What triggers a "turn" (the layer above the primitive)

"Turn" and "interjection" belong to the **consumer** of the primitive, not the
recorder. A turn is not a fixed interval and not a raw silence event — it is the
existing pure `TurnDetector`: a turn ends when VAD reports silence **and** a
patience window (seconds) elapses **and** the completeness heuristic reads the
thought as finished; if the thinker resumes, the turn stays open. So turns are
*silence-driven with a patience floor and a completeness gate* — the recorder
just emits the raw signals the detector reduces. This logic is unchanged; the
reframe only makes the boundary explicit so the recorder can be built and tested
on its own.

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
- **Reprocess the whole transcript, kept cheap by prompt caching.** Each cycle
  re-sends the whole conversation so far (simplest correct thing). The transcript
  grows only at the end, so it's a stable prefix — mark it with a `cache_control`
  breakpoint and each subsequent cycle reads the prior prefix from cache (~0.1×
  input cost) instead of re-billing it. `ClaudeClient` must gain `cache_control`
  support (it sends none today, `ClaudeClient.swift:120-125`). Caveats to honor:
  Opus 4.8's minimum cacheable prefix is ~4096 tokens, so short early
  conversations won't cache (that's fine — they're cheap); and the cached prefix
  must stay byte-identical, so the volatile "what should the hint be right now"
  instruction goes *after* the breakpoint. A future optimization (out of scope
  now) is compaction/summary for very long sessions so the prefix doesn't grow
  unbounded — noted as a known follow-up.

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
  speaks only real reflections/questions unless opted in. This isn't just a
  preference: `prompts/CLAUDE.md` (the listener's own role) *explicitly forbids*
  minimal acknowledgments — "no minimal acknowledgments ('yeah', 'mm', 'right')
  — they are noise against a train of thought." The spoken backchannel
  contradicts the app's stated behavior; turning it off aligns them. Fix a
  subtlety: even when silent, the gate still *records* the acknowledge decision
  for question-cooldown bookkeeping (today it rewrites it to `.silence`,
  distorting spacing — `SessionController.swift:651-655`).
- **"Pull a thread" always asks.** The invited path speaks the top *question*
  candidate immediately, or force-generates one with a dedicated instruction:
  "You were explicitly asked to pull a thread; ask ONE specific question anchored
  to what they've said. If genuinely too little has been said, say that plainly —
  never tell them to take their time." No inherited restraint, no deferral, no
  silent empty reply.

### 5. Debug: per-conversation cost

A developer-facing cost readout so usage can be tracked as the analyst adds
recurring model calls.

- **Capture usage per call.** `ClaudeClient.MessagesResponse` currently decodes
  only `content` + `stop_reason` (`ClaudeClient.swift:176-189`); add the `usage`
  block (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`). Every model call in a session — analyst cycles,
  reflections/questions, pull-a-thread, coverage — reports its usage to a session
  cost accumulator.
- **Compute cost.** Opus 4.8 pricing: input $5 / output $25 per 1M tokens; cache
  *write* 1.25× input ($6.25/1M), cache *read* 0.1× input ($0.50/1M). Cost =
  `(input·5 + cache_write·6.25 + cache_read·0.50 + output·25) / 1e6`. Prices live
  in one constant so they're easy to update.
- **Surface it.** A running tally while a session is live *and* a final figure on
  the saved record, behind a debug toggle (off in normal use). Exact when usage
  is available; labeled approximate otherwise.
- **Proxy caveat.** Exact numbers require token usage in the response. The dev-key
  `ClaudeClient` path has it directly; the account **proxy** path
  (`AccountStore.makeListenerService`) must also surface usage, or the tally is
  dev-key-only until the proxy passes it through. Flagged as a dependency, not
  solved here.

## Preserved behavior

Coverage-mode checklist, session modes, and the question haptic are unchanged.
**Just-listen** disables the *speaking* of hints and interjections but **still
shows the on-screen hints** — the mode means "don't talk to me," not "go dark."

## Tradeoffs (accepted)

- **Cost/usage.** The analyst means periodic model calls *during* a session, not
  just rare interjections. Rate-limiting, prompt caching of the transcript
  prefix, and the candidate pool (no fresh call at each spoken pause) keep it
  modest, but it is more usage than today and requires the account/proxy (or dev
  key). The §5 cost readout exists so this stays visible.
- **Privacy.** Analysis sends transcript to the proxy/model more often than
  today's rare reflections — same data path, higher frequency. Audio never
  leaves the phone.

## Out of scope

- Replacing `SFSpeechRecognizer` with a different STT engine (e.g. a
  Whisper-class model). The recorder primitive (live best-effort + file-derived
  authoritative transcript) meets the reliability principle without a new
  dependency.
- Compaction/summarization of very long transcripts to bound the analyst's
  cached prefix — a known follow-up once long sessions are common.
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
