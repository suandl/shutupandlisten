# Turn state machine — runtime-agnostic spec

Status: U3 (epic su-lou, Phase B / Rung 1), 2026-06-29.

This is the **runtime-agnostic** definition of the quiet-companion's
turn-detection layer — the product-defining component (CONCEPTS.md:
*endpointing*, *patience window*). It is the shared contract between the
browser build (Rung 1, `web/src/turn-detection.ts`) and the later
Apple-Silicon-native build (Rung 2, `native/`). Both runtimes reimplement
**this document**; they share the algorithm and the
[golden vectors](turn-vectors/README.md), not the code.

> "reuse U3 logic" means the spec, not the TypeScript.
> — 2026-06-25 validation plan, Two-runtimes note.

The state machine consumes a stream of **timed events** off the audio
adapters (VAD speech segmentation, smart-turn end-of-utterance verdicts) and
emits **turn events** (turn start / end, the stubbed response, barge-in). It
contains no audio code: it is a pure reducer over `(state, event)`, which is
why it is testable by golden vector without a microphone, a model, or a
browser.

---

## 1. Design axiom — the asymmetric error cost

A quiet thought companion must **never mistake a thinking-pause for a finished
thought**. The two failure modes are not equal:

- **False cutoff** — ending the turn while the speaker is mid-thought. The
  *cardinal sin* (usefulness bar **B1**). The speaker is interrupted; the
  product is dead on arrival.
- **False continuation** — staying silent when the speaker actually finished
  and invited a reply. Benign and on-brand: the companion biases to silence
  anyway.

Every rule below resolves ties toward **keeping the turn open**.

---

## 2. The patience window and the asymmetric veto

Two layers decide end-of-turn. They are a single coupled tradeoff, not two
independent gates.

1. **Silence floor (the patience window)** — *primary*. The minimum silence,
   in seconds, that must elapse after speech stops before the turn may end.
   Raised well past the sub-second defaults of latency-minimizing voice agents
   (order of seconds), because the speaker is *gathering their thoughts*.

2. **smart-turn v3 end-of-utterance (EOU) verdict** — a *veto layer on top of*
   the floor, never a replacement for it. Off-the-shelf EOU answers "is this
   utterance grammatically/prosodically *complete*?", not "is this person
   *done thinking*?" — so it is used **asymmetrically**:

   | EOU verdict on the current pause | Effect on the turn |
   |----------------------------------|--------------------|
   | `incomplete` | **Holds the turn open past the floor** — extends the deadline by `incompleteExtensionMs`. |
   | `complete`   | **Ignored until the floor elapses** — never shortens the deadline below the floor; no short-circuit. |
   | none / smart-turn off | Deadline is exactly the floor. |

   The veto may only *lengthen* patience, never shorten it. This is what lets
   the floor be set shorter without cutting people off: a reliable
   `incomplete` signal absorbs the mid-thought pauses the bare floor would
   clip.

### Deadline (the one equation)

While timing a pause, the turn-end deadline (in absolute time) is:

```
deadline = silenceStart + silenceFloorMs
         + (useSmartTurn && verdict == "incomplete" ? incompleteExtensionMs : 0)
```

The turn ends when wall-clock time reaches `deadline` **and** the speaker has
not resumed. `verdict == "complete"` and `verdict == none` both yield the bare
floor — complete never accelerates.

`useSmartTurn = false` collapses the machine to the **patience-only baseline
arm** (deadline = floor, always). This is the control arm scenario 6 measures
the veto against.

---

## 3. Knobs (live-tunable)

All knobs are adjustable **at runtime** — the operator tunes patience against
the usefulness bar during a live session, and changes take effect on the next
pause. Defaults bias to "keep listening".

| Knob | Default | Meaning |
|------|---------|---------|
| `silenceFloorMs` | `2000` | Patience window: min silence before a pause may end the turn. |
| `incompleteExtensionMs` | `4000` | Extra patience added when the EOU verdict is `incomplete`. |
| `completionThreshold` | `0.5` | smart-turn P(complete) ≥ threshold ⇒ `complete`, else `incomplete`. Higher ⇒ more pauses read as `incomplete` ⇒ more patient. |
| `responseDurationMs` | `1500` | Length of the stubbed canned response (timing-only milestone). |
| `useSmartTurn` | `true` | `false` ⇒ patience-only baseline arm (ignore all EOU verdicts). |

The VAD's own thresholds (positive/negative speech probability, redemption
frames) are adapter-level knobs documented in `web/src/vad.ts`; they shape the
`speech-start` / `speech-end` event stream this machine consumes, but are not
part of the runtime-agnostic timing logic and so are not golden-vector inputs.

---

## 4. States

| State | Meaning |
|-------|---------|
| `listening` | Default. No active turn; waiting for speech. Also the resting state between turns. |
| `speaking` | VAD reports speech; the user is talking. A turn is active. |
| `pending` | Speech stopped; timing the silence floor (± EOU extension). The *PauseDetected* state of the plan diagram. |
| `responding` | The stubbed canned response is "playing". Stands in for the plan's Deciding → Silence/Ack/Reflection/Question fan-out, collapsed to one stub for the timing-only milestone. |

Initial state: `listening`.

---

## 5. Events

### Input events (from the audio adapters / a golden vector)

Every event carries a monotonic timestamp `t` in **milliseconds** since session
start.

| Event | Source | Meaning |
|-------|--------|---------|
| `{ t, type: "speech-start" }` | VAD | Speech onset. |
| `{ t, type: "speech-end" }` | VAD | Speech offset (silence onset). |
| `{ t, type: "eou", verdict?, completionProb? }` | smart-turn | End-of-utterance verdict for the just-ended segment. Provide `verdict` (`"complete"`/`"incomplete"`) directly, or `completionProb` ∈ [0,1] to be thresholded by `completionThreshold`. Typically arrives a few ms after `speech-end`. |
| `{ t, type: "tick" }` | timer | Advance wall-clock time with no discrete change. The browser feeds these periodically; a vector ends with one past the last deadline so the run is self-contained. |

Processing rule: handling any input first **advances time to `t`** (firing any
deadline that elapsed in the interval at its exact time), then applies the
discrete change.

### Output events (emitted)

| Event | Meaning |
|-------|---------|
| `{ t, type: "turn-start", turn }` | A new turn began (first speech after `listening`, or a fresh turn after barge-in). `turn` is a monotonically increasing id. |
| `{ t, type: "turn-end", turn, reason }` | End-of-thought detected. `reason`: `"floor"` (ended at the bare floor) or `"extended"` (ended after an `incomplete` extension). |
| `{ t, type: "response-start", turn }` | Stubbed response began (immediately follows `turn-end`). |
| `{ t, type: "response-end", turn, reason }` | Stubbed response finished. `reason`: `"completed"` or `"barge-in"`. |
| `{ t, type: "barge-in", turn }` | The user spoke over a response; the floor is yielded instantly. `turn` is the interrupted turn. |

---

## 6. Transition table

`advance(t)` runs before every event and on every tick. It repeatedly applies
the first matching timer transition whose fire-time ≤ `t`:

- `pending` and `t ≥ deadline` → emit `turn-end` at `deadline`; enter
  `responding` with `responseStart = deadline`; emit `response-start` at
  `deadline`.
- `responding` and `t ≥ responseStart + responseDurationMs` → emit
  `response-end` (`reason: "completed"`) at that time; enter `listening`.

Discrete events (after `advance(t)`):

| In state | Event | Transition / emission |
|----------|-------|-----------------------|
| `listening` | `speech-start` | → `speaking`; `turn++`; emit `turn-start`. |
| `speaking` | `speech-start` | (already speaking) ignore. |
| `pending` | `speech-start` | Speaker resumed **before** the deadline (else `advance` already ended the turn) → `speaking`, **same turn**; clear the pending verdict. No new turn. |
| `responding` | `speech-start` | **Barge-in**: emit `barge-in`; emit `response-end` (`reason: "barge-in"`) — both at `t`; → `speaking`; `turn++`; emit `turn-start`. The yield is instant: the response is cut at `t`, not at its natural end. |
| `speaking` | `speech-end` | → `pending`; `silenceStart = t`; verdict ← none. |
| `pending` | `eou` | Set the pending verdict (direct, or threshold `completionProb`). Recompute the deadline; settle (re-advance to `t`) in case the new verdict makes the deadline already due — e.g. an `incomplete` hold flips to `complete`. |
| any other | `eou` | Ignore (no pause is being timed). |
| any | `speech-end` outside `speaking` | Ignore (defensive; VAD should not emit it). |
| any | `tick` | No-op beyond the `advance(t)` already done. |

Notes:

- **Why `eou` only matters while `pending` and sub-floor**: with no verdict the
  deadline is the bare floor, so `advance` ends the turn the instant the floor
  elapses. A verdict therefore only changes the outcome if it arrives *before*
  the floor — which smart-turn does (it runs ~12 ms after `speech-end`, far
  inside a multi-second floor). A verdict arriving after the turn already ended
  lands outside `pending` and is ignored.
- **Re-classification**: a later `eou` overrides the earlier verdict for the
  same pause; the deadline is recomputed from the latest. An `incomplete`→
  `complete` flip after the floor has passed ends the turn immediately (at the
  moment the machine learns the thought is complete), never retroactively.
- **Barge-in starts a new turn** because the barge-in *is* a `speech-start`:
  the user is now talking, so a fresh turn is captured. The interrupted turn's
  response is closed with `reason: "barge-in"`.

---

## 7. Mapping to the plan's state diagram

The 2026-06-25 plan draws the full pipeline's turn machine. This milestone is
**timing-only**, so the response fan-out collapses:

| Plan diagram | This spec |
|--------------|-----------|
| `Listening` | `listening` / `speaking` (split so a turn id can start on first speech) |
| `PauseDetected` | `pending` |
| `PauseDetected → Listening: speech resumes before floor` | `pending` + `speech-start` → `speaking` (same turn) |
| `PauseDetected → Deciding: floor elapsed AND EOU not incomplete` | `pending` deadline reached → `turn-end` → `responding` |
| `PauseDetected → Listening: EOU incomplete holds turn open` | `incomplete` extends the deadline (§2) |
| `Deciding → Silence / MinimalAck / Reflection / Question` | collapsed to one stubbed `responding` |
| `Reflection / Question → Listening: barge-in — yield instantly` | `responding` + `speech-start` → `barge-in` → `speaking` |

U4–U6 expand `responding` into the STT → listener-LLM → TTS fan-out; the
timing contract in §2 does not change.

---

## 8. Determinism and the golden-vector contract

The machine is fully deterministic in `(knobs, event stream)`: timer
transitions fire at computed times, not at tick granularity, so a vector that
lists only the discrete events plus one terminal `tick` pins down the exact
emitted output. This is what makes the vectors a **cross-runtime parity
fixture**: Rung 2 (native) must reproduce the same emitted events from the same
inputs, or it has diverged from this spec. See
[turn-vectors/README.md](turn-vectors/README.md).
