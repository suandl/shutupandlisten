# iOS product evaluation — from "interesting idea" to "must-have"

Working notes for the `claude/ios-app-evaluation-wre62e` branch. Five independent
evaluations were run against the iOS app (a UX teardown, a data-value
strategy pass, a scenario expansion, a platform-leverage scan, and a
"less is better" edit), their findings were synthesized into a roadmap, and
the roadmap's first three waves were implemented on this branch. This
document is the record of the diagnosis, what changed, what is deliberately
still a mockup, what was rejected, and what comes next.

## The verdict

All five reports converged on one diagnosis: **the engine is a
differentiated product; the app dressed it as its own test harness.** The
turn machine's provable restraint — silence and acks answered by rules at
zero cost, the model asked (and free to decline) before it ever speaks, one
earned anchored question — is a real moat. The app around it read as a
working proof, not a want. Specifically:

- **Harness, not product.** The leading toolbar slot of the live screen
  opened tuning sliders ("Completion threshold … 0.50 P"); Settings offered a
  proxy URL, an `sk-ant-…` field, an A/B baseline-arm toggle, and a
  monospaced checklist editor. A new user was exposed to roughly 19 concepts;
  the product needs 4 (talk, it waits, one question, it's kept).
- **The magic was buried.** The patience window — the single most
  differentiated thing the product does — was a stock 4-pt progress bar next
  to a footnote label, while the commodity transcript owned 80% of the
  screen. The payoff question arrived as one more chat bubble labeled
  "Listener · thread-pull" (internal jargon), with no staging, no haptic, in
  a stock TTS voice. Five colored state dots blinked like a mixing desk.
- **Trust gaps that kill the core scenario.** No background audio mode: the
  defining use case — long silent pauses, phone untouched — ended at
  auto-lock. No interruption handling: a phone call meant silent data loss.
  Persistence ran only on manual stop, so a crash lost the transcript. The
  entitlements file was empty despite claiming Sign in with Apple. Skipping
  sign-in armed a time bomb: the user's first payoff moment was replaced by
  an error dialog mentioning API keys.
- **A filing-cabinet library.** Timestamps existed everywhere in the live
  pipeline and were thrown away at save, foreclosing audio↔transcript sync.
  The listener's one question — the session's crown jewel — appeared nowhere
  in the library. Export was a raw Markdown string with nothing
  machine-readable. Search matched the listener's words as readily as yours.

## What this branch changes (landed, verified against the diff)

### Trust and survival
- `UIBackgroundModes = audio` in both app-target configs: sessions survive
  lock and backgrounding.
- Full `AVAudioSession` handling: interruptions (call/Siri/alarm) park the
  session and auto-resume or auto-finalize; route loss (AirPods case shut)
  and media-services reset fall back to the built-in mic. A published
  `isInterrupted` drives a calm on-hold state.
- Crash-safe checkpoints: the record is upserted to SwiftData on
  interruption, on backgrounding, and every ~30 s. On launch,
  `SessionRecovery` adopts orphaned recordings as playable "Recovered
  recording" records.
- Idle timer disabled while a session runs; scene-phase aware.
- The Sign in with Apple entitlement actually exists now, and errors are
  typed (`accountRequired` / `signInExpired` / `general`): the first model
  escalation without an account presents a sign-in sheet, not an alert about
  API keys.

### The live experience
- **Talk-first root**: the app opens into the session screen; library and
  settings moved behind toolbar icons. Ending a session lands on the saved
  record's detail view — the artifact is the second act, not a 2.2-second
  toast.
- **The patience ring is the hero** (`PatienceRing.swift`): a breathing ring
  in one warm accent whose glow answers the mic level and whose fill is the
  patience window; resumed speech dissolves it. Three lowercase state words
  replace the five-color taxonomy; the dB meter and tier labels are gone.
- **A staged question moment** (`QuestionCard.swift`): gentle haptic, a card
  that stays pinned until you resume. The transcript collapses to a one-line
  peek with a full-text sheet behind it.

### Data value
- Per-utterance `startMs`/`endMs` on `StoredEntry` (backward compatible —
  old records decode with nils and degrade gracefully).
- `openQuestion` accessor: the detail view headlines "The question you left
  with" (with answered/still-open state); library rows lead with the
  question snippet.
- Tap-to-seek between transcript and audio; audio itself is now shareable.
- Richer Markdown export: YAML frontmatter (title, date, duration, criteria,
  open question), `[mm:ss]`-stamped entries, a closing open-question block —
  Obsidian-paste clean.
- Library search matches thinker utterances only, never the listener's.

### Modes and scenarios
Per the scenario report's conclusion — don't fork the listener; configure it:
- `SessionMode` (open / rehearsal / debrief) as prompt tints on the one base
  prompt. `.open` is byte-identical to the shipped prompt, test-pinned. The
  mode is chosen before a session and frozen at start — never inferred, never
  switched mid-thought.
- **Just listen**: a questions-off toggle. The gate deterministically caps
  every uninvited turn at a quiet acknowledgment — no model call can slip
  through; Pull a thread still works because you invited it. It quietly
  serves journaling, morning pages, and venting without naming any of them.
- Six named coverage presets (decision, weekly retro, standup prep, Feynman
  study, pitch rehearsal, sales-call debrief) fixing coverage mode's blank
  cold start. A preset may *suggest* its paired mode; it never sets it
  silently.
- Kit suite: 61 tests green on Linux (42 baseline + 19 new).

### Simplification
- **Developer gate**: BYOK key, proxy URL, the acknowledgments toggle, the
  tuning sliders (including the baseline-arm toggle), and replay-onboarding
  are hidden until the Settings version row is tapped five times.
- Coverage checklist became a preset picker; the free-text editor survives
  behind "Custom".
- Onboarding trimmed to promise → patience demo → permission ask; the
  account page is cut (sign-in is contextual at first escalation).
- A static privacy panel states — verbatim-checkable against `server/API.md`
  and the code — exactly what leaves the device and when.

### Shortcuts (in flight)
App Intents — start/stop a session and pull a thread, exposed to Siri,
Shortcuts, and the Action button via an `AppShortcutsProvider` — are landing
under `ios/App/Intents/` in a parallel work stream on this branch. Not yet
in the tree at the time of writing; treat this section as a pointer, not a
claim.

## Mocked up for discussion (`ios/mockups/`)

Four self-contained HTML mockups plus an identity proposal ("night paper &
ember": one accent reserved for what the listener does; the patience ring as
the brand mark at every size, from 284-pt hero to 7-pt list marker):

1. **Session screen** — informed the landed redesign above.
2. **Live Activity / Dynamic Island** — session presence on the lock screen,
   with an annotated ActivityKit update-budget contract (transitions only,
   no push channel).
3. **Threads** — a library lens clustering sessions by recurrence, each
   thread led by its latest open question; "Continue this thread" resume;
   ask-your-library answering in verbatim quotes with seek-to-play.
4. **Idea page** — nothing generated unless asked; extractive-leaning
   cleaned prose in the thinker's voice, every paragraph timestamp-cited;
   next actions only from imperatives actually said, confirm-only into
   Reminders.

`ios/mockups/README.md` carries the open questions that should be settled
before these become code — among them: does a filling ring read as a
countdown to interruption (pause-pressure, the exact anti-goal)? How loud
may the question moment be on the tenth session? Should the lock screen show
your own words? What exactly does resume "remember," and how do you
unremember? Who owns keeping the idea page on the right side of the
no-summarize line? Does the staged moment deserve a better voice than stock
TTS?

## Evaluated and rejected

- **Grief / therapy as named modes.** Naming them makes a therapeutic claim
  the product must not make; one badly aimed anchored question into grief is
  real harm (and a screenshot that ends the product). The just-listen toggle
  serves the need without the label. Crisis-resource copy in Settings is the
  responsible ceiling.
- **Mock-interview simulation.** Multi-question back-and-forth is the
  "interview, not dictation" failure mode the prompt forbids by name.
  Rehearsal mode stays one question per run-through.
- **Language practice.** The user wants correction and volume; restraint is
  a bug there.
- **Live meeting transcription/notes.** The speaker isn't addressing the
  app; no landing, no thread-pull recipient; commodity repositioning.
- **CarPlay.** Entitlement approval doubtful; the driving scenario is really
  background audio + intents + Bluetooth, all covered elsewhere.
- **TipKit.** Not worth the surface.
- **Push notifications — any push channel, ever.** The post-session premise
  is pull, not push ("you've circled this 4 times" is a label you find,
  never a ping). This also keeps Live Activities honest: local updates only.
- **Server-side memory** (transcript storage, server embeddings). The proxy
  stays a dumb metered pipe; statelessness *is* the privacy feature.
- **Chatty auto-summaries.** Summarizing is the product's sworn enemy
  (`no-summarize` judge); anything derived is the user's own words
  re-presented, or generated only on explicit request.
- **Live mode inference.** Never infer or switch the listener's voice
  mid-session; post-session artifact *offers* are the safe place for
  inference. Deferred (not rejected): Apple Watch, memoir/oral-history,
  CloudKit-later.

## Recommended next moves, in order

**Caveat that governs everything below: nothing on this branch has run on a
device or simulator.** The Kit's 61 tests pass on Linux; every App-target
file is `swiftc -parse`-checked only. Background continuation, interruption
recovery, AirPods routing, haptic feel, ring animation, and the
sign-in-entitlement fix are all device-only claims until proven.

1. **Device validation pass (S, blocking).** Build, sign, and run: lock-screen
   continuation, a real phone-call interruption, checkpoint recovery after a
   kill, the permission flow, the ring's feel (including the ring-vs-bar
   pause-pressure question), Sign in with Apple end to end.
2. **Live Activity widget extension (M–L).** The trust story made visible:
   session presence on the lock screen and Dynamic Island. Needs a new
   widget-extension target and a shared `ActivityAttributes` module; follow
   the mockup's update-budget contract. Only honest once #1 confirms
   background audio.
3. **Threads + resume (M–L).** On-device `NLEmbedding` vectors + shared
   `criteriaText` clustering; a Threads lens led by open questions; resume
   seeds prior context into the existing `/v1/listener` history (mind the
   200-message/200 KB caps; prompt must forbid opening recaps). The
   compounding moat — this is what a recorder or a chatty journal can't copy.
4. **On-device Foundation Models for coverage (M; iOS 26 + Apple
   Intelligence hardware).** `@Generable` guided generation replaces the
   proxy's structured-output coverage call — offline and free, reserving
   Claude for thread-pulls. Also the local path for the idea page.
5. **iOS 26 SpeechAnalyzer (M).** Purpose-built long-form dictation: removes
   the SFSpeech duty-cycle restart seam (a known source of dropped/duplicated
   words) and adds timestamps as EOU evidence. Clean adapter seam behind
   `#available(iOS 26, *)`.
6. **CloudKit sync (M).** After the entitlement story is device-proven.
   Audio won't sync; records will. Not on the capture critical path.

Close behind: AirPods HFP mic + haptic pre-cue (S–M, needs device A/B of HFP
capture quality vs. SFSpeech), the idea page (`/v1/distill`, coverage-shaped
and stateless, or on-device via #4), asset catalog + app icon from the
identity spec (S), and folder-sync export for the PKM crowd (S–M).

The one-line strategy stands: the live session's product is restraint; the
library's product is memory without commentary; the server never remembers
anything. Everything above either proves that promise on hardware or
compounds it.
