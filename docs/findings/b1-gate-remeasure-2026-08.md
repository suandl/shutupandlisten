---
title: "B1 gate re-measure: decoupling the veto and gate-rule-2 thresholds makes the uncued mid-thought pause hold — 4 of 4 vectors green"
type: findings
status: measured 2026-08-11 — EXECUTED on the Swift arm (official swift:6.1 image, Swift 6.1.3, Linux x86_64) after the su-uzy9.5 structural fix; full Kit 201 tests / 0 failures, B1 replay 4 of 4 held. Mirrored to the web parity runtime (394 tests / 0 failures, tsc clean)
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
