---
name: Site mockups — one ember direction at three settings (su-a0fs)
description: The three high-fidelity HTML mockups of shutupandlisten.sh produced for su-a0fs (hold, line, cadence) plus the gallery, with one rationale paragraph per mockup and the open questions they raised. A record of the design pass, not a deployed site and not authoritative on the identity; su-02g picks the winner.
---

# shutupandlisten.sh — site mockups

Three high-fidelity, self-contained HTML mockups of the public site, all
executing **one** visual direction so the operator can compare settings rather
than tastes. Open `index.html` in any browser — no server, no build step, no
external requests. Dark mode is the designed experience; switch OS appearance
for the light translation (`prefers-color-scheme`).

```
specs/su-a0fs/
  index.html     gallery + the levers table + what carries over from the app
  hold.html      setting 1 — the ring is the page
  line.html      setting 2 — one sentence is the page (the chosen direction)
  cadence.html   setting 3 — the evidence is the page
  README.md      this file
```

Nothing here deploys. `shutupandlisten.sh` does not resolve yet (only `CNAME`
is committed); hosting is tracked separately in su-av11. These are mockups.

---

## 1. The direction

The site extends the identity already shipped for the iOS app. It does not get
its own visual language. Sources of truth, in order:

1. `ios/App/UI/Accent.swift` — `Color.sulAccent`, `RGB(0.91, 0.67, 0.36)`, the
   app's one accent; and `ios/App/UI/HorizonLine.swift`, the shipped hero.
2. `ios/mockups/README.md` §1 — the night-paper/ember palette, the quiet type
   ramp, the horizon line, the motion rules.

> **The patience ring is retired (su-9fb0s, su-g1n9s).** `index.html` and
> `cadence.html` still draw it — they are the two directions that were not
> chosen, kept as a record rather than re-rendered. `line.html`, the chosen
> direction, has no mark at all: the wordmark carries the identity alone.

The thesis from `ios/mockups/index.html` is the site's thesis too: *silence is
the product, the design should look like it.* In a feed of loud AI landing
pages, a near-black page that does almost nothing **is** the pattern interrupt.
So all three push the identity to a confident extreme — enormous negative space
used deliberately, the ring at scale, the ember rationed so hard that where it
lands it lands. The failure mode being avoided is not "too loud." It is
*timid* — a beige, apologetic page that reads as unfinished.

What none of them do: feature grid, three-column benefits, testimonial row,
gradient hero, glowing orbs, chat-bubble screenshots, a second colour, or
bold-shouted type. `line.html`'s hook is 104 px and still **regular weight** —
size carries conviction, weight would only carry volume.

---

## 2. Per-mockup rationale

### `hold.html` — the ring is the page

*What it says about the product:* **we will not perform for you.** The first
viewport is a 56 vmin hairline ring, breathing, with one 15 px line under it —
"Nothing here is going to interrupt you." — and nothing else. You have to scroll
before the site explains itself, so the page enacts the patience it is selling
before it makes a single claim. Everything after the fold keeps that pace: one
sentence per screenful, 34 vh of air between blocks, the argument delivered in
four short statements rather than a pitch. The ember appears three times on the
entire page. This is the version that trusts the pattern interrupt completely
and spends its whole budget on restraint; its risk is that a visitor reads
"unfinished" instead of "composed" and leaves before the scroll.

### `line.html` — one sentence is the page

*What it says about the product:* **there is a specific thing wrong with your
AI, and we fixed it.** The hook — "Every AI is desperate to help. This one
*waits*." — runs at display scale with the accent spent on exactly one word,
which is the whole ember-rationing principle demonstrated in a single line.
Under it, the response hierarchy is set as a four-rung editorial ladder
(silence, acknowledgment, reflection, one question) with silence in ember at the
top, so the product's actual behaviour is legible in about eight seconds. It
carries no mark at all: the ring used to retreat here to a 15 px signature
beside the wordmark plus one appearance on the OG card, and both were struck
when the ring was retired (su-g1n9s). Nothing replaced them, which suits this
setting — here the *type* is the brand mark. This is the most immediately shareable version and the most
conventional in structure; its risk is that with no proof beneath it, the claim
has to be taken on faith.

### `cadence.html` — the evidence is the page

*What it says about the product:* **stop reading about it, watch it work.**
Below a medium-volume hook, the fold hands straight over to a real exchange —
the reading-app example quoted verbatim from `prompts/claude.md`, with the
silences left in and timed (2.4 s, 3.1 s, 4.8 s), each one its own row. The ring
runs down the left margin eight times as a spine: empty while you talk, filling
through each silence, completing at the moment the idea lands, contracting to a
single ember point for the one question — the mark used as a *system* rather
than a logo. The question is the only ember prose on the page and it is built
from the speaker's own words, which is the product's actual claim made
checkable rather than asserted. Its risk is that the fold reads as
documentation: it is doing work rather than stopping traffic.

---

## 3. What is held constant

The point of three settings is that only the settings differ. Identical across
all three files: palette tokens, the type ramp, the provider selector, the copy
affordance, the share row, the footer, every word of the three prompt excerpts,
and the paste instructions. (The ring's construction and motion used to be on
this list too. It no longer is: `line.html` has no mark since the ring was
retired, so the three files are no longer identical in that one respect.)

What varies is exactly four levers — negative space, hook volume, mark usage,
and OG strategy. The table in `index.html` lays them out side by side, including
the failure mode each setting risks.

### The surfaces every mockup covers

| Surface | Where it is |
|---|---|
| Above-the-fold hook | the fold of each page |
| The prompt block | "take it" section, scroll-faded excerpt in mono |
| Provider selector, 3-way | Claude / ChatGPT / Gemini tabs — **live**, CSS-only |
| Per-variant copy | the copy button toggles to its confirmed state |
| Share | the link row, `shutupandlisten.sh` + copy |
| OG card | designed per setting, drawn at true 1200 × 630 proportion |

The excerpts are **abridged**, not verbatim: sentences are cut for length and
markdown emphasis markers are stripped, but nothing is reworded. Check them
against `prompts/` before any of this copy ships.

The selector really works — click a tab and the excerpt, the filename, the line
count and the paste destination all change. Claude gets Projects → custom
instructions, ChatGPT gets Create a GPT → Instructions, Gemini gets Gems →
Instructions, and the Gemini excerpt shows the spoken-aloud/no-preamble rules
that variant carries and the others don't (`prompts/gemini.md`, PR #50).

---

## 4. Open questions

1. ~~**Two embers are in the repo and they are not the same colour.**~~
   **Resolved (su-g1n9s).** `#E8AB5C` is the canonical ember, it lives in
   `ios/App/UI/Accent.swift` as `sulAccent` = `RGB(0.91, 0.67, 0.36)`, and
   `ios/mockups/` was repointed to match rather than the reverse — as this
   question recommended. The two mockup sets are now the same amber. (The
   Swift constant used to live in `PatienceRing.swift`; that file was deleted
   when the ring was retired, which is why the token moved to `Accent.swift`.)
2. **The accent does not survive light mode, and that is not a bug in the
   mockups.** `sulAccent` on night paper is 9.6:1 — excellent. On the light
   `#F7F5F0` background it is **1.9:1**, unusable for text or a thin bright
   element. So light mode swaps in the identity table's light ember `#96661F`
   (4.6:1). That makes the accent a *pair* of tokens, not one value.
   **Partly answered: light mode ships later.** Dark-first ships alone, so a
   single `AccentColor` in the catalog is safe for now. Retiring the ring did
   not escape this — the horizon line is also a thin bright element, and its
   brightness mechanic inverts against light paper. That remains unsolved
   design work, not a colour lookup.
3. **The copy button is the one place the pure-HTML/CSS constraint has to
   bend.** su-02g's constraint is honoured here — there is no script on any
   page, the selector and the copy confirmation are CSS state. But a real copy
   button needs ~10 lines of clipboard JS. Accept that exception, or ship a
   `<textarea>`/select-all fallback and keep the page literally scriptless?
4. **How much prompt goes on the page?** The blocks show ~20 lines of an 80–99
   line file behind a scroll fade. The shipped page has to choose: the whole
   file in a tall scroll box (honest, intimidating), a `<details>` disclosure
   (tidy, hides the product), or excerpt + "view raw on GitHub" (leaks the
   visitor to another site at the exact moment of conversion). The mockups
   assume the first; the fade is designed for it.
5. **The line counts are hardcoded** (85 / 80 / 99) and will drift the next time
   a prompt is edited. If the site ever gets even a trivial build step, that is
   the first thing to generate. Until then it is a stale-copy hazard on the one
   surface that must look precise.
6. **Motion timing disagrees with the shipped app, mildly.** These pages use
   the paper spec — 5.8 s breath, ±3%. `HorizonLine.swift` breathes at 4 s and
   moves only while *waiting* or *deciding* (a listening line is static). The
   site hero is not a live session, so a permanent slow breath reads correctly
   there. Less pressing than it was: the chosen direction carries no mark, so
   the two are no longer trying to be the same object.
7. **Claude is the default tab.** That is the repo's lead variant, but the
   largest paste-in audience is probably ChatGPT. Default to the biggest
   audience, or to the variant we think is best?
8. **The OG cards are HTML artboards, not images.** Real link previews need a
   static raster at 1200 × 630. Someone has to render them (headless screenshot
   of these artboards is the cheap path, and `web/e2e/` already has the
   machinery). Also unresolved: one card for the site, or does the shared link
   ever need per-provider variants?
9. **The hook in `line.html` names the competition implicitly** ("Every AI is
   desperate to help"). It is the sharpest line of the three and the most
   likely to be quoted back. Confirm that is a tone we want on the record.

---

## 5. If you pick one, what shipping it costs

| Mockup | Build size | Notes |
|---|---|---|
| `hold.html` | **S** | Single page, one animation, no images. The 56 vmin hero holds at 1440 × 700 (checked) — the fold is the entire argument, so re-check it if the hero grows. |
| `line.html` | **S** | Smallest. The `clamp()` hook was checked at 390 px and 1440 px; that one line is the whole design, so re-check both ends if its wording changes. |
| `cadence.html` | **S–M** | Most content and the most words to keep true — the transcript is quoted from `prompts/claude.md` and drifts if the prompt's worked example changes. Worth a comment in the prompt file pointing at it. |
| Any of them | **+S** | Clipboard JS, a rendered OG PNG, real `<meta>` tags, and DNS. None of that is design work, but none of it is free either. |

Picking the winner is not this bead — that decision stays on su-02g.
