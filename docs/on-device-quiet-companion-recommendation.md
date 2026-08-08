---
title: "Decision-ready recommendation: build the quiet companion, iOS-native, with quietness in the gate"
type: recommendation
status: synthesis — verification-only, no new measurement; 2026-08-05
unit: U8 (the deliverable of epic su-lou)
epic: su-lou
bead: su-lou.17
date: 2026-08-05
sources:
  - docs/usefulness-bar.md (U1 — the acceptance bar, B1–B6)
  - docs/findings/on-device-text-quality.md (U2 — on-device listener harness)
  - docs/findings/reply-latency-baseline.md (su-lou.14.1 — browser reply latency)
  - docs/findings/listener-eval-rescore-2026-08.md (su-lou.16 — frontier listener re-score)
  - docs/ios-product-evaluation.md (the iOS-native line)
  - promptfoo/judges/restraint.txt, promptfoo/providers/multi-turn.js (harness semantics)
---

# On-device quiet companion — decision-ready recommendation (U8)

This is the deliverable of epic **su-lou**: the on-device quiet-companion
validation epic asked whether the quiet thought-companion is *useful enough to
reach for, flaws and all* (docs/usefulness-bar.md), and if so, what to build
next. This document is the synthesis. It is **verification-only** — it re-ran no
eval, tuned no prompt, changed no code, and picked no lever. Every figure below
was checked against the merged sources on `origin/main`; where the epic's
working notes and a merged source could have disagreed, the merged source was
taken as ground truth. On this pass they agreed, and the few figures that are
extrapolations or soft-provenance are flagged as such at the point of use.

Read once and act on it.

---

## The recommendation

**Build the quiet companion. Build it iOS-native. Deliver the quietness in the
GATE, not in the model.**

The decisive next experiment is **not** a better model and **not** a better
prompt. It is a **measurement of a live gate against B1 and B4 on the iOS
surface** (§What would change this). Everything the epic measured points the same
way: the browser rung proved the *flow* but fails on latency and is now parked;
the listener model **will not hold silence** no matter which frontier model or
which prompt it runs; and the only untried lever — a layer that decides *whether
to invoke the model at all* — is exactly what the iOS build already ships but has
not yet measured.

Three findings carry that recommendation, strongest first:

- **F1 — the browser rung is built and works, and fails on latency.** Parked, not
  killed.
- **F2 — the listener model will not self-restrain, and this is the epic's most
  important result.** It fails **B1**, the bar's cardinal dealbreaker, invariantly
  across both frontier models and both prompts. By the bar's own terms, **no
  configuration measured in this epic passes.**
- **F3 — the remaining lever is architectural, not a tuning knob.** The one
  mechanism that could deliver B1 and B4 — a gate that owns silence-vs-speak — was
  never exercised in the favourable direction. The iOS build ships it.

The recommendation is **well-supported on the architectural conclusion** and
**under-supported on model-class selection**; the Gaps section states exactly
where the evidence runs out and does not paper over it.

---

## Substrate — read this before the findings

The epic measured on two surfaces, and it is important not to blur them:

- **The browser/WASM rung (U3–U6)** — a full in-browser voice loop, measured for
  latency (F1). The measured numbers come from the *slowest* rung the environment
  could reach (single-threaded WASM, no WebGPU), so they are a browser floor, not
  a product ceiling.
- **The frontier listener-eval surface** — a text-only promptfoo harness driving
  `openai:gpt-4o` and `anthropic:claude-haiku-4-5` as the listener, scored by four
  LLM-rubric judges (F2). This is the surface the iOS Analyst inherits under the
  2026-08-05 iOS pivot.

Two properties bound every quality number in this document, and both are stated
in the sources rather than assumed here:

- **Clean-text upper bound.** The eval's "thinker" emits clean prose, so every
  listener score is an *upper bound* relative to live, disfluent STT output — the
  known U2→U5 handoff gap (docs/findings/listener-eval-rescore-2026-08.md §7;
  docs/findings/on-device-text-quality.md §6). A live loop reads no better and
  probably worse.
- **No on-device model was ever run for quality.** The on-device (ollama/MLX)
  score cells were never populated (Gaps #1, #3). Every listener-quality number
  here is a *frontier* number.

The iOS line (docs/ios-product-evaluation.md) is a **design and a build**, not yet
a device measurement: "nothing on this branch has run on a device or simulator"
(that doc, "Recommended next moves"). It is the vehicle for the next experiment,
not evidence for it.

---

## F1 — The browser rung is built and works, and fails on latency

**What is built.** Rung 1 is complete end-to-end (U3–U6): browser audio with
Silero VAD, a 200 ms silence floor with smart-turn end-of-utterance running in
MODEL mode, in-browser STT, an in-browser listener LLM, in-browser TTS, and a
warmed loop with per-stage instrumentation — the full path
`VAD → turn-detection → STT → response-hierarchy gate → listener LLM → spoken
reply` (bead su-anr; the pipeline stages and the 200 ms-floor / smart-turn-MODEL
substrate are recorded in su-lou.14 and su-anr).

**What it fails on: latency.** On the warmed, uncontended measurement
(docs/findings/reply-latency-baseline.md, bead su-lou.14.1):

- **Listener-LLM generation dominates** at **~2,709 ms per generated token** (§2)
  — **~2.85× TTS time-to-first-audio** on the clean split (§2, the dominant
  stage), and because it scales per token the gap *widens* with reply length.
- A separate **one-time listener model load of 156,606 ms** (§2/§4) — 3.6× the
  generation cost and 10× TTS first-audio — made the end-to-end loop run
  unmeasurable (1 of 3 turns spoken).
- **Extrapolated:** at ~2.7 s/token, a 30-token reply is **~81 s of generation
  alone** (2,709 ms × 30 ≈ 81,270 ms). This is an extrapolation from the
  per-token rate; the measured smoke was 16 tokens at 43,347 ms (§2), and the
  reply mark is time-to-first-sentence, a *lower* bound on full generation (§2,
  measurement caveat).

**The caveat the report states about itself:** this ran on the **slowest possible
rung** — `crossOriginIsolated=false` (single-threaded WASM) with no WebGPU adapter
(§1). It is a browser floor, **not the product ceiling** (§6); the same load is
~52 s served cross-origin-isolated (§4).

**Independent corroboration.** The operator's **2026-07-23 feel-test** in a real
browser reached the same verdict qualitatively: with the floor at 200 ms and
smart-turn in MODEL mode, *"the time from talking done to text to spoken reply is
long"* (operator, verbatim, recorded in su-lou.14; feel-test on su-lou.10 /
su-lou.10.6).

**Status: parked, not killed.** su-lou.14 (the browser reply-latency design) is
`blocked` with reason *"parked: operator pivot to iOS-first (2026-08-05); browser
lever choice has no consumer — revive only if the web track resumes."* The levers
it would have chosen between — COOP/COEP threading, WebGPU generation, a smaller
listener, streaming TTS — remain open and revivable.

---

## F2 — The listener model will not self-restrain

**This is the epic's most important result.**

**Substrate.** docs/findings/listener-eval-rescore-2026-08.md (bead su-lou.16) is
the re-run of the 16-cell frontier score table on the *repaired* harness (su-lou.12
fixed the restraint judge and closed a variety loophole; su-lou.13 hardened the
shipped prompt). Matrix: **2 prompts × 2 frontier models × 4 scenarios × 4
judges = 16 cells**, a genuinely fresh pass (`--no-cache`, 0 errors, 144 requests).

**The measurement.** Restraint reads **1.94 mean, 0 of 16** (§2). It is tightly
clustered — **fifteen cells at 2, one at 1: no cell above 2** — on *either* prompt
and *either* frontier model (§3a, §4 Q3). The failure is **invariant across both
prompts and both frontier models.**

**The models are choosing to speak; the harness is not forcing them to.** This is
the load-bearing fact:

- The harness **supports silence.** In `promptfoo/providers/multi-turn.js`, an
  empty (silent) listener turn is preserved in the raw transcript array (line 242)
  but dropped from *both* the API payload sent to the next turn (line 346) *and*
  the scored transcript the judges read (line 282) — deliberately, so that the
  restraint judge "reads the sparse listener presence as silence" (lines 276–278).
  A silent turn is a legitimate, representable move: the harness scores silence as
  the *absence* of a listener line; it does not force a reply.
- The **v0 prompt explicitly orders it**: *"reply with nothing at all — an empty
  response"* during dictation (quoted in su-lou.16 §4 Q2).
- **Yet across ~80 listener turns (16 cells × 5), not one turn was silent** (§4
  Q2). Every model asked a question on every turn.

### The read that matters — what actually failed is B1, not B4

The restraint judge is *labelled* "B4 rare" in the re-score
(docs/findings/listener-eval-rescore-2026-08.md §1). But read what the judge
actually scores, and the failure it caught is **B1, the cardinal dealbreaker** —
not the strong-tier B4 the label suggests. The mapping holds on inspection, and it
matters because B1 and B4 sit in different tiers of the bar:

- **What the judge scores is position, not frequency.** `judges/restraint.txt`
  anchors on a landing marker — *"[THE THINKER HAS NOW FINISHED LAYING OUT THE
  IDEA …]"* — and scores **which side of that marker each listener turn falls on**:
  "Everything ABOVE that line is mid-dictation, so a listener turn there is an
  interjection … one short thread-pull [below it] is exactly what the listener is
  FOR" (restraint.txt, lines 9–21). A top score requires being *"near-silent above
  the marker."* The marker is emitted positionally, right after the thinker turn
  that lands the idea (`multi-turn.js`, `LANDING_MARKER`, lines 85–86 and 279–289).
- **A turn above the marker is, by definition, a turn that lands mid-thought.**
  That is precisely B1's failure condition. The bar's own wording (docs/usefulness-bar.md,
  **B1 — Holds silence through an unfinished thought**): *"A thinking-pause is
  never treated as a turn; no listener turn lands mid-thought. Interrupting an
  unfinished thought is the **cardinal failure**."*
- **That is exactly how these configurations failed.** Every cell sits in the
  *"repeated over-engagement above the marker — interview cadence"* band, with
  restraint reasons uniformly *"multiple mid-dictation questions above the marker"*
  (su-lou.16 §4 Q3). The listeners interjected into the *unfinished* thought — the
  B1 way — not merely too often in the legitimate post-landing window (the B4
  way). B4's *"rare and brief"* frequency question never even arose, because the
  models never reached the state where only below-marker frequency was left to
  judge.
- **Why the distinction changes the decision.** On the bar, **B1 is a Core
  dealbreaker** and **B4 is Strong** (docs/usefulness-bar.md). The bar states:
  *"A failure on any core item means the operator will not reach for the flow."*
  So this is not "restraint could be tuned up a notch"; it is a failure of the
  single behaviour the whole product exists to deliver.

**A structural amplifier, stated plainly (it does not rescue the result).** The
thinker lays the idea out across 5 discrete turns and the listener is polled after
each, so **4 of the 5 listener turns fall above the marker** by construction
(su-lou.16 §4 Q2). The harness gives the listener four chances to interject before
the landing and the frontier models take all four. This is a property of the
turn-by-turn *cadence* as much as of the models — which is the hinge into F3 — but
it does not soften F2: a model that will not stay silent when *ordered to* on a
clean transcript will not stay silent on a messier live one.

**The conclusion, by the bar's own terms.** No prompt or frontier-model lever
measured in this epic produced a configuration that clears B1. **Nothing measured
in this epic passes the bar.**

---

## F3 — The remaining lever is architectural, not a tuning knob

**No lever we hold moves F2.** The re-score is explicit that prompt hardening is a
*trade, not an improvement* (§5, and Secondary findings below), and the model axis
is invariant on restraint (§3c). Nothing in the prompt-or-frontier-model space we
control shifts the B1 failure.

**But the eval never exercised the one mechanism that could.** Its cadence polls
the listener *after every turn*, so the listener is **asked to speak 5 times per
scenario** (`maxTurns=5`; su-lou.16 §1). The untested variable is a layer that
decides **whether to invoke the model at all** before any of those turns become a
model turn — the **U5 reduced-role** idea: a text/rules gate answers light turns
with a no-model acknowledgment and escalates to the model *only on positive
evidence a substantive reply is invited* (docs/findings/on-device-text-quality.md
§5, §7; `promptfoo/providers/reduced-role.js`).

**This is exactly what the iOS build ships.** su-uzy9 (the iOS-native line) builds
a **pool-first gate** (`SessionController`), an **AnalystCadence reducer**, and a
**ranked, transcript-anchored, freshness-expiring CandidatePool** — all three in
su-uzy9's merged iOS code (`ios/App/SessionController.swift`,
`ios/ShutUpAndListenKit/Sources/TurnEngine/{AnalystCadence,CandidatePool}.swift`),
not in the eval doc below. The behaviour those pieces deliver is the point: the
model is "asked (and free to decline) before it ever speaks," and the *"Just
listen"* toggle *"deterministically caps every uninvited turn at a quiet
acknowledgment — no model call can slip through"* (docs/ios-product-evaluation.md).

**It is untested in the favourable direction.** The gate is the **one mechanism on
the table that could deliver B1 (hold silence through the unfinished thought) and
B4 (speak rarely and briefly)** — precisely because it can choose *not to invoke
the model* on the four mid-dictation turns where the raw model fails. The epic
never measured it doing so. That measurement is the recommendation.

---

## Secondary findings

Smaller than F1–F3, but they shape *how* to build, so state them:

- **B3 ("never summarizes back") is not cleanly prompt-bound.** The re-score shows
  a **model** axis (gpt-4o **4.13** vs haiku-4-5 **3.25**, spread **0.88**) that
  *exceeds* the prompt axis (spread **0.62**), and the stronger general model
  scored **better** (su-lou.16 §3b/§3c, §4 Q1). This contradicts the epic's earlier
  standing conclusion that B3 is "prompt-bound, not model-bound." It is a single
  pass, n=8/subgroup — **directional, not decisive** — but it **weakly favours a
  frontier-backed Analyst** over a small on-device model on B3.
- **Prompt hardening traded B3 for variety.** B3 fell **4.00 (v0) → 3.38
  (hardened)** while variety rose **2.38 → 3.63** (su-lou.16 §3b, §5). The
  mechanism is identified: the hardened prompt's response-hierarchy **level 3**
  ("short momentum-preserving reflection") licenses exactly the playback B3
  penalises (§4 Q1, §5). **Do not port that clause verbatim into the iOS Analyst
  prompt.**
- **B4's "brief" half is not reproduced on the frontier surface.** The shipped
  hardened prompt is the *briefest* configuration measured — **11–27 words/turn**;
  even the longest configuration (v0) runs only up to ~53 words/turn, **~70 tokens
  — nowhere near a token cap** (su-lou.16 §3e, §4 Q2). The operator's verbose-reply / "hit the
  token cap" observation is recorded as belonging to a **different substrate** (the
  browser/on-device listener), and this frontier eval **cannot corroborate it**
  (su-lou.16 §4 Q2, §7). Provenance note: that observation is referenced as an
  operator feel-test observation and is not pinned to a primary measurement bead;
  treat it as belonging to the now-parked browser/on-device rung.

---

## The gaps — where the evidence runs out

This recommendation is well-supported on the **architectural** conclusion (F1–F3)
and under-supported on **model-class selection**. These are the specific holes;
none is buried:

1. **No on-device model class was ever selected on evidence.** U2's on-device
   score tables were never populated — every cell in
   docs/findings/on-device-text-quality.md §2 and §3 reads `_pending_`, and the §7
   decision rule ("pick the smallest candidate that clears restraint in
   reduced-role…") was never executed. The U2 harness is validated end-to-end on
   cloud gpt-4o only; **no 2–3B on-device candidate was ever scored** (no
   ollama/MLX runtime on the build host).
2. **U6 was never formally rated against B1–B6.** su-anr names the operator
   feel-test as *"the post-merge usefulness gate,"* but **no per-bar-item verdict
   was recorded anywhere.** What exists is qualitative: the 200 ms floor *"works
   just fine,"* the reply is *"long"* (both operator, 2026-07-23, su-lou.14), and
   one verbose reply hit the token cap (browser/on-device substrate, per §Secondary).
3. **su-lou.16 ran the frontier half only.** The on-device (ollama) family was not
   run — deliberately, no ollama on the host (su-lou.16 §1, §7). Every F2 number is
   a frontier number.
4. **Clean-text upper bound.** The eval's thinker emits clean prose, so every
   listener score is an upper bound relative to live disfluent STT (su-lou.16 §7;
   on-device-text-quality.md §6). Live will read worse.
5. **B5 and B6 were never scored at all.** The harness has exactly four judges —
   probing-depth, restraint (B4/B1, per F2), no-summarize (B3), variety
   (`promptfoo/promptfooconfig.yaml`). There is **no judge for B5 (specific over
   generic) or B6 (feels real, not robotic)**; probing-depth touches B5's
   territory but is not a B5 verdict. Two bar items are unmeasured.
6. **U7's outcome is not in hand.** su-uzy9's PR #37 line has **landed** (merged
   2026-08-02, commit `ad11247`); the epic itself stays **open and idle by
   design**, awaiting an MVP iOS build for the operator's next feedback round
   (su-uzy9). So the gate F3 rests on is **built and merged but not yet measured
   against the bar** — a **design, not yet a measurement** — and the iOS branch has
   still not run on a device or simulator (docs/ios-product-evaluation.md).

---

## What would change this recommendation

**A measurement of a live gate against B1 and B4 on the iOS surface.** Name it
explicitly so the next unit is unambiguous:

- **If** su-uzy9's pool-first gate + AnalystCadence **hold silence through an
  unfinished thought** where the raw model would not — i.e. the gate declines to
  invoke the model on the mid-dictation turns and speaks once, briefly, after the
  landing — then **F3 is confirmed and the product thesis stands.** Build through.
- **If they do not**, then the quiet companion has **no demonstrated path on any
  rung measured so far**, and *that* is the finding to **escalate rather than build
  through.** The gate is the last untried lever; if it fails B1 too, the epic's
  answer to "useful enough to reach for?" is not yet "yes" on any surface.

---

## What this does and does not establish

**Establishes.**
- The browser rung is built end-to-end and is latency-bound: listener-LLM
  generation dominates at ~2.7 s/token (~2.85× TTS), on the slowest rung and now
  parked (F1; su-lou.14.1).
- On the repaired harness, the frontier listener fails restraint **1.94, 0/16, no
  cell above 2, invariant across both prompts and both frontier models**, and the
  failure mode measured is **B1** (mid-dictation interjection), the cardinal
  dealbreaker — so **nothing measured in this epic passes the bar** (F2; su-lou.16).
- The only untried lever is architectural — a gate that owns silence-vs-speak —
  and the iOS build already ships it (F3; su-uzy9).

**Does not establish.**
- Any on-device model-class selection (Gap #1), any on-device listener quality
  (Gap #3), or any live-gate performance against the bar (Gaps #6, and the whole
  point of "What would change this").
- B5 or B6 for any configuration (Gap #5).
- That the browser floor is the product ceiling — it is not (F1 caveat).
- The operator's verbose/token-cap observation on the frontier surface — it belongs
  to the parked substrate and was not reproduced here (§Secondary).

**Method (provenance).** Verification-only synthesis of epic su-lou. Every figure
was checked against the merged sources on `origin/main` (docs/usefulness-bar.md,
docs/findings/on-device-text-quality.md, docs/findings/reply-latency-baseline.md,
docs/findings/listener-eval-rescore-2026-08.md, docs/ios-product-evaluation.md,
and the promptfoo harness). No eval was re-run, no prompt tuned, no code changed,
and no lever selected. Extrapolated and soft-provenance figures are flagged inline.
