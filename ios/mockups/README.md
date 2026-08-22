# shutupandlisten — design mockups

High-fidelity, self-contained HTML mockups for the features the roadmap marked
**mockup-only / needs discussion**, plus the redesigned live session screen
(which informs the W2a implementation happening in parallel). Open
`index.html` in any browser — no server, no external requests. Dark mode is
the designed experience; switch OS appearance for the light translation
(`prefers-color-scheme`).

```
ios/mockups/
  index.html            gallery + the identity spec (palette, type, the mark)
  session-screen.html   live session redesign — 4 states side by side
  live-activity.html    Lock Screen Live Activity + Dynamic Island states
  threads.html          Threads lens · thread detail/resume · ask-your-library
  idea-page.html        session detail · on-demand idea page · next actions
  README.md             this file
```

Running example throughout: the reading-app idea from `prompts/claude.md`,
quoted verbatim (including both anchored questions from the sul-demo script),
with believable dates (a five-session thread, Jun 12 → Jul 24, 2026).

> **The five `.html` files predate the patience ring's retirement and still
> draw it.** They are kept as a record of the design as it was proposed, not
> re-rendered. Where they and this file disagree about the mark, this file is
> right and the shipped `ios/App/UI/HorizonLine.swift` is righter. Their
> colours have been repointed to the canonical ember; their rings have not
> been redrawn.

---

## 1. Identity proposal

**Thesis:** the brand has attitude in its name and must have serenity in its
behavior. The visual language is *e-ink calm* — a quiet, warm, dark room where
one ember of attention glows. Every screen should look like it is doing almost
nothing, because that is the product's actual claim.

### Palette — "night paper & ember"

One accent, ever. Ember is reserved for *what the listener does*: the horizon
line, the question, a citation chip. Everything else is warm ink on near-black.

The dark column is the shipping target. **The light column is a record of a
deferred design, not a target** — see the note below the table.

| Token      | Dark (shipping) | Light (deferred) | Used for |
|------------|-----------------|------------------|----------|
| bg         | `#0B0D10`       | `#F7F5F0`        | app background |
| surface    | `#12151A`       | `#FFFFFF`        | cards, sheets |
| raised     | `#191D23`       | `#FBFAF6`        | pressed/elevated |
| ink        | `#E9E4DA`       | `#20232A`        | primary text (warm paper white) |
| ink 2      | `#8E9298`       | `#5E636B`        | secondary text |
| ink 3      | `#565B62`       | `#9EA2A9`        | faint text, state words |
| hairline   | `#20242B`       | `#E5E1D8`        | borders, dividers |
| **ember**  | `#E8AB5C`       | `#96661F`        | the accent — the horizon line, the question, citations |
| ember ink  | `#E7BE8A`       | `#7C5316`        | accent-colored running text |
| track      | `rgba(233,228,218,.09)` | `rgba(30,33,42,.10)` | the horizon line's resting track |

No green/blue/orange/purple/pink state taxonomy anywhere. State is carried by
one word (caps style) plus the horizon line's weight and brightness.

**Ember is `#E8AB5C`, and the shipped constant is the authority.** It lives in
`ios/App/UI/Accent.swift` as `Color.sulAccent`; this table follows it, not the
reverse. On night paper it measures 9.6:1. *Ember ink* was re-derived against
it and holds at `#E7BE8A` — same hue family (~34°), about nine points lighter,
11.2:1 on night paper — so it is unchanged rather than churned.

**Light mode is deliberately deferred; dark-first ships alone.** `Accent.swift`
carries the reasoning and this is the same one: the session screen's
brightness-means-presence mechanic inverts against light paper and needs a
design answer rather than a second constant. The light column stays here
because those values are still the right starting point for accent *text*
(`#96661F` is 4.6:1 on `#F7F5F0`, passes AA). What they do not solve is the
horizon line itself, which is a thin bright element and so loses its whole
mechanic on a light ground. That is unsolved design work. Nothing in the light
column should be read as decided.

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

### The horizon line

**The patience ring is retired.** It was a clockwise arc filling toward
completion — a progress bar bent into a circle — and it said *time is running
out* inside a product whose whole thesis is that a pause is not a deadline.
What ships instead is the horizon line: `ios/App/UI/HorizonLine.swift`, live on
the session screen. Read that file before this section; it is the authority,
and this is a summary of it.

A hairline that **brightens rather than fills**. Brightness has no terminus, so
it cannot read as a countdown. The line runs the full width and dissolves at
both ends — it owns no endpoint for anything to arrive at. It carries three
signals with one accent and no colour taxonomy:

1. **Mic level** — how brightly the horizon burns and how far the light spills
   off it. This is the *am I being heard* answer and the primary signal: sound
   being registered is the loudest thing on screen.
2. **The patience window** — how much **weight** the line gathers as a pause is
   held. Weight and luminance, never extent. Resumed speech eases it back.
3. **Phase** — the resting luminance, plus a slow drift while the model
   deliberates. Six phases exist in code; at most three are ever *named* in
   words, and naming is the session screen's job, not the line's.

Do not reintroduce a completion metaphor in a new shape.

**The horizon line is the session-screen hero. How it behaves on small
surfaces is undecided.** The ring claimed one grammar at every size, from a
284 pt hero down to a 7 pt list marker. That claim was a property of the *ring*
— a closed shape stays legible when you shrink it — and it does not transfer.
The line signals by brightness and weight across a width it does not own, and
dissolves at both ends; nothing about that survives being scaled to a list row
on its own terms. There is no replacement ladder here on purpose. Live
Activity, Dynamic Island and list treatments are open Wave 3a design work with
no incumbent answer.

**The app icon is likewise open.** The ring used to double as the obvious icon;
with the ring gone that answer goes with it, and nothing has replaced it. No
`.xcassets` exists anywhere in `ios/`, so nothing is blocked on this — it is an
open Wave 3a item, not a decision waiting to be written down.

Motion rules: everything eases over ≥400 ms; the only fast thing in the app is
barge-in (TTS cut instantly). Motion exists only while a pause is being timed
or the model is deliberating. Reduce Motion gets the same information without
the choreography — a static line at the same weight and brightness.

---

## 2. Per-mockup intent

### `session-screen.html` — the waiting is the interface *(informs W2a)*
- Collapses the five-color debug taxonomy into **three calm states** —
  listening / waiting it out / its one question — carried by one caps word and
  the horizon line's weight and brightness. *(The mockup still draws the
  retired ring here; the shipped screen draws the line.)*
- **Staged question moment**: the line quiets → soft haptic → card rises with
  the *exact anchored question*, labeled "It was listening" (no tier jargon)
  → TTS speaks → card stays pinned until the thinker resumes.
- **Transcript peek**: last line only, right-anchored with a fade; expands to
  a sheet of flowing prose with margin timestamps — a page being written, not
  chat bubbles. The listener's question is an indented ember line, unlabeled.
- Two verbs on the live screen: **pull a thread** and **end**. Ending lands on
  the session detail (no toast). Model failure degrades to a quiet caption
  ("offline — still recording; questions paused"), never a modal.

### `live-activity.html` — the session survives the pocket
- Lock screen card: mini mark, coarse state, `Text(timerInterval:)` elapsed,
  turn count. "no questions yet" is worn as a feature claim. *(The mockup draws
  the retired ring; what the mark becomes on this surface is open — see "The
  horizon line" above.)*
- Question-waiting state holds the question's first clause; it never pushes,
  never sounds. Dynamic Island: minimal, compact (mark + elapsed), expanded
  (adds turn count + an End `LiveActivityIntent`) — the mockup draws rings, and
  the mark for these sizes is undecided.
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

1. ~~**Ring vs bar.**~~ **Decided — the horizon line won.** The concern was
   real: a filling ring reads as a countdown to being interrupted, which is the
   exact anti-goal. The horizon-line alternative named in this question — a
   thin line that brightens rather than fills, carrying no % semantics at all —
   was adopted and shipped. See "The horizon line" above. What remains open is
   not *whether*, but how the mark behaves on small surfaces, and what the app
   icon becomes; both are Wave 3a design work with no incumbent answer.
2. **How loud may the question moment be?** Current staging: dim + the line
   quieting + one soft haptic + card + TTS. Too theatrical for the tenth time? Options:
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
8. ~~**Light mode's role.**~~ **Decided — dark-first ships alone.** Light
   mode is deferred, not cancelled; the palette table keeps its light column as
   a record. The unsolved part is not the colours but the horizon line, whose
   brightness mechanic inverts against light paper.

---

## 4. Implementation sizing

| Mockup | Size | New targets / endpoints | Notes |
|---|---|---|---|
| Session screen redesign | **M** | none | Rebuild of `App/UI/SessionView.swift` (~1 file) + haptics/sound hooks in `SessionController`; the hero is `UI/HorizonLine.swift` (shipped). Depends on W1a (timestamps, background audio) + W1b (modes). Asset catalog + AccentColor: **S** (W3a). |
| Live Activity + Dynamic Island | **M–L** | **new widget-extension target** | ActivityKit + `ActivityAttributes` shared module, `LiveActivityIntent` for End, pbxproj surgery, lock-screen/island layouts. Requires W1a background audio to be true, else the activity lies. |
| Threads lens + resume | **M–L** | none | On-device `NLEmbedding` vectors stored per record, greedy-threshold clustering + shared-`criteriaText` signal, new library lens UI, thread detail; resume is **S** on top (same history-injection pattern as coverage steering; mind the 200-message/200 KB proxy caps). |
| Ask your library | **M** | optional `/v1/select-quotes` | Hybrid keyword ∪ cosine retrieval (thinker turns only), quote cards with seek-to-play (needs W1a timestamps). Fully on-device in v1 if the model only orders results. |
| Idea page + next actions | **M** | `/v1/distill` (coverage-shaped, stateless, metered) or on-device FM | Generation cached on `SessionRecord`; next-actions sheet + EventKit (Reminders) is **S** on top. Distill prompt inherits the no-summarize constraints. |
| Identity (palette/type tokens) | **S** | none | Asset catalog + `AccentColor` from the canonical ember; color + type constants. The horizon line already ships (`UI/HorizonLine.swift`) and is the session screen's, not a shared component — there is no mark to reuse on lists or the widget target yet. |
| App icon | **S**, unstarted | none | **Open — no incumbent answer.** The ring used to be the assumed icon; it is retired and nothing replaced it. No `.xcassets` exists in `ios/`, so nothing is blocked on it. |
| Mark on small surfaces (Live Activity, Dynamic Island, lists) | ? | none | **Open design work.** The horizon line is specified as the session-screen hero only; how it reads below hero scale is undecided and deliberately not answered on paper. |

Suggested order of conversation: session screen (shipped — the horizon line
landed in su-9fb0s) → identity tokens → Live Activity (trust story) → threads →
idea page.
