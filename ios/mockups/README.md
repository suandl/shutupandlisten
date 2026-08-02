# shutupandlisten — design mockups

High-fidelity, self-contained HTML mockups for the features the roadmap marked
**mockup-only / needs discussion**, plus the redesigned live session screen
(which informs the W2a implementation happening in parallel). Open
`index.html` in any browser — no server, no external requests. Dark mode is
the designed experience; switch OS appearance for the light translation
(`prefers-color-scheme`).

```
ios/mockups/
  index.html            gallery + the identity spec (palette, type, the ring)
  session-screen.html   live session redesign — 4 states side by side
  live-activity.html    Lock Screen Live Activity + Dynamic Island states
  threads.html          Threads lens · thread detail/resume · ask-your-library
  idea-page.html        session detail · on-demand idea page · next actions
  README.md             this file
```

Running example throughout: the reading-app idea from `prompts/claude.md`,
quoted verbatim (including both anchored questions from the sul-demo script),
with believable dates (a five-session thread, Jun 12 → Jul 24, 2026).

---

## 1. Identity proposal

**Thesis:** the brand has attitude in its name and must have serenity in its
behavior. The visual language is *e-ink calm* — a quiet, warm, dark room where
one ember of attention glows. Every screen should look like it is doing almost
nothing, because that is the product's actual claim.

### Palette — "night paper & ember"

One accent, ever. Ember is reserved for *what the listener does*: the patience
arc, the question, a citation chip. Everything else is warm ink on near-black.

| Token      | Dark (showcase) | Light        | Used for |
|------------|-----------------|--------------|----------|
| bg         | `#0B0D10`       | `#F7F5F0`    | app background |
| surface    | `#12151A`       | `#FFFFFF`    | cards, sheets |
| raised     | `#191D23`       | `#FBFAF6`    | pressed/elevated |
| ink        | `#E9E4DA`       | `#20232A`    | primary text (warm paper white) |
| ink 2      | `#8E9298`       | `#5E636B`    | secondary text |
| ink 3      | `#565B62`       | `#9EA2A9`    | faint text, state words |
| hairline   | `#20242B`       | `#E5E1D8`    | borders, dividers |
| **ember**  | `#D9A15E`       | `#96661F`    | the accent — arc, question, citations |
| ember ink  | `#E7BE8A`       | `#7C5316`    | accent-colored running text |
| track      | `rgba(233,228,218,.09)` | `rgba(30,33,42,.10)` | the ring's empty track |

No green/blue/orange/purple/pink state taxonomy anywhere. State is carried by
one word (caps style) plus the ring's tense.

### Type — SF Pro (system-ui fallback), quiet ramp

| Style    | Spec                                  | Carries |
|----------|---------------------------------------|---------|
| Question | 24 / 1.42, **regular**, −0.8% track   | the one question, staged |
| Title    | 20, semibold, −1.2%                   | session/thread titles |
| Body     | 16 / 1.55, regular                    | transcript prose |
| Sub      | 13, regular, ink 2                    | metadata sentences |
| Caps     | 11, semibold, +20% tracking, uppercase| state words, section labels |
| Stamp    | SF Mono 12                            | all times and timestamps |

Deliberate choices: the question renders at display size in *regular* weight —
it is a question, not a headline. Mono is used for every time so timestamps
read as instrument markings, not prose. Nothing in the app is bold-shouted.

### The signature — the patience ring

A 2 px hairline circle is the entire brand mark, with three tenses:

1. **Listening** — empty track, breathing (±3% scale, 5.8 s cycle); a soft
   ember glow inside answers the mic level while the thinker talks.
2. **Waiting** — the ember arc fills clockwise as the patience window runs
   (driven by `patienceProgress`); resumed speech *dissolves* it (~400 ms
   melt, never a snap). EOU-veto extensions visibly slow the fill. Declined
   evaluations just dissolve — no "deciding" state exists visually.
3. **The question** — the filled ring contracts to a single glowing point,
   one soft haptic, then the question card rises on an emptied screen.

Same grammar at every size: 284 pt session hero → 34 pt Live Activity → 22 pt
Dynamic Island → 7 pt question marker in lists. It is never a bar, never a
spinner, and it is also the obvious app icon (empty ring on night, ember point
offset at 12 o'clock).

Motion rules: everything eases over ≥400 ms; the only fast thing in the app
is barge-in (TTS cut instantly). `prefers-reduced-motion` freezes the
breathing and shows static tenses.

---

## 2. Per-mockup intent

### `session-screen.html` — the waiting is the interface *(informs W2a)*
- Collapses the five-color debug taxonomy into **three calm states** —
  listening / waiting it out / its one question — carried by one caps word and
  the ring's tense.
- **Staged question moment**: ring contracts → soft haptic → card rises with
  the *exact anchored question*, labeled "It was listening" (no tier jargon)
  → TTS speaks → card stays pinned until the thinker resumes.
- **Transcript peek**: last line only, right-anchored with a fade; expands to
  a sheet of flowing prose with margin timestamps — a page being written, not
  chat bubbles. The listener's question is an indented ember line, unlabeled.
- Two verbs on the live screen: **pull a thread** and **end**. Ending lands on
  the session detail (no toast). Model failure degrades to a quiet caption
  ("offline — still recording; questions paused"), never a modal.

### `live-activity.html` — the session survives the pocket
- Lock screen card: mini ring, coarse state, `Text(timerInterval:)` elapsed,
  turn count. "no questions yet" is worn as a feature claim.
- Question-waiting state holds the question's first clause; it never pushes,
  never sounds. Dynamic Island: minimal (breathing ring), compact (ring +
  elapsed), expanded (adds turn count + an End `LiveActivityIntent`).
- Annotated ActivityKit budget contract: updates on state transitions only
  (start, thought-landed coalesced, question arrival, resume, end); elapsed is
  system-rendered free; never per-pause updates; local updates only (the audio
  background mode keeps the process alive — no push token, no APNs);
  `staleDate` honesty if the process dies.

### `threads.html` — memory without commentary
- **Threads lens** over the same records (Sessions stays default): clusters
  named by recurrence, each led by its *latest open question* — the listener's
  own words as the index. Quiet grouping; never a badge, never a ping.
- **Thread detail**: "Where you stopped" pinned; timeline strung on questions;
  "you picked this up on Jul 2" computed from the thinker's own later words.
  **Continue this thread** — the app's single filled button — seeds the
  listener's memory with compact prior context, open question first; the
  prompt forbids opening recaps.
- **Ask your library**: answers are verbatim quotes with session + timestamp
  chips and tap-to-play; retrieval on-device over thinker utterances only.
  Empty result: "You haven't said anything about that yet."

### `idea-page.html` — nothing generated unless asked
- Session detail leads with **"The question you left with"** (zero model
  calls) over the tap-to-seek transcript; "Make an idea page" is a quiet
  bordered button.
- The idea page is extractive-leaning cleaned prose in the thinker's voice,
  order preserved, headings from the thinker's own pivots, every paragraph
  timestamp-cited; open question footer; cached on the record, regenerable,
  deletable. Transcript remains the default view.
- **Next actions**: only imperatives the thinker actually said, each backed by
  the verbatim quote + timestamp; explicit "Add 1 to Reminders" confirm;
  "It will never create a reminder on its own."

---

## 3. Open questions for discussion

1. **Ring vs bar.** The ring reads "attention held"; the current bar reads
   "progress." But a filling ring can also read as a *countdown to being
   interrupted* — does that create pause-pressure, the exact anti-goal? The
   dissolve-on-resume is designed to teach the opposite. Worth a feel test
   against a horizon-line alternative (a thin line that brightens rather than
   fills, carrying no % semantics at all).
2. **How loud may the question moment be?** Current staging: dim + contract +
   one soft haptic + card + TTS. Too theatrical for the tenth time? Options:
   scale staging down after N sessions; make the haptic optional; or keep
   theatre only for gate-earned questions and mute it for invited
   pull-a-thread ones.
3. **Lock-screen privacy.** The question-waiting state shows the question's
   first clause — your own words on a lockable surface. Show nothing but
   "one question, when you're ready"? Per-user setting, or default-coarse?
4. **Threads legibility.** Clustering is on-device and reversible
   (drag-out/merge), but false merges erode trust fast. Do we need an
   explain affordance ("grouped because: shared checklist + momentum words")
   or is that more machinery than the calm allows?
5. **Resume-memory expectations.** "Continue this thread" seeds prior context
   into the live call. What exactly is remembered (compact digest? last open
   question only?), where is that stated, and how does a user *unremember* a
   session from a thread's seed?
6. **Idea-page fidelity line.** "Cleaned prose in your voice" sits one step
   from "the summarizing coach the judges exist to catch." The constraint set
   (order preserved, no invented sentences, cite-or-cut) should be encoded in
   the distill prompt and spot-checked by the no-summarize rubric — who owns
   that eval?
7. **TTS voice.** The staged moment deserves better than a stock synthesizer
   voice; a premium AVSpeech voice, or pre-recorded human backchannels + a
   better question voice, is a small cost with outsized feel.
8. **Light mode's role.** Designed here as a faithful paper translation —
   is it worth full parity polish at v1, or does dark-first ship alone?

---

## 4. Implementation sizing

| Mockup | Size | New targets / endpoints | Notes |
|---|---|---|---|
| Session screen redesign | **M** | none | Rebuild of `App/UI/SessionView.swift` (~1 file) + haptics/sound hooks in `SessionController`; ring is a single SwiftUI `Canvas`/`Circle` with `trim`. Depends on W1a (timestamps, background audio) + W1b (modes). Asset catalog + AccentColor: **S** (W3a). |
| Live Activity + Dynamic Island | **M–L** | **new widget-extension target** | ActivityKit + `ActivityAttributes` shared module, `LiveActivityIntent` for End, pbxproj surgery, lock-screen/island layouts. Requires W1a background audio to be true, else the activity lies. |
| Threads lens + resume | **M–L** | none | On-device `NLEmbedding` vectors stored per record, greedy-threshold clustering + shared-`criteriaText` signal, new library lens UI, thread detail; resume is **S** on top (same history-injection pattern as coverage steering; mind the 200-message/200 KB proxy caps). |
| Ask your library | **M** | optional `/v1/select-quotes` | Hybrid keyword ∪ cosine retrieval (thinker turns only), quote cards with seek-to-play (needs W1a timestamps). Fully on-device in v1 if the model only orders results. |
| Idea page + next actions | **M** | `/v1/distill` (coverage-shaped, stateless, metered) or on-device FM | Generation cached on `SessionRecord`; next-actions sheet + EventKit (Reminders) is **S** on top. Distill prompt inherits the no-summarize constraints. |
| Identity (palette/type/ring tokens, app icon) | **S** | none | Asset catalog, color + type constants, ring component reused by session screen, lists, and the widget target. |

Suggested order of conversation: session screen (already in flight) →
identity tokens → Live Activity (trust story) → threads → idea page.
