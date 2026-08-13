---
title: "B1 gate re-measure: decoupling the veto and gate-rule-2 thresholds makes the uncued mid-thought pause hold — 4 of 4 vectors green"
type: findings
status: measured 2026-08-11 — EXECUTED on the Swift arm (official swift:6.1 image, Swift 6.1.3, Linux x86_64) after the su-uzy9.5 structural fix; full Kit 201 tests / 0 failures, B1 replay 4 of 4 held. Mirrored to the web parity runtime (394 tests / 0 failures, tsc clean). AMENDED 2026-08-13 (su-5l0q, §6): the web host was still deriving the gate's score from the patience reason and re-coupling the two mechanisms; fixed and re-verified — Swift 201/0 and B1 4 of 4 unchanged, web 402/0/3. AMENDED AGAIN 2026-08-13 (su-l74p, §7): the web host read the score once, at the emit callback, and dropped the evidence-driven re-emit that carried it — so a blind first evaluation left the gate on the reason-bridge anyway; fixed and re-verified — Swift 201/0 and B1 4 of 4 still unchanged, web 409/0/3
unit: U7 (native turn engine) · U8 (recommendation)
plan: docs/plans/2026-06-25-001-feat-on-device-quiet-companion-validation-plan.md
bead: su-uzy9.5
date: 2026-08-11
---

# B1 gate re-measure (2026-08-11)

[The 2026-08-10 measurement](b1-gate-measurement-2026-08.md) found the
response-hierarchy gate failing [usefulness-bar](../usefulness-bar.md) **B1**
— *"holds silence through an unfinished thought"* — on one of four vectors, at
the shipped defaults. The failing vector, `b1-03-unpunctuated-pause-no-cue`, was
the ordinary case: a thinker pauses mid-thought after a clause that carries no
lexical cue, `LinguisticEOU` returns its 0.6 "no strong cue" default, and 0.6
clears the 0.5 threshold — so the companion speaks 200 ms into a breath and then
barges in when the thinker resumes.

su-uzy9.5 was authorized (operator, 2026-08-11) as **one bounded structural fix
plus this re-measure** — option (b) of three, explicitly not a tuning pass. This
records the fix and the re-measure.

**After the fix the gate holds B1 on all four vectors.**

---

## 1. The fix — decouple the two thresholds, do not move the constant

The 2026-08-10 finding's own diagnosis (§3) was that the gate has two independent
B1 mechanisms that *both read one number*:

- the detector's asymmetric veto extends the silence floor only on `incomplete`;
- gate rule 2 holds silence only below `completionThreshold`.

`CompletionThreshold.swift` required the two to agree, so a single probability
decided both, and a pause scoring `.complete` (0.6 ≥ 0.5) got **neither** the
floor extension **nor** the silence. The finding named this "a coherent
architecture with a mis-set default at exactly one point."

The fix stops the two reading one number. It adds a second, higher threshold —
`confidentCompletionThreshold = 0.8` — for the detector's veto alone, and leaves
`completionThreshold = 0.5` (the gate's rule-2 boundary) **untouched**:

- **The veto** (`TurnDetector.extended()`) now extends the floor for any pause
  that is not *confidently* complete — `P(complete) < confidentCompletionThreshold`
  — instead of only when the two-valued verdict is `incomplete`. Patience is the
  primary mechanism (spec §2) and a false cutoff is the cardinal sin, so any doubt
  buys more waiting.
- **Gate rule 2** is unchanged. It still holds silence below `completionThreshold`
  = 0.5, i.e. only on *positive* evidence of a mid-thought.

So the band **[0.5, 0.8)** — "weak evidence of completeness", which is exactly
what `LinguisticEOU`'s 0.6 no-strong-cue default *is* — now buys the floor
extension **without the verdict having to claim the utterance is incomplete**.
The verdict stays `.complete`; the veto keys off confidence, not the verdict.

Why 0.8: it sits above `LinguisticEOU`'s no-strong-cue default (0.6) and below
its positive-cue scores (terminal punctuation 0.85, wrap-up 0.95). Only a
*positive* completeness cue releases the floor; the mere absence of a cue keeps
it patient. This does **not** lower the bar (U8's prohibition): the finished
boundary the gate holds silence below is still 0.5. It adds a higher bar for a
*different* decision — how long to stay patient.

The graded probability is only consulted when the EOU evidence carries one. A
bare `complete`/`incomplete` verdict with no probability — the pre-existing golden
scenario vectors, and any caller that supplies only a verdict — falls through the
original two-valued rule unchanged, which is why no *existing* vector in
`spec/turn-vectors/scenarios/` changed behaviour (each carries an explicit verdict,
never a probability). Of the probabilities that appear anywhere in the repo,
`b1-03`'s 0.6 is the only one landing in the `[0.5, 0.8)` band, so it is the only
pre-existing behaviour that moves. (Scenario vector 12, added by the fix in §1a
below, is the first to carry a probability — deliberately, since the ordering it
pins is not expressible with a bare verdict.)

Files (mirrored across both runtimes, per the standing parity discipline):
`ios/ShutUpAndListenKit/Sources/TurnEngine/{CompletionThreshold,TurnDetector}.swift`
and `web/src/{completion-threshold,turn-detection}.ts`. The gate
(`ResponseHierarchy.swift` / `response-hierarchy.ts`) is not touched.

## 1a. The ordering the band depends on is enforced, not assumed

Everything above holds *while `confidentCompletionThreshold >= completionThreshold`*
— an inverted pair has no band at all. The pre-open signoff on this branch (su-k0dl,
reworked as su-g805) found that only the DEFAULTS were pinned that way:
`completionThreshold` carries a live 0..1 knob (the URL param and the UI slider;
`web/src/knobs.ts`, iOS `KnobsView`), while `confidentCompletionThreshold` carries no
knob at all. Retune the first past 0.8 and the two invert.

An inverted pair is *worse than the welded single number this section replaced*. A
pause scoring in the inverted band — say `P(complete) = 0.85` with the knob at 0.9 —
is called `incomplete` by `resolveVerdict` (0.85 < 0.9) and yet clears the fixed 0.8
confidence bar, so the veto does not fire. On web that is not merely a shorter floor:
`main.ts` hands the gate the detector's patience *reason* bridged back to a synthetic
0/1 (`completionProbFromTurnEnd`), so a lost extension re-enters the gate as
`completionProb: 1` — "certainly complete" — and rule-2 silence is skipped too. Both
B1 mechanisms drop the pause at once, from a knob whose entire advertised effect is
"more patient". (On iOS the demo host threads the real score to the gate, so only the
veto half is lost there.)

> **Superseded in part — see §6.** The web asymmetry described here was itself the
> defect the pre-open signoff caught: `main.ts` derived the gate's score from the
> patience reason on *every* pause, not only inverted ones. It now threads the real
> `P(complete)`, matching iOS. The ordering argument above stands on its own — the
> veto half is lost either way — but the "and rule-2 silence is skipped too" clause
> describes the web host as it was on 2026-08-11, not as it is now.

The fix enforces the ordering where the pair is READ — `extended()` floors its bar at
`max(confidentCompletionThreshold, completionThreshold)` in both runtimes — rather
than trusting two independently-settable numbers to stay ordered. At the shipped
defaults the bar is 0.8 and nothing in §1 or §2 moves; what it restores is the
asymmetric veto's invariant that an `incomplete` verdict may only ever LENGTHEN
patience (spec §2), for *any* setting of the two knobs.

It is floored at the read, not normalised at the knob boundary, because `setKnobs()`
takes a partial at any time and callers construct knobs directly (the replay harness,
the vectors) — each of those paths would otherwise need its own guard.

Pinned by scenario vector `12-retuned-threshold-still-extends` — both runtimes replay
it, so the ordering is a parity contract rather than a web-side test — plus five unit
tests in `web/src/turn-detection.test.ts`. Three are regressions and fail against the
pre-fix detector, as does the vector in both runtimes: the inverted-pair case, the
same invariant swept across four orderings of the two thresholds, and an end-to-end
check that a retuned threshold holds the pause in *both* mechanisms. The other two
characterise §1's band itself (the 0.6 weak cue extends, the 0.85 positive cue
releases) and pass either way — they had no test at all before, which is why the
inversion went unnoticed.

## 2. The result

Four vectors (`spec/turn-vectors/gate/`), replayed unchanged through the real
path (`TurnDetector` → `AnalystCadence` → `CandidatePool` → `ResponseHierarchy`)
at `TurnKnobs.defaults`:

| Vector | Mid-thought pauses | B1 | What happened |
|---|---|---|---|
| `b1-01-trailing-conjunction-pause` | pause after "…and" | **held** | veto fired (P=0.1); window never closed; one reflection at the landing (unchanged) |
| `b1-02-filled-pause-disfluency` | pause after "um", pause after "," | **held** | veto fired (P=0.1, P=0.05); neither pause closed the window; one reflection at the landing (unchanged) |
| `b1-03-unpunctuated-pause-no-cue` | pause after an uncued clause | **held** (was FAILED) | veto now fires on the 0.6 pause; the window never closes; the thinker resumes into the SAME turn; one reflection at the real landing (t=7200), **no barge-in** |
| `b1-04-landing-earns-one-brief-reply` | pause after "…like" | **held** | veto fired; first landing a live call, second drew one brief, still-fresh pool candidate (unchanged) |

**4 held, 0 failed** (was 3 held, 1 failed). Barge-ins across the suite: **0**
(was 1). Total evaluations 5 (was 6): the spurious mid-thought evaluation at
t=3200 and the compounding second-half evaluation are both gone.

## 3. How `b1-03` now holds

Same vector, same defaults (`silenceFloorMs=200`, `incompleteExtensionMs=4000`,
`completionThreshold=0.5`, `confidentCompletionThreshold=0.8`):

```
3000  speech-end, utterance = 15 words
3000  LinguisticEOU.completionProbability -> 0.6   (the "no strong cue" default)
3000  verdict is still .complete (0.6 >= 0.5) — UNCHANGED, not a lie about the cue
3000  extended(): 0.6 < 0.8  =>  veto FIRES  =>  deadline = 3000 + 200 + 4000 = 7200
4200  thinker resumes at 4200 < 7200 -> the window never closed; SAME turn continues
7000  speech-end, full utterance = 23 words, ends "."  -> P(complete) = 0.85
7000  extended(): 0.85 >= 0.8  =>  no extension.  deadline = 7000 + 200 = 7200
7200  evaluate(reason: floor) — the FIRST and only evaluation of this thought
7200  decideTier: rule 2 !(0.85 >= 0.5) = false; rule 5: 23 words -> reflection
      => one reflection at the genuine landing.  NO barge-in.
```

The pause that used to be an interruption is now indistinguishable, to the
architecture, from `b1-01`'s "…and" pause: the veto holds the window open past
the resume, the gate is never asked mid-thought, and the one reply lands on the
finished thought. The 2026-08-10 finding's compounding failure — the barge-in
splitting the sentence into two turns and drawing a second backchannel ("mhm") —
does not occur, because there is no barge-in to split the turn.

`b1-01`, `b1-02`, `b1-04` are byte-for-byte unchanged in the report: none of
their pause probabilities (0.05, 0.1, 0.85) falls in the `[0.5, 0.8)` band the
fix moves.

## 4. What was executed

There is no Swift toolchain on the rig host; the measurement was run in the same
official `swift:6.1` image the `kit-tests` CI job uses (Swift 6.1.3, Linux
x86_64, repo mounted read-only), exactly as the 2026-08-10 run:

```
podman run --rm -v "$PWD":/repo:ro -w /repo docker.io/library/swift:6.1 \
  bash -c 'swift build --package-path ios/ShutUpAndListenKit --build-tests \
                       --scratch-path /tmp/build &&
           swift test  --package-path ios/ShutUpAndListenKit \
                       --scratch-path /tmp/build --filter B1GateReplayTests'
```

`swift build --build-tests` exits **0** (the whole Kit compiles clean on Linux),
and the full `swift test` reports **201 tests, 0 failures** — the B1 bar
assertion `testGateHoldsSilenceThroughUnfinishedThought`, red on `main` as the
recorded measurement, is now green. The replay produced (abridged):

```
  HELD    b1-01-trailing-conjunction-pause
     t=7400.0 turn=1 eval=1 P(complete)=0.85 closed-on=floor → reflection (20w)
     landing t=7200.0: 1 reply
  HELD    b1-02-filled-pause-disfluency
     t=10000.0 turn=1 eval=1 P(complete)=0.85 closed-on=floor → reflection (25w)
     landing t=9800.0: 1 reply
  HELD    b1-03-unpunctuated-pause-no-cue
     t=7200.0 turn=1 eval=1 P(complete)=0.85 closed-on=floor → reflection (23w)
     landing t=7000.0: 1 reply
     (no B1 violation; no barge-in)
  HELD    b1-04-landing-earns-one-brief-reply
     t=2700.0  turn=1 eval=1 → reflection [model-call] (17w)
     t=11200.0 turn=2 eval=2 → question  [pool] "What made you look at the
                               health check rather than the deploy itself?"
     landing t=2500.0: 1 reply   landing t=11000.0: 1 reply
  vectors: 4   B1 held: 4   B1 failed: 0
  evaluations: 5   utterances: 5   barge-ins: 0
  VERDICT: the gate HELD B1 on all 4 vectors.
```

The change was mirrored to the web TypeScript parity runtime (the documented
second implementation of the same spec): `npx tsc --noEmit` is clean and
`node --test` reports **400 passing, 0 failing, 3 skipped** (394 before the §1a
fix added its five unit tests and a vector) — including `response-hierarchy`'s
"the detector and the gate default to the SAME completion threshold" (still true:
the shared boundary is 0.5; the confident threshold is the detector's alone) and
the `turn-detection` extension vectors. The Swift suite is **201 passing, 0
failing**; the scenario-vector replay is a single test that loops the directory,
so §1a's vector does not move that count.

## 5. What this does and does not settle

**Does:** at the shipped defaults, and headlessly, the gate now holds B1 on all
four vectors — including the ordinary uncued mid-thought pause that decided the
bar. U8's F3 architectural lever withholds where the raw model would not, on the
gate as measured.

**Does not:** this is the **architectural** question only, unchanged from the
2026-08-10 finding's scope. `ios/App/SessionController.swift` composes the gate's
verdict into an actual utterance; it is App-target, ~1675 lines, unreachable from
any headless toolchain, and deliberately out of scope. A green result here is not
a device measurement. It also does not revisit F2 (the listener model will not
self-restrain, restraint 1.94): the gate is the lever, not the model.

The re-measure was authorized as a single attempt with a single structural fix.
It landed green, so no escalation is required; had it landed red, per U8 that
would have been a finding to report, not a thing to iterate on.

---

## 6. Addendum (2026-08-13, su-5l0q): the web host was still coupling the two

The pre-open signoff on this branch (review bead `su-eyp8`) found the decoupling
incomplete on the web arm, and it is worth recording because the §3 replay above
does **not** catch it.

**What was wrong.** §1 gave the veto its own confidence bar, so `reason:
"extended"` stopped meaning "the classifier said incomplete". `web/src/main.ts`
went on feeding the gate `completionProbFromTurnEnd(g.end.reason)` — a synthetic
`0` for any extended pause. So a weak-cue pause (`P=0.6`) got the floor extension
from mechanism 1 and then, if the extended deadline elapsed without the thinker
resuming, was handed to mechanism 2 as "certainly incomplete" and silenced. The
companion waited 7.2 s and said nothing. The two mechanisms were still reading one
number — no longer the shared constant, but the patience reason standing in for it.

**Why §3 missed it.** The `b1-03` trace takes the branch where the thinker
*resumes* at 4200, inside the extension, so the window never closes and the gate is
never asked. The bug lives on the other branch — extension elapses, thinker was
genuinely finished — which no B1 vector exercises, because B1 is about *not*
speaking. The Swift arm was unaffected: `sul-demo` already threaded the real score
(`lastEouProb`), which is why the replay stayed green while the shipped web runtime
had not actually decoupled anything.

**The fix.** The detector's per-pause score is exposed on its snapshot
(`TurnSnapshot.completionProb`, plus `extended` for the patience UI), both
runtimes. `main.ts` captures it onto the transcript's `TurnEndMark` at the emit
callback — the one moment it is unambiguously that pause's — and passes it to
`EvalContext`, falling back to the reason-bridge only when there is no score (a
bare verdict, or the blind first evaluation). `completionProbFromTurnEnd` survives
as that documented fallback. The gate's own `completionThreshold` is untouched at
0.5, and the veto's bar is still the detector's alone.

**Contract.** Spec §2 now states the confidence bar, the ordering invariant, and
that `"extended"` does not imply `incomplete`; §5 documents the snapshot and says
hosts must read the score from it rather than reconstruct it. The vector README
picks up `12-retuned-threshold-still-extends` and restates `b1-03` in the present
tense.

**Re-verified at this commit**, same toolchain and image as §4:

| Arm | Result |
|-----|--------|
| Swift `swift:6.1`, full Kit | **201 passed, 0 failed** (unchanged) |
| `B1GateReplayTests` | **4 of 4 held**, 0 barge-ins (unchanged) |
| `GoldenVectorTests` | passed — all 12 scenario vectors, unchanged |
| web `npx tsc --noEmit` | clean |
| web `node --test` | **402 passed, 0 failed, 3 skipped** (400 before; +2 regression tests) |

The new web tests pin the gap directly: a weak-cue pause that waits out the
extension reaches `reflection` on the real score and `silence` on the bridged
reason, and the test asserts the two **must** disagree. If that ever stops
diverging, the host has gone back to deriving the score from the reason.

This addendum does not revisit §5's scope limit. It is still the architectural
question only, and `SessionController.swift` is still out of scope.

## 7. Addendum (2026-08-13, su-l74p): the score reached the mark and then stopped

The second pre-open signoff (review bead `su-pb0s`) found §6 correct and
incomplete, in the same shape §6 found §1 incomplete. The host now reads the
pause's real score — but only once, and not necessarily at a moment when there
is one.

**What was wrong.** `main.ts` snapshots the score into the transcript's
`TurnEndMark` inside the `evaluate` emit callback, and guarded the whole write
with "have I already marked this evaluation?". An evidence-driven re-evaluation
carries the **same** `evaluation` id — that is its definition (spec §4b): the
window has not closed again, only the evidence behind the question improved. So
every re-emit was dismissed as a duplicate, and the mark kept whatever the first
emit happened to carry.

After a **blind first evaluation** that is nothing at all. At the shipped 200 ms
floor the window routinely closes before the classifier answers — the race §4
already measures exactly this — so the mark is written `{reason: "floor",
completionProb: null}`. The verdict lands 50 ms later, while the host is still
`deciding` because the transcript has not resolved, and the mark never hears
about it. When the transcript does resolve, `g.end.completionProb` is still
null, the documented fallback fires, and `completionProbFromTurnEnd("floor")`
hands the gate a certain **1** — "finished thought" — for a pause the
classifier scored 0.3 half a second ago. Rule 2 waves it through and the
companion speaks into an unfinished thought. B1, the cardinal failure, restored
by the bookkeeping one step after the score was threaded correctly everywhere
else.

**Why §6's tests missed it.** They asserted the intended expression —
`peek().completionProb ?? completionProbFromTurnEnd(reason)` — by rebuilding it
in the test. `main.ts` does not evaluate that expression at gate time; it
evaluates half of it at emit time, stores the result, and reads the store later.
The mirror stayed faithful to the intent while the original drifted from it, and
a mirror cannot report that. The bookkeeping was also unreachable from any test:
it lived inline in an event callback in a DOM entry point.

**The fix.** The fold is extracted to `recordTurnEnd` in `web/src/transcript.ts`
— pure, and now the only thing that decides what a closure does to the marks.
A same-`evaluation` re-emit refreshes `completionProb` and keeps `t` and
`reason`, which describe a deadline that has not moved; a new evaluation on the
same turn still supersedes its predecessor and clears the stale loop-metric
origin. `main.ts` calls it and does the loop-metric writes the result asks for.
Six unit tests pin the fold and one composed test drives detector → mark →
`groupTranscript` → `decideTier` on the blind-window pause with a late verdict.
**Three of the seven discriminate the bug** — the two same-`evaluation` refresh
cases and the composed end-to-end — verified by restoring the old
drop-the-re-emit behaviour under the new tests and watching exactly those three
go red. The other four pin the behaviour the extraction had to preserve
(supersession, the cleared loop-metric origin, other turns left alone, purity),
which is what makes the move out of `main.ts` checkable rather than merely
plausible. Spec §2 gains the consumer rule the inline code was missing: a host
that *caches* the score owes it a second read on the re-emit.

**Re-verified at this commit**, same toolchain and image as §4:

| Arm | Result |
|-----|--------|
| Swift `swift:6.1`, full Kit | **201 passed, 0 failed** (unchanged — no Swift file changed) |
| `B1GateReplayTests` | **4 of 4 held**, 0 barge-ins (unchanged) |
| web `npx tsc --noEmit` | clean |
| web `vite build` | clean |
| web `node --test` | **409 passed, 0 failed, 3 skipped** (402 before; +7 regression tests) |

The measurement in §2 and §3 is unchanged: no vector moved, no threshold moved,
and the Swift arm was never on this path. What changed is that the web runtime
now actually does what §6 said it did on the one pause shape §6 did not cover.
