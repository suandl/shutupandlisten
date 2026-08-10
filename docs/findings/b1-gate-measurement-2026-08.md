---
title: "The gate does not hold B1: an uncued mid-thought pause scores 0.6, clears the 0.5 threshold, and the companion speaks into an unfinished sentence"
type: findings
status: measured 2026-08-10 — EXECUTED on the Swift arm (official swift:6.1 image, Swift 6.1.3, Linux x86_64); the parity-runtime run and a line-by-line trace agree with it exactly
unit: U7 (native turn engine) · U8 (recommendation)
plan: docs/plans/2026-06-25-001-feat-on-device-quiet-companion-validation-plan.md
bead: su-uzy9.4
date: 2026-08-10
---

# B1 gate measurement (2026-08-10)

[U8](../on-device-quiet-companion-recommendation.md) named one decisive
experiment under "What would change this recommendation". Its **F2** is that the
listener *model* will not self-restrain — restraint 1.94, 0 of 16 cells above 2,
invariant across both frontier models and both prompts. Its **F3** is that the
only untried lever is architectural: **a gate that owns silence-vs-speak**, which
`su-uzy9` ships but which had never been measured in the favourable direction.

This measures it, against [usefulness-bar](../usefulness-bar.md) **B1** — *"holds
silence through an unfinished thought; a thinking-pause is never treated as a
turn"* — the cardinal dealbreaker.

**The gate fails B1 at the shipped defaults.**

---

## 1. The result

Four vectors (`spec/turn-vectors/gate/`), replayed through the real path
(`TurnDetector` → `AnalystCadence` → `CandidatePool` → `ResponseHierarchy`) at
`TurnKnobs.defaults`:

| Vector | Mid-thought pauses | B1 | What happened |
|---|---|---|---|
| `b1-01-trailing-conjunction-pause` | pause after "…and" | **held** | veto fired (P=0.1); the window never closed; one reflection at the landing |
| `b1-02-filled-pause-disfluency` | pause after "um", pause after "," | **held** | veto fired (P=0.1, P=0.05); neither pause closed the window; one reflection at the landing |
| `b1-03-unpunctuated-pause-no-cue` | pause after an uncued clause | **FAILED** | spoke at t=3200 into a pause the thinker did not end until t=4200 |
| `b1-04-landing-earns-one-brief-reply` | pause after "…like" | **held** | veto fired; the landing drew exactly one brief, still-fresh pool candidate |

**3 held, 1 failed.** The one failure is not an edge case — it is the ordinary case.

## 2. How it fails

`b1-03` is unremarkable thinking-out-loud:

```
t=0     "I've been trying to work out why the deploy keeps failing on the staging box"
t=3000  [pause — still mid-thought]
t=4200  "and it works fine locally every single time."
```

The trace, at `silenceFloorMs=200`, `incompleteExtensionMs=4000`,
`completionThreshold=0.5`:

```
3000  speech-end, utterance = 15 words
3000  LinguisticEOU.completionProbability -> 0.6
      (last char "x": not a discourse marker, not terminal punctuation;
       last word "box": not a trailing continuation -> the "no strong cue" default)
3000  0.6 >= 0.5  =>  verdict .complete  =>  NO extension. deadline = 3000 + 200
3200  evaluate(reason: floor)
3200  decideTier: rule 2 is !(0.6 >= 0.5) = false -> does NOT hold silence
                  rule 3: "x" is not a trailing-off marker -> passes
                  rule 5: 15 words >= 12 -> substantive
      => reflection, callModel: true   *** SPEAKS ***
4200  the thinker resumes -> BARGE-IN
```

Then it compounds. The barge-in ends turn 1, so the second half of the same
sentence — *"and it works fine locally every single time."* — opens turn **2** and
is sized as its own thought: 8 words, finished, not a question, so rule 4 reads it
as a *brief aside* and the companion backchannels **again**. One dropped full stop
produces two interruptions of a single thought.

## 3. Why the architecture does not save it

The gate has two independent B1 mechanisms, and this pause defeats both at once
because **both read the same number**:

- the detector's asymmetric veto extends the floor only on `incomplete`;
- gate rule 2 holds silence only below `completionThreshold`.

`CompletionThreshold.swift` is explicit that these must agree, and they do — that
is the point. But agreement means a single probability decides both, so a pause
that reads as `complete` gets neither the extension nor the silence. With
`silenceFloorMs = 200` (the operator feel-test default, su-lou.10.6), a
`complete`-scoring pause leaves **200 ms** between a thinker drawing breath and
an interruption.

The 0.6 branch is `LinguisticEOU`'s own admission of ignorance. Its comment reads:

> No strong cue either way. STT often drops terminal punctuation, so a bare
> unpunctuated ending is weak evidence of completeness at best.

Weak evidence of completeness is nonetheless scored **above** the threshold that
means "finished". `TurnKnobs`'s own default-knob comment asserts the opposite —
*"It held B1 with the EOU veto on; here the veto is the synchronous transcript
heuristic, so it always lands inside the floor."* The veto does land inside the
floor. It just does not fire, because on an uncued pause the heuristic says
`complete`. **The 200 ms floor was ratified on the assumption that the veto covers
mid-thought pauses; it covers only the ones that carry a lexical cue.**

This is a coherent architecture with a mis-set default at exactly one point, not a
broken design. Three of four vectors held, and `b1-04` shows the full chain —
cadence, pool, register selection, freshness — working as intended.

## 4. What this does and does not settle

**Does:** the gate, as shipped and headlessly, does not hold B1. F3's
architectural lever is *not* confirmed. Per U8 this is to be **escalated, not
built through**: with F2 already established, the quiet companion now has no
demonstrated path on any rung measured so far.

**Does not:** this is the **architectural** question only. `ios/App/SessionController.swift`
composes the gate's verdict into an actual utterance; it is App-target, 1675
lines, unreachable from any headless toolchain, and deliberately out of scope. A
red result here is not a device measurement, and a green one would not have been
either.

## 5. Provenance, and what was actually executed

Stated plainly, because this epic has already merged Swift that three review
passes could not compile:

- **The Swift arm was EXECUTED.** There is no Swift toolchain installed on the rig
  host (`swift`, `swiftc`, `xcodebuild` all absent), but the host has `podman`, so
  the measurement was run in the same official `swift:6.1` image the new CI job
  uses — Swift 6.1.3, Linux x86_64, repo mounted read-only:

  ```
  podman run --rm -v "$PWD":/repo:ro -w /repo docker.io/library/swift:6.1 \
    bash -c 'swift build --package-path ios/ShutUpAndListenKit --build-tests \
                         --scratch-path /tmp/build &&
             swift test  --package-path ios/ShutUpAndListenKit \
                         --scratch-path /tmp/build --filter B1GateReplayTests'
  ```

  `swift build --build-tests` exits **0** — the whole Kit, including this new test
  file, compiles clean on Linux. The replay then produced, verbatim:

  ```
    HELD    b1-01-trailing-conjunction-pause
       t=7400.0 turn=1 eval=1 P(complete)=0.85 → reflection: SPOKE  (20w)
    HELD    b1-02-filled-pause-disfluency
       t=10000.0 turn=1 eval=1 P(complete)=0.85 → reflection: SPOKE (25w)
    FAILED  b1-03-unpunctuated-pause-no-cue
       t=3200.0 turn=1 eval=1 P(complete)=0.6  → reflection: SPOKE (15w)
       ✗ B1 VIOLATION: spoke at t=3200.0 inside the mid-thought pause from t=3000.0
       t=7200.0 turn=2 eval=2 P(complete)=0.85 → acknowledge: SPOKE "mhm" (8w)
       barge-ins (the thinker had to talk over us): 4200.0
    HELD    b1-04-landing-earns-one-brief-reply
       t=2700.0  turn=1 eval=1 → acknowledge: SPOKE "yeah" (11w)
       t=11200.0 turn=2 eval=2 → question: SPOKE [pool] "What made you look at
                                the health check rather than the deploy itself?"
    vectors: 4   B1 held: 3   B1 failed: 1
    evaluations: 6   utterances: 6   barge-ins: 1
  ```

- **Three independent arms agree**, which is why this is reported as settled:
  the Swift run above; a run on the web TypeScript build (the repo's documented
  parity runtime for these vectors — `web/src/turn-detection.ts` and
  `web/src/response-hierarchy.ts` implement the same spec, and
  `response-hierarchy.equivalence.test.ts` exists to keep the gate policy from
  drifting), for which `LinguisticEOU` and the pure `CandidatePool` /
  `AnalystCadence` reducers were mirrored by hand since they have no TS twin; and
  a line-by-line trace of the Swift path. All three land on the same verdict, the
  same timestamps, and the same totals.

- **A second, unrelated failure is already on `main`.** The same run shows
  `AnalystPromptTests.testGrowingTranscriptLeavesEarlierChunksByteIdentical`
  failing — and it fails identically on a clean checkout of `origin/main`
  (c8c0365, 197 tests, 1 failure), so it is **not** introduced here. It looks like
  a defect in the test rather than in the chunker: it compares whole `SystemBlock`
  values across a growing transcript, but `cached` marks *where the cache
  breakpoint sits*, and that marker legitimately advances to the newly-frozen
  chunk as the transcript grows. The chunk **text** — the thing that has to stay
  byte-identical for a cache hit — is unchanged. Tracked as **su-3885**; not
  fixed here, because this bead is scoped to the gate. Its visibility is the
  point: it has been red for as long as nothing ran `swift test`.

The `kit-tests` job will therefore be red for **two** reasons on its first run —
the B1 measurement (intended, and the deliverable) and that pre-existing test bug
(unintended, and pre-existing). They are separate steps in the job so the two
never have to be told apart by reading a stack trace.
