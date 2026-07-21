# Turn state machine — runtime-agnostic spec

Status: U3 (epic su-lou, Phase B / Rung 1), 2026-06-29.
Amended 2026-07-21 (su-lou.10.2): `Deciding` un-collapsed — the silence floor
triggers an **evaluation**, it does not make the decision. See §4a.

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
adapters (VAD speech segmentation, smart-turn end-of-utterance verdicts) plus the
host's response verdicts, and emits **turn events** (turn start, the evaluation
request, turn end, the stubbed response, barge-in). It contains no audio code and
calls no model — it is a pure reducer over `(state, event)`, which is why it is
testable by golden vector without a microphone, a model, or a browser.

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

The patience window closes when wall-clock time reaches `deadline` **and** the
speaker has not resumed — which triggers an *evaluation*, not an end-of-turn
(§4a). `verdict == "complete"` and `verdict == none` both yield the bare floor —
complete never accelerates.

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
| `deciding` | The patience window closed and an `evaluate` was emitted; waiting for the host's verdict on whether to speak. The plan diagram's *Deciding*. Carries **no timer** — it is left only by a `decision`, or by the thinker resuming. |
| `responding` | The listener has the floor: the response is "playing" (a stub for the timing-only milestone). Entered **only** on a `speak` verdict — the plan's Deciding → MinimalAck/Reflection/Question arms. |

Initial state: `listening`.

## 4a. Why `Deciding` is its own state

The floor **triggers evaluation; it does not make the decision**. A timer is a
poor proxy for "should I speak" — the intelligence should make that call, and it
has to be asked early enough that its answer still matters.

Until 2026-07-21 the floor did both: reaching the deadline emitted `turn-end` and
entered `responding` in one step, committing to a response before anything had
looked at the words. That collapse was deliberate and recorded (§7) — the
milestone was timing-only — but it makes the floor carry two jobs that pull in
opposite directions: patience (B1) wants it long; responsiveness wants it short.
**Splitting the trigger from the decision is what stops them competing**, and it
is a precondition for shortening the floor at all: at a short floor a machine
that cannot decline would take the floor several times per utterance.

So the deadline now emits `evaluate` — "the patience window closed; should the
listener speak?" — and the machine waits in `deciding`. The verdict arrives as an
ordinary **input event**, which is what keeps the reducer pure: it never calls the
gate itself, it asks and waits. Declining is free — `silence` re-arms straight to
`listening` with no response park — which is the property that makes frequent
evaluation affordable.

Two invariants hold this together:

- **Every `evaluate` must be answered.** `deciding` has no timeout by design (a
  timeout would put the clock back in charge of the decision). An unanswered
  evaluation parks the machine until the thinker resumes; a host that emits
  evaluations it never answers is broken, not patient.
- **Re-evaluation is evidence-driven, never clock-driven.** The machine
  re-evaluates when new evidence lands (a fresh EOU verdict, §6), and the host
  answers when the evidence it needs lands (a transcript resolving). Neither
  side polls, and there is no debounce timer.

What did **not** change: the asymmetric veto (§2) and the deadline equation. An
`incomplete` verdict may only lengthen patience, never shorten it. With the floor
at its 2000 ms default there is exactly one evaluation per utterance, so a host
that always answers `speak` reproduces the collapsed machine's emitted stream
event-for-event, plus the `evaluate` itself.

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
| `{ t, type: "decision", outcome }` | the host (response gate) | The answer to an outstanding `evaluate`. `outcome`: `"speak"` (take the floor) or `"silence"` (decline it). Ignored outside `deciding` — a verdict for an evaluation that was superseded or abandoned is stale. |
| `{ t, type: "tick" }` | timer | Advance wall-clock time with no discrete change. The browser feeds these periodically; a vector ends with one past the last deadline so the run is self-contained. |

Processing rule: handling any input first **advances time to `t`** (firing any
deadline that elapsed in the interval at its exact time), then applies the
discrete change.

### Output events (emitted)

| Event | Meaning |
|-------|---------|
| `{ t, type: "turn-start", turn }` | A new turn began (first speech after `listening`, or a fresh turn after barge-in). `turn` is a monotonically increasing id. |
| `{ t, type: "evaluate", turn, reason, trigger }` | **End-of-thought detected — should the listener speak?** A request for a verdict, not a decision. `reason`: `"floor"` (the patience window closed at the bare floor) or `"extended"` (it closed after an `incomplete` extension). `trigger`: `"deadline"` (the patience window closing) or `"evidence"` (a fresh verdict superseding an evaluation still awaiting an answer). This is the event a consumer aligns a transcript's turn boundary to, and the one endpointing is measured against — it fires whether or not the companion goes on to speak. |
| `{ t, type: "turn-end", turn, reason }` | The listener **takes the floor**: the thinker's turn is over and a response begins. Emitted only when a `speak` verdict answers an `evaluate`, at the moment the verdict arrives, carrying that evaluation's `reason`. A `silence` verdict ends no turn. |
| `{ t, type: "response-start", turn }` | Stubbed response began (immediately follows `turn-end`). |
| `{ t, type: "response-end", turn, reason }` | Stubbed response finished. `reason`: `"completed"` or `"barge-in"`. |
| `{ t, type: "barge-in", turn }` | The user spoke over a response; the floor is yielded instantly. `turn` is the interrupted turn. |

---

## 6. Transition table

`advance(t)` runs before every event and on every tick. It repeatedly applies
the first matching timer transition whose fire-time ≤ `t`:

- `pending` and `t ≥ deadline` → emit `evaluate` (`reason` per §2's deadline,
  `trigger: "deadline"`) at `deadline`; enter `deciding`. **No turn ends here** —
  `deciding` carries no timer, so nothing further can fire.
- `responding` and `t ≥ responseStart + responseDurationMs` → emit
  `response-end` (`reason: "completed"`) at that time; enter `listening`.

Discrete events (after `advance(t)`):

| In state | Event | Transition / emission |
|----------|-------|-----------------------|
| `listening` | `speech-start` | → `speaking`; `turn++`; emit `turn-start`. |
| `speaking` | `speech-start` | (already speaking) ignore. |
| `pending` | `speech-start` | Speaker resumed **before** the deadline (else `advance` already evaluated) → `speaking`, **same turn**; clear the pending verdict. No new turn. |
| `deciding` | `speech-start` | Speaker resumed while the verdict was outstanding. Nothing has been spoken, so there is no floor to yield and nothing to interrupt: **not** a barge-in. The evaluation is abandoned → `speaking`, **same turn**; clear the verdict. No new turn. |
| `responding` | `speech-start` | **Barge-in**: emit `barge-in`; emit `response-end` (`reason: "barge-in"`) — both at `t`; → `speaking`; `turn++`; emit `turn-start`. The yield is instant: the response is cut at `t`, not at its natural end. |
| `speaking` | `speech-end` | → `pending`; `silenceStart = t`; verdict ← none. |
| `deciding` | `decision` `"speak"` | The listener takes the floor: emit `turn-end` at `t` carrying the evaluation's `reason`; → `responding` with `responseStart = t`; emit `response-start` at `t`. |
| `deciding` | `decision` `"silence"` | The listener declines: → `listening`. **No** `turn-end`, **no** response park — declining costs nothing. |
| any other | `decision` | Ignore (stale: the evaluation it answers was superseded or abandoned). |
| `pending` | `eou` | Set the pending verdict (direct, or threshold `completionProb`). Recompute the deadline; settle (re-advance to `t`) in case the new verdict makes the deadline already due — e.g. an `incomplete` hold flips to `complete`. |
| `deciding` | `eou` | Set the verdict. If it **changed** it and `useSmartTurn`, emit a superseding `evaluate` at `t` (`trigger: "evidence"`, same `reason`). Stays in `deciding` — a re-evaluation is a fresh question, not an answer. |
| any other | `eou` | Ignore (no decision hangs on it). |
| any | `speech-end` outside `speaking` | Ignore (defensive; VAD should not emit it). |
| any | `tick` | No-op beyond the `advance(t)` already done. |

Notes:

- **Why `eou` only matters while `pending` and sub-floor**: with no verdict the
  deadline is the bare floor, so `advance` evaluates the instant the floor
  elapses. A verdict therefore only changes the *deadline* if it arrives *before*
  the floor — which smart-turn does (it runs ~12 ms after `speech-end`, far
  inside a multi-second floor). Arriving later it can still change the *decision*,
  which is what the `deciding` row is for.
- **Re-classification**: a later `eou` overrides the earlier verdict for the
  same pause; the deadline is recomputed from the latest. An `incomplete`→
  `complete` flip after the floor has passed evaluates immediately (at the
  moment the machine learns the thought is complete), never retroactively.
- **Barge-in starts a new turn** because the barge-in *is* a `speech-start`:
  the user is now talking, so a fresh turn is captured. The interrupted turn's
  response is closed with `reason: "barge-in"`.
- **`turn-end` is stamped at the verdict, not at the deadline.** The floor passes
  to the listener when the decision is made, so a host that deliberates for 300 ms
  starts its response 300 ms after the patience window closed — and says so. The
  deadline itself is not lost: it is the `evaluate`, which is what a transcript
  aligns to and what endpointing is scored against.

---

## 7. Mapping to the plan's state diagram

The 2026-06-25 plan draws the full pipeline's turn machine. Every state in it now
has a counterpart here; only the *register* of a response (which of the four rungs
is spoken) stays outside this machine, because it does not change the timing:

| Plan diagram | This spec |
|--------------|-----------|
| `Listening` | `listening` / `speaking` (split so a turn id can start on first speech) |
| `PauseDetected` | `pending` |
| `PauseDetected → Listening: speech resumes before floor` | `pending` + `speech-start` → `speaking` (same turn) |
| `PauseDetected → Deciding: floor elapsed AND EOU not incomplete` | `pending` deadline reached → `evaluate` → `deciding` |
| `PauseDetected → Listening: EOU incomplete holds turn open` | `incomplete` extends the deadline (§2) |
| `Deciding → Silence` | `decision "silence"` → `listening`, no `turn-end`, no response park |
| `Deciding → MinimalAck / Reflection / Question` | `decision "speak"` → `turn-end` → `responding` (which rung is spoken is the response gate's business, not the machine's) |
| `Reflection / Question → Listening: barge-in — yield instantly` | `responding` + `speech-start` → `barge-in` → `speaking` |

The timing-only milestone originally collapsed `Deciding` into `responding` and
stubbed the fan-out; su-lou.10.2 restored the state (§4a). U4–U6 expand what
happens *inside* `responding` (STT → listener-LLM → TTS); the timing contract in
§2 does not change.

---

## 8. Determinism and the golden-vector contract

The machine is fully deterministic in `(knobs, event stream)`: timer
transitions fire at computed times, not at tick granularity, so a vector that
lists only the discrete events plus one terminal `tick` pins down the exact
emitted output. This is what makes the vectors a **cross-runtime parity
fixture**: Rung 2 (native) must reproduce the same emitted events from the same
inputs, or it has diverged from this spec. See
[turn-vectors/README.md](turn-vectors/README.md).

Since §4a, the host's verdict is part of that event stream: a vector supplies
`decision` events exactly as it supplies `speech-start` or `eou`, so what the
host decided — and *when* — is pinned rather than assumed. A vector that lets the
patience window close and supplies no `decision` asserts the machine **waits**;
that is a contract too, and `07`/`08`/`09` cover the answered and abandoned cases.

The one place the reducer must accommodate its host: a host that answers an
`evaluate` the moment it observes one re-enters the machine from inside its own
emit callback. Such an event is applied after the in-flight one settles, and its
output joins the same batch — the caller sees one ordered stream either way, so
answering synchronously and answering later differ only in the verdict's
timestamp.
