# Golden turn vectors

Cross-runtime parity fixtures for the [turn state machine](../turn-state-machine.md).
A vector is a deterministic input event stream plus the expected output; any
runtime that implements the spec must reproduce the expected output exactly.
The U3 browser build (`web/src/turn-detection.ts`) and the U7 native build both
run against these — "reuse U3 logic" means these vectors and the spec, not the
code.

Three kinds live here:

## `scenarios/` — exact-output behavioral vectors

Each file pins the timing contract for one behavior. Schema:

```jsonc
{
  "name": "01-subfloor-pause-preserved",
  "description": "human-readable behavior under test",
  "knobs": {                       // overrides spec defaults; any subset
    "silenceFloorMs": 2000,
    "incompleteExtensionMs": 4000,
    "completionThreshold": 0.5,
    "responseDurationMs": 1500,
    "useSmartTurn": true
  },
  "events": [                      // input stream, strictly increasing t (ms)
    { "t": 0,    "type": "speech-start" },
    { "t": 1200, "type": "speech-end" },
    { "t": 2000, "type": "speech-start" },
    { "t": 3500, "type": "speech-end" },
    { "t": 4500, "type": "tick" }   // terminal tick advances past any deadline
  ],
  "expected": {
    "turnEnds": [],                // every turn-end, in order: { t, turn, reason }
    "turnStartCount": 1,           // optional invariants
    "emit": [ ... ]                // optional: full ordered output-event list
  }
}
```

The runner asserts the emitted `turn-end` events match `turnEnds` exactly (time,
turn id, reason), plus any optional invariants. `emit`, when present, is checked
against the full ordered output stream.

**The host's verdict is an input, so it lives in `events` too.** Since `Deciding`
was un-collapsed (spec §4a) the patience window closing emits an `evaluate` and
the machine waits; the turn ends only when a `{ "type": "decision", "outcome":
"speak" | "silence" }` answers it. A vector that supplies no `decision` after the
window closes is asserting that the machine **waits** — which is why `01`'s
`turnEnds: []` and `09`'s both mean something.

These twelve cover the plan's scenarios 1–5, the asymmetric-veto hold, the
un-collapsed `Deciding`, the utterance/evaluation split, and the veto's
confidence bar:

| Vector | Plan scenario | Asserts |
|--------|---------------|---------|
| `01-subfloor-pause-preserved` | 1 | A sub-floor pause emits **no** evaluate — so it can never end a turn (the cardinal-failure guard / TDD red anchor). |
| `02-floor-elapsed-one-end` | 2 | Silence past the floor with no `incomplete` evaluates **exactly once**, at the floor; a `speak` verdict makes that one turn-end. |
| `03-complete-no-shortcircuit` | 3 | A `complete` verdict during a sub-floor pause does **not** evaluate before the floor. |
| `04-resume-continues-turn` | 4 | Speech resuming after a sub-floor pause continues the **same** turn (one turn-start, one turn-end). |
| `05-barge-in-yields` | 5 | Speaking over a response yields **instantly** (response-end `reason: barge-in` at the interrupt, new turn). |
| `06-incomplete-extends-floor` | (§2 veto) | An `incomplete` verdict holds the turn open to `floor + extension` (`reason: extended`); the value the EOU adds over the bare floor. |
| `07-silence-verdict-no-response` | (§4a) | A `silence` verdict emits **no** turn-end and **no** response-start — declining the floor costs nothing, and the turn does not end, so the 4500 resume is the **same** turn. Same event times as `05`, where the `speak` answer turns that resume into a barge-in. |
| `08-resume-while-deciding` | (§4a) | Resuming while the verdict is outstanding is a **resume, not a barge-in**: same turn, no new turn-start; a verdict arriving after it is stale and ignored. |
| `09-evidence-reevaluation` | (§4a) | A fresh EOU verdict while deciding **supersedes** the evaluation (`trigger: evidence`) — re-evaluation is evidence-driven, not clock-driven. |
| `10-late-decision-stamps-verdict` | (§6 note) | A `speak` verdict arriving 2500 ms after the window closed stamps `turn-end`/`response-start` at the **verdict** (6500) while `evaluate` keeps the deadline (4000) — deliberation latency is visible, not erased. |
| `11-one-utterance-many-evaluations` | (§4b) | One thought, two declined pauses at a 500 ms floor: **three** evaluations (`evaluation` 1→3) under **one** turn. `turn` counts thoughts, `evaluation` counts window closures; only taking the floor ends a turn. |
| `12-retuned-threshold-still-extends` | (§2 ordering) | The veto's bar is floored at `completionThreshold`, so a live retune that inverts the pair cannot cost a pause its extension: at `completionThreshold: 0.9`, `P=0.85` reads `incomplete` yet clears the fixed `0.8` confidence bar, and must still extend. An `incomplete` verdict may only ever lengthen patience. |

## `labeled/` — measurement vectors (scenario 6)

Realistic thinking-out-loud event streams with **ground-truth** turn
boundaries, consumed by `web/src/measurement.ts`. Schema adds `trueTurnBoundaries`
(the times a real completed thought actually ended — where the detector *should*
fire after patience) and drops `expected`:

```jsonc
{
  "name": "tol-01-trailing-conjunction",
  "description": "...",
  "knobs": { "silenceFloorMs": 800, "incompleteExtensionMs": 2500, ... },
  "trueTurnBoundaries": [ { "t": 9000, "note": "the one real end-of-thought" } ],
  "events": [ ... ]
}
```

The harness runs each vector through two arms — `useSmartTurn:true` (floor +
veto) and `useSmartTurn:false` (patience-only baseline) — and scores the
detector's end-of-thought signal against `trueTurnBoundaries`. That signal is the
`evaluate` edge (`trigger: deadline`), not `turn-end`: what scenario 6 measures is
the **endpointing** — did the detector notice the thought ended, and when — which
is why these vectors carry no `decision` events. Whether the companion then chose
to speak is the response gate's business, measured elsewhere.

- **false cutoff** — a detection with no true boundary within tolerance (fired
  mid-thought: the cardinal sin).
- **false continuation** — a true boundary with no detection within tolerance
  (stayed silent when the thought was done).

The veto must **beat the bare floor** to earn its place: no more false cutoffs
and no worse total error. The floor in `labeled/` is set deliberately *short*
(sub-second) — that is where the bare floor clips mid-thought pauses and the
`incomplete` veto demonstrably rescues them; at a multi-second floor neither arm
cuts off and the comparison is empty.

## `gate/` — bar vectors for the silence-vs-speak gate

Where `scenarios/` pins the detector's timing and `labeled/` scores its
endpointing, these score the **whole gate** — `TurnDetector` →
`AnalystCadence` → `CandidatePool` → `ResponseHierarchy` — against
[usefulness-bar](../../docs/usefulness-bar.md) **B1**, "holds silence through an
unfinished thought". Replayed by
`ios/ShutUpAndListenKit/Tests/TurnEngineTests/B1GateReplayTests.swift`.

Same schema, two additive fields and one deliberate omission:

```jsonc
{
  "name": "b1-03-unpunctuated-pause-no-cue",
  "description": "...",
  // NO "knobs": a bar vector measures the SHIPPED defaults, so a retune of
  // TurnKnobs.defaults moves the measurement. Set them only to probe a tuning.
  "groundTruth": {                    // replaces `expected` — see below
    "midThoughtPauses": [ { "t": 3000, "note": "the thinker resumes at 4200" } ],
    "landings":         [ { "t": 7000, "note": "the thought is finished" } ]
  },
  "analyst": {                        // optional: what the analyst WOULD return,
    "candidates": [                   // since it is a model and cannot run headlessly.
      { "text": "...", "register": "question" }
    ]
  },
  "events": [
    { "t": 0,    "type": "speech-start" },
    { "t": 3000, "type": "speech-end", "text": "..." },   // `text`: the transcript
    { "t": 3050, "type": "eou", "source": "linguistic" }, //  for that segment
  ]
}
```

- **`text` on `speech-end`** is what was transcribed during that segment. The
  runner accumulates it per turn (the utterance the gate sizes) and per session
  (the monotonic basis `CandidatePool.expire` requires).
- **`"source": "linguistic"` on `eou`** means *score the utterance so far with the
  real `LinguisticEOU`* rather than handing the engine a verdict. The words are the
  input; whether they read as finished is the engine's answer, not the fixture's.
- **No `expected` block, by design.** These carry `groundTruth` — which pauses are
  mid-thought and where the thought lands — in the same spirit as `labeled/`'s
  `trueTurnBoundaries`. Pinning the gate's output in the fixture would make a
  measurement into a tautology; the bar is scored in the runner instead. Every
  `speech-end` must appear in one of the two lists, so a vector cannot quietly
  exempt the pause it exists to exercise.

The runner supplies its own 50 ms tick grid: a patience deadline is only
*discovered* when an event advances the clock past it, so a replay driven by
speech alone would attribute an evaluation to whenever the thinker next spoke.

**A vector cannot warm the analyst pool by wishing.** `analyst.candidates` says
what a cycle *would* return, never *whether* one runs. The runner mirrors the
host (`ios/App/SessionController.swift`) exactly: a pause is marked for the
analyst at the **evaluated pause** — not at `turnEnd`, which the machine emits
only when the gate answered `speak` — and only when it is **substantive**
(`wordCount >= GateConfig.substantiveWords`, the same number the gate reads), and
the cycle itself is a model call that takes real time and anchors its candidates
to the transcript as it stood when it *started*. So a vector whose only analyzed
pause is a brief aside gets a **cold pool**, and its landing measures the live-
call fallback — which is what a device would do. Shape the vector for the path
you mean to measure, and read the runner's per-vector `analyst:` trail to check
you got it.

| Vector | Asserts |
|--------|---------|
| `b1-01-trailing-conjunction-pause` | A pause after a trailing conjunction reads as "still going", the veto extends the floor past the resume, and the window never closes — the gate is never even asked. |
| `b1-02-filled-pause-disfluency` | Same, twice over, for a filled pause (`um`) and a discourse-marker pause (`,`) inside one unfinished sentence. |
| `b1-03-unpunctuated-pause-no-cue` | The decisive case: a mid-thought pause with **no** linguistic cue and no terminal punctuation (STT drops it routinely). `LinguisticEOU` returns its 0.6 "no strong cue" default. This is the vector that failed the first B1 measurement and forced the fix: 0.6 is *above* the 0.5 verdict boundary, so while the veto keyed on `incomplete` no veto fired and only the bare 200 ms floor stood between the thinker and an interruption. It now holds — 0.6 is *below* the veto's own 0.8 confidence bar, so the floor extends without the evidence being relabelled incomplete (spec §2). The vector is unchanged; the bar it measures moved. |
| `b1-04-landing-earns-one-brief-reply` | The other half of the bar: a landing still earns exactly one brief reply. Two landings, because the pool has a cold start — the first substantive landing marks the analyst and is answered by a live call, and only the second is drawn from a still-fresh pool candidate of the register the gate asked for. |

## Provenance / timing-only milestone note

These are **synthetic** event streams that encode the *timing structure* of
thinking-out-loud speech (sub-floor breath pauses, trailing-conjunction pauses
smart-turn reads as `incomplete`, and genuine end-of-thought silences). They
make the turn logic testable headlessly and become the U7 native-parity
fixtures. They are **not** raw audio: real recorded thinking-out-loud audio is
captured during the operator feel-test (the separate post-merge gate) and added
to `labeled/` as it accrues, with the VAD/smart-turn adapters converting audio →
this event stream. The schema is identical, so the corpus grows without a format
change.
