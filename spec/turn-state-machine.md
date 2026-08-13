# Turn state machine — runtime-agnostic spec

Status: U3 (epic su-lou, Phase B / Rung 1), 2026-06-29.
Amended 2026-07-21 (su-lou.10.2): `Deciding` un-collapsed — the silence floor
triggers an **evaluation**, it does not make the decision. See §4a.
Amended 2026-07-22 (su-lou.10.4): a turn is one **utterance**, counted separately
from the **evaluation** ticks inside it; only the listener taking the floor ends
one. See §4b.

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

   | EOU reading on the current pause | Effect on the turn |
   |----------------------------------|--------------------|
   | not *confidently* complete — `P(complete) < confidentCompletionThreshold`, which includes every `incomplete` verdict | **Holds the turn open past the floor** — extends the deadline by `incompleteExtensionMs`. |
   | confidently complete — `P(complete) ≥ confidentCompletionThreshold` | **Ignored until the floor elapses** — never shortens the deadline below the floor; no short-circuit. |
   | a bare `complete`/`incomplete` verdict with no score | The two-valued rule: `incomplete` extends, `complete` does not. |
   | none / smart-turn off | Deadline is exactly the floor. |

   The veto may only *lengthen* patience, never shorten it. This is what lets
   the floor be set shorter without cutting people off: it absorbs the
   mid-thought pauses the bare floor would clip.

   **The veto has its own bar, ABOVE the verdict boundary** (su-uzy9.5). It was
   once `verdict == "incomplete"`, i.e. the same `completionThreshold` the
   response gate reads for its rule 2 — and that single number decided both
   "stay patient" and "stay silent". An uncued mid-thought pause defeats both at
   once under that arrangement: the linguistic EOU scores a bare unpunctuated
   ending 0.6 — its own "no strong cue" default, *weak evidence of completeness
   at best* — which clears a 0.5 boundary, so the floor is not extended and the
   gate does not hold. At a 200 ms floor that is 200 ms between a thinker drawing
   breath and an interruption (`docs/findings/b1-gate-measurement-2026-08.md`,
   vector `b1-03`).

   Splitting the bars separates the two questions. `confidentCompletionThreshold`
   asks *how long to stay patient* and demands a POSITIVE completeness cue to
   release the floor; `completionThreshold` asks *whether the thinker read as
   mid-thought* and is unchanged. The band between them —
   `[completionThreshold, confidentCompletionThreshold)` — is "weak evidence of
   completeness": it buys extra patience **without** the verdict having to claim
   the utterance is incomplete, which would be a lie about the evidence. Because
   the veto only ever lengthens the floor, a weak-cue pause that turns out
   finished costs a little latency and never an interruption.

   **Ordering invariant.** The band exists only while
   `confidentCompletionThreshold ≥ completionThreshold`. Only the *defaults* are
   pinned that way: `completionThreshold` carries a live 0..1 slider and the
   confident bar carries no knob, so a retune past `0.8` inverts the pair. An
   inverted pair is worse than a welded one — a pause scoring inside it is called
   `incomplete` and *still* clears the confidence bar, collecting neither the
   extra patience nor, for a host that mistakes the patience reason for a score,
   rule-2 silence. So an implementation **must floor the veto's bar at
   `completionThreshold` where it reads it**, rather than trusting the two
   numbers to stay ordered. That keeps the guarantee that an `incomplete` verdict
   ALWAYS extends, and at the shipped defaults changes nothing.

   **The two readers stay independent.** `confidentCompletionThreshold` is the
   detector's alone; the response gate never sees it. A host wiring the detector
   to the gate must pass the pause's actual `P(complete)`, **not** a probability
   reconstructed from the patience `reason` — since `"extended"` no longer implies
   `incomplete`, such a bridge reports certainty the classifier never expressed
   and re-welds the two mechanisms one layer up (§5).

   A host that **caches** that score when the window closes — rather than reading
   it at gate time — owes it a second read. An evidence-driven re-evaluation keeps
   the same `evaluation` id (§4b) *precisely because* the score behind it changed,
   and after a blind first evaluation (the deadline closing before any verdict
   lands) the cached value is the absent one. Dismissing that re-emit as a
   duplicate of a mark already made leaves the gate on the reason-bridge this
   paragraph forbids — arrived at not by choosing it, but by never noticing the
   score turned up. Deadline fields (`t`, `reason`) are the ones the re-emit does
   not move; the score is the one it exists to move.

### Deadline (the one equation)

While timing a pause, the turn-end deadline (in absolute time) is:

```
confidentBar = max(confidentCompletionThreshold, completionThreshold)

extended = useSmartTurn && (P(complete) is known
                              ? !(P(complete) >= confidentBar)
                              : verdict == "incomplete")

deadline = silenceStart + silenceFloorMs + (extended ? incompleteExtensionMs : 0)
```

The patience window closes when wall-clock time reaches `deadline` **and** the
speaker has not resumed — which triggers an *evaluation*, not an end-of-turn
(§4a). A confidently-complete reading and no reading at all both yield the bare
floor — completeness never accelerates.

`P(complete) is known` means the pause's verdict was derived from a score
(`completionProb`) rather than supplied as a bare verdict; an explicitly supplied
verdict wins over any score, and takes the two-valued arm. `!(P >= bar)` rather
than `P < bar` so a non-finite score — no evidence — extends rather than slipping
through as complete, matching how a `completionProb` that cannot be thresholded
resolves to `incomplete`. `confidentBar` is the ordering invariant of §2 applied
at the point of reading.

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
| `silenceFloorMs` | `200` | Patience window: min silence before a pause may end the turn. |
| `incompleteExtensionMs` | `4000` | Extra patience added when the pause is not confidently complete (§2). |
| `completionThreshold` | `0.5` | smart-turn P(complete) ≥ threshold ⇒ `complete`, else `incomplete`. The **verdict** boundary, and the response gate's rule-2 boundary. Higher ⇒ more pauses read as `incomplete`. |
| `confidentCompletionThreshold` | `0.8` | smart-turn P(complete) ≥ threshold ⇒ the veto stops extending the floor. The **patience** boundary. Sits above the linguistic EOU's no-cue default (`0.6`) and below its positive cues (terminal punctuation `0.85`, wrap-up `0.95`), so only a positive cue releases the floor. Read by this machine only; must be ≥ `completionThreshold` (§2). |
| `responseDurationMs` | `1500` | Length of the stubbed canned response (timing-only milestone). |
| `useSmartTurn` | `true` | `false` ⇒ patience-only baseline arm (ignore all EOU verdicts). |

`completionThreshold` has a SECOND reader outside this machine. The
response-hierarchy gate thresholds the same `P(complete)` for its own rule 2
(hold silence when the thinker read as mid-thought), so the two must agree: they
share one default (`web/src/completion-threshold.ts`) and the live app derives
the gate's runtime value from this knob (`gateConfigFromTurnKnobs`). Retuning it
therefore moves both boundaries at once — which is the point. Letting them
diverge yields a companion that holds the turn open and then answers anyway, or
ends the turn and then refuses to speak.

What that shared boundary must NOT also decide is *how long to stay patient*.
That is `confidentCompletionThreshold`, which this machine reads alone and never
shares with the gate (§2) — it is a second, higher bar on the same probability,
not a second copy of the same bar. Retuning `completionThreshold` still moves the
verdict and the gate together; it does not move the veto, except through the
ordering floor.

Nothing about this machine's golden vectors changes: at the shipped defaults a
score below `0.5` still reads `incomplete` and still extends, and the vectors
that carry a bare verdict take the two-valued arm untouched.

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

What did **not** change: the asymmetry of the veto (§2) and the shape of the
deadline equation. The veto may only lengthen patience, never shorten it — and
that still holds for every `incomplete` verdict, whose extension the ordering
floor guarantees. What su-uzy9.5 later changed is which readings *earn* the
extension, not what the extension does. With the floor
at 2000 ms there is exactly one evaluation per utterance, so a host
that always answers `speak` reproduces the collapsed machine's emitted stream
event-for-event, plus the `evaluate` itself. (At the 200 ms default, a single
utterance routinely draws several evaluations — which is why §4b splits the
utterance id from the evaluation-tick id.)

---

## 4b. What ends a turn — the utterance / evaluation split

A **turn** is one *utterance*: everything the thinker says until the listener takes
the floor. An **evaluation** is one closing of the patience window — a question put
to the host, answerable either way. Since §4a they are different things, and the
machine counts them separately: `turn` on the one hand, `evaluation` on the other.

**Only the listener taking the floor ends a turn.** Concretely, `turn++` happens on
exactly two edges, and both mean "the previous turn is over":

- a `speak` verdict → `turn-end` → the thinker's turn is finished, so the *next*
  speech is a new one;
- `dropTurn()` → the host abandoned the conversation (a mode switch, a fresh script).
  Not a transition — it emits nothing and moves no state; it exists because throwing
  the transcript away is the one turn boundary that is not a spoken response.

A **`silence` verdict ends nothing.** The window closed, the host declined, and the
thinker was never interrupted — so when they resume it is the same thought, the same
`turn`, and **no `turn-start` is emitted**. This is what makes declining free
*downstream* as well as inside the machine.

Why it must be this way, and why now: the floor is about to get short (su-lou.10.5),
and a short floor draws several evaluations per thought. Counting those as separate
turns is not a cosmetic mislabel — everything calibrated to a thought reads the
wrong number:

| Reads `turn` as | Breaks how, if a tick counts as a turn |
|-----------------|----------------------------------------|
| the transcript grouping | one thought is split across several blocks |
| the gate's word count | a substantive thought arrives as a "brief turn" and is **backchannelled over mid-sentence** |
| the question cooldown | "don't ask twice in a row" is measured in breaths, so it clears early |
| the prior-decision history | pauses within one thought read as separate exchanges |
| one loop-metrics iteration | a declined window becomes the origin of a loop that never ran |

The second row is the sharp one: at a 500 ms floor a mid-sentence pause carries only
a few words, the gate's rule 4 reads a short finished aside, and the companion says
"mm." over someone who is still talking. Feeding it the utterance so far instead of
the fragment is the fix, and it is only expressible once the two identities are
distinct.

**Which id goes where.** An evaluation belongs to exactly one turn; a turn may have
many. A window closing at the deadline opens a *new* evaluation; the evidence-driven
re-evaluation that supersedes one (§6) keeps its id, because it is the same question
asked again with better evidence. `turn-end` names the evaluation the `speak` verdict
answered. Barge-in is untouched (**B2**): reaching `responding` means the floor was
already taken, so the interrupting speech opens a new turn exactly as before.

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
| `{ t, type: "turn-start", turn }` | A new turn — a new **utterance** — began: the first speech after the previous turn ended (or after `dropTurn()`), or a fresh turn after barge-in. `turn` is a monotonically increasing id. **Not** emitted when the thinker resumes into a turn that is still open, whether the pause went un-evaluated or the host declined it (§4b). |
| `{ t, type: "evaluate", turn, evaluation, reason, trigger }` | **End-of-thought detected — should the listener speak?** A request for a verdict, not a decision. `evaluation` is a monotonically increasing id for the window closure; one `turn` may carry several (§4b). `reason`: `"floor"` (the patience window closed at the bare floor) or `"extended"` (it closed after a veto extension — i.e. the pause was **not confidently complete**, which is broader than `incomplete` and does NOT imply it; §2). `reason` is a patience outcome and must not be read back as a completeness score — a consumer that needs `P(complete)` takes it from the machine's snapshot, not from this field. `trigger`: `"deadline"` (the patience window closing — a NEW `evaluation`) or `"evidence"` (a fresh verdict superseding an evaluation still awaiting an answer — the SAME `evaluation`). This is the event a consumer aligns a transcript's turn boundary to, and the one endpointing is measured against — it fires whether or not the companion goes on to speak. |
| `{ t, type: "turn-end", turn, evaluation, reason }` | The listener **takes the floor**: the thinker's turn is over and a response begins. Emitted only when a `speak` verdict answers an `evaluate`, at the moment the verdict arrives, carrying that evaluation's id and `reason`. A `silence` verdict ends no turn. |
| `{ t, type: "response-start", turn }` | Stubbed response began (immediately follows `turn-end`). |
| `{ t, type: "response-end", turn, reason }` | Stubbed response finished. `reason`: `"completed"` or `"barge-in"`. |
| `{ t, type: "barge-in", turn }` | The user spoke over a response; the floor is yielded instantly. `turn` is the interrupted turn. |

### Snapshot (read, not emitted)

A non-mutating `peek(now)` returns the live view a host renders and hands
downstream. It is not part of the golden-vector stream — vectors pin emitted
events — but it **is** part of the cross-runtime contract, because it carries the
two things `reason` and `verdict` no longer imply on their own:

| Field | Meaning |
|-------|---------|
| `state`, `turn`, `evaluation`, `verdict` | The current state, utterance id, evaluation-tick id, and two-valued EOU verdict (`null` before any evidence). |
| `completionProb` | The graded `P(complete)` the current pause's `verdict` came from, or `null` when the evidence was a bare verdict or there is none yet. Cleared wherever `verdict` is (speech resume, a new pause), which is why the machine — not the host — owns it. |
| `extended` | Whether the veto is extending this pause's floor (§2). `false` outside `pending`. |
| `msUntilTurnEnd` | ms until the patience window closes, or `null` when no pause is being timed. |

**Hosts must read `completionProb` from here**, not reconstruct it from the
patience `reason`. The two answer different questions since §2 split the bars,
and the reconstruction is wrong in exactly the band the split exists to serve: it
reports "certainly incomplete" for a pause the classifier scored above
`completionThreshold`, so every floor extension forces the response gate's rule-2
silence and the companion waits out the extension only to refuse to speak. Read
it while the snapshot is still that pause's — from an emit callback inside the
input call, before the same call's discrete change can resume speech and clear
it.

`advance(t)` runs before every event and on every tick. It repeatedly applies
the first matching timer transition whose fire-time ≤ `t`:

- `pending` and `t ≥ deadline` → `evaluation++`; emit `evaluate` (`reason` per §2's
  deadline, `trigger: "deadline"`) at `deadline`; enter `deciding`. **No turn ends
  here** — `deciding` carries no timer, so nothing further can fire.
- `responding` and `t ≥ responseStart + responseDurationMs` → emit
  `response-end` (`reason: "completed"`) at that time; enter `listening`.

Discrete events (after `advance(t)`):

| In state | Event | Transition / emission |
|----------|-------|-----------------------|
| `listening` | `speech-start` | → `speaking`. If the turn ENDED (a `speak` verdict, or `dropTurn()`): `turn++`; emit `turn-start`. If it is still open — the host answered `silence` and the thinker resumed — the **same turn** continues and nothing is emitted (§4b). |
| `speaking` | `speech-start` | (already speaking) ignore. |
| `pending` | `speech-start` | Speaker resumed **before** the deadline (else `advance` already evaluated) → `speaking`, **same turn**; clear the pending verdict. No new turn. |
| `deciding` | `speech-start` | Speaker resumed while the verdict was outstanding. Nothing has been spoken, so there is no floor to yield and nothing to interrupt: **not** a barge-in. The evaluation is abandoned → `speaking`, **same turn**; clear the verdict. No new turn. |
| `responding` | `speech-start` | **Barge-in**: emit `barge-in`; emit `response-end` (`reason: "barge-in"`) — both at `t`; → `speaking`; `turn++`; emit `turn-start`. The yield is instant: the response is cut at `t`, not at its natural end. |
| `speaking` | `speech-end` | → `pending`; `silenceStart = t`; verdict ← none. |
| `deciding` | `decision` `"speak"` | The listener takes the floor: the turn is now ENDED (§4b); emit `turn-end` at `t` carrying the evaluation's id and `reason`; → `responding` with `responseStart = t`; emit `response-start` at `t`. |
| `deciding` | `decision` `"silence"` | The listener declines: → `listening`, turn still **open**. **No** `turn-end`, **no** response park — declining costs nothing. |
| any other | `decision` | Ignore (stale: the evaluation it answers was superseded or abandoned). |
| `pending` | `eou` | Set the pending verdict (direct, or threshold `completionProb`) and retain the score it came from, which is what the veto weighs (§2) and what a host hands the response gate. Recompute the deadline; settle (re-advance to `t`) in case the new reading makes the deadline already due — e.g. a hold releases because the fresh score clears the confidence bar. |
| `deciding` | `eou` | Set the verdict. If it **changed** it and `useSmartTurn`, emit a superseding `evaluate` at `t` (`trigger: "evidence"`, same `reason`, same `evaluation` — the window has not closed again, only the evidence improved). Stays in `deciding` — a re-evaluation is a fresh question, not an answer. |
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
  same pause; the deadline is recomputed from the latest. A flip from held to
  *confidently* complete after the floor has passed evaluates immediately (at the
  moment the machine learns the thought is finished), never retroactively. A flip
  that only crosses `completionThreshold` — into the weak-cue band — changes the
  verdict but not the hold: the floor stays extended, because the evidence still
  is not a positive completeness cue (§2).
- **Barge-in starts a new turn** because reaching `responding` means the floor was
  already taken — which ended the interrupted turn (§4b) — so the speech that
  interrupts it is a new one. The interrupted turn's response is closed with
  `reason: "barge-in"`, instantly, at `t`.
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
| `PauseDetected → Deciding: floor elapsed AND EOU not incomplete` | `pending` deadline reached → `evaluate` → `deciding`. The plan's "not incomplete" is now "confidently complete" — the bar the veto releases on (§2). |
| `PauseDetected → Listening: EOU incomplete holds turn open` | the veto extends the deadline (§2) — for an `incomplete` verdict, and also for the weak-cue band the plan had no name for |
| `Deciding → Silence` | `decision "silence"` → `listening`, no `turn-end`, no response park — and the turn stays open (§4b) |
| `Deciding → MinimalAck / Reflection / Question` | `decision "speak"` → `turn-end` → `responding` (which rung is spoken is the response gate's business, not the machine's) |
| `Reflection / Question → Listening: barge-in — yield instantly` | `responding` + `speech-start` → `barge-in` → `speaking` |

The timing-only milestone originally collapsed `Deciding` into `responding` and
stubbed the fan-out; su-lou.10.2 restored the state (§4a) and su-lou.10.4 made the
turn id mean what the diagram always meant by it (§4b). U4–U6 expand what happens
*inside* `responding` (STT → listener-LLM → TTS); the timing contract in §2 does not
change.

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
