# Golden turn vectors

Cross-runtime parity fixtures for the [turn state machine](../turn-state-machine.md).
A vector is a deterministic input event stream plus the expected output; any
runtime that implements the spec must reproduce the expected output exactly.
The U3 browser build (`web/src/turn-detection.ts`) and the U7 native build both
run against these — "reuse U3 logic" means these vectors and the spec, not the
code.

Two kinds live here:

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

These six cover the plan's scenarios 1–5 plus the asymmetric-veto hold:

| Vector | Plan scenario | Asserts |
|--------|---------------|---------|
| `01-subfloor-pause-preserved` | 1 | A sub-floor pause emits **no** turn-end (the cardinal-failure guard / TDD red anchor). |
| `02-floor-elapsed-one-end` | 2 | Silence past the floor with no `incomplete` emits **exactly one** turn-end, at the floor. |
| `03-complete-no-shortcircuit` | 3 | A `complete` verdict during a sub-floor pause does **not** end before the floor. |
| `04-resume-continues-turn` | 4 | Speech resuming after a sub-floor pause continues the **same** turn (one turn-start, one turn-end). |
| `05-barge-in-yields` | 5 | Speaking over a response yields **instantly** (response-end `reason: barge-in` at the interrupt, new turn). |
| `06-incomplete-extends-floor` | (§2 veto) | An `incomplete` verdict holds the turn open to `floor + extension` (`reason: extended`); the value the EOU adds over the bare floor. |

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
veto) and `useSmartTurn:false` (patience-only baseline) — and scores
`turn-end`s against `trueTurnBoundaries`:

- **false cutoff** — a turn-end with no true boundary within tolerance (ended
  mid-thought: the cardinal sin).
- **false continuation** — a true boundary with no turn-end within tolerance
  (stayed silent when the thought was done).

The veto must **beat the bare floor** to earn its place: no more false cutoffs
and no worse total error. The floor in `labeled/` is set deliberately *short*
(sub-second) — that is where the bare floor clips mid-thought pauses and the
`incomplete` veto demonstrably rescues them; at a multi-second floor neither arm
cuts off and the comparison is empty.

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
