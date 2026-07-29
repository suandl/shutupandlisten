# Demo: The silence floor drops to 200ms — the operator's feel-test picks the value

**Start:** `/?llm=off&tts=off`

Proof of what PR #33 (su-lou.10.6) changed: the patience window — how long the companion
waits through a pause before it may take the turn — now opens at 200ms instead of 2000ms,
and the value was PICKED, not guessed. The floor-sweep ladder is the instrument: six fixed
rungs, the same every sitting, retuning the live session so the operator can A/B the same
pause by feel. Driven mic-lessly against sim mode, so the pause is identical across both
settings and the difference is only the knob.

Generated from bead su-lou.10.6 with the gc-toolkit `gc-demo-script` skill, then adapted
to this harness: sim-mode entrypoint, directives, and a machine assertion per step (see
docs/pr-demo-flow.md).

## Steps

1. **The companion now waits a fifth of a second, not two**
   `waitFor #k-silenceFloorMs-v`
   The live knobs panel opens on the ratified default — the feel-test's verdict, in the
   control the feel-test was rating.
   _Prove:_ the patience window reads 200 ms — `text #k-silenceFloorMs-v ~ "200 ms"`
   _Fail if:_ it still opens on the old two-second default — `text #k-silenceFloorMs-v ~ "2000 ms"`

2. **A ladder of fixed rungs sits under the knobs, so sittings compare like with like**
   `scroll #floor-sweep`
   `wait 300`
   Six pinned values from the comfortable end of the sweep down to the shortest — a
   dragged slider cannot land on the same value twice, and a feel-test that cannot
   repeat a value cannot compare two of them.
   _Prove:_ the sweep offers its six rungs — `count #floor-sweep button == 6`
   _Fail if:_ the ladder is missing and only the slider remains — `count #floor-sweep button < 6`

3. **Picking a rung retunes the live window — no reload, no rebuild**
   `click #floor-sweep button:has-text("1500ms")`
   `wait 300`
   The rung drives the slider itself, so the slider, its readout and the detector cannot
   disagree about which value is live.
   _Prove:_ the patience window jumps to the chosen rung — `text #k-silenceFloorMs-v ~ "1500 ms"`
   _Fail if:_ the readout is still on the previous rung — `text #k-silenceFloorMs-v ~ "200 ms"`

4. **At a patient setting, a mid-thought pause is waited through**
   `click #sim-controls button:has-text("Thinking pause")`
   `wait 2400`
   The scenario speaks for 1.6s, then pauses 1.2s mid-thought. At a 1500ms window that
   pause never reaches the deadline: the turn stays open and the thought is not cut off.
   _Prove:_ nothing closed the patience window during the pause — `count #log .evaluate == 0`
   _Fail if:_ the window closed inside the pause — `count #log .evaluate >= 1`

5. **The very same pause, at the shortest rung, ends the turn mid-thought**
   `click #floor-sweep button:has-text("200ms")`
   `click #sim-controls button:has-text("Thinking pause")`
   `wait 2400`
   Same scenario, same pause, one knob different — the window now closes inside it and the
   companion evaluates whether to take the turn. This is the trade the feel-test was
   rating: responsiveness bought with the risk of cutting an unfinished thought.
   _Prove:_ the patience window closed inside the same pause — `count #log .evaluate >= 1`
   _Fail if:_ the rung never took effect — `text #k-silenceFloorMs-v ~ "1500 ms"`

6. **A chosen value is a link, so the next sitting starts where this one ended**
   `goto /?silenceFloorMs=750&llm=off&tts=off`
   `waitFor #k-silenceFloorMs-v`
   `wait 300`
   A rung the operator liked is a URL they can re-open or paste into the bead — where
   "I think it was around 700" is not a measurement.
   _Prove:_ a fresh load comes up pinned at the value in the link — `text #k-silenceFloorMs-v ~ "750 ms"`
   _Fail if:_ the link is ignored and the default returns — `text #k-silenceFloorMs-v ~ "200 ms"`

## Scrutiny

- The rung values are identical every sitting — a feel-test that cannot repeat a value cannot compare two of them
- At 200ms the end-of-turn verdict (~270ms warmed) has NOT landed when the window first closes, so the smart-turn veto cannot extend that first evaluation — su-lou.10.8 measures the race this leaves open
- Retuning a rung applies to the live session; it never silently needs a reload
