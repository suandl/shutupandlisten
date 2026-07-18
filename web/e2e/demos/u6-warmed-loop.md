# Demo: U6 warmed loop — VAD to spoken TTS, instrumented

**Start:** `/?demo=u6-warmed-loop&llm=off&tts=off`

Proof that PR #17 (commit fd97b4c) closes the end-to-end warmed loop: a turn ends,
its words are transcribed, the response-hierarchy gate decides how much to say, the
on-device listener replies, the on-device voice speaks it, and every stage's latency
is measured — all driven mic-lessly against deterministic sim mode. `llm=off&tts=off`
forces the labelled-stub substrate so the run is fast and identical every time (the
real models degrade to the same stub/tone today — su-lou.8 — which is exactly why sim
mode, not a live mic, is the substrate).

## Steps

1. **The harness boots straight into the deterministic U6 sim scenario**
   `waitFor #state-badge`
   The page loads in Simulation mode with the `u6-warmed-loop` scenario armed by the
   `?demo=` entrypoint — no clicks, no microphone, no model download.
   _Prove:_ Simulation mode is selected and the stage panel is live — `visible #mode button[data-mode="sim"][aria-pressed="true"]`
   _Fail if:_ it opened into a microphone prompt instead — `visible #mic-controls`

2. **A substantive turn is transcribed, and the gate escalates to a reflection**
   `waitFor #transcript .tx-response.reflection`
   `wait 400`
   Turn 1's thinking-out-loud lands in the transcript; the gate reads a finished,
   substantive thought and escalates to a short momentum-preserving reflection — the
   L3 rung that calls the on-device listener.
   _Prove:_ turn 1's words carry a REFLECTION reply — `count #transcript .tx-response.reflection >= 1`
   _Fail if:_ the transcript still shows only its empty-state hint — `visible #transcript .tx-empty`

3. **A short aside earns only a minimal acknowledgment (escalate slowly)**
   `waitFor #transcript .tx-response.acknowledge`
   `wait 400`
   Turn 2 is a brief finished aside, so the gate stays low on the hierarchy: a
   rules-only backchannel ("mm-hm"), no model call — the restraint that keeps most
   pauses from becoming interruptions.
   _Prove:_ an ACKNOWLEDGE reply renders without escalating — `count #transcript .tx-response.acknowledge >= 1`

4. **A direct question earns one brief follow-up question**
   `waitFor #transcript .tx-response.question`
   `wait 400`
   Turn 3 asks the companion something directly, so the gate answers in kind — one
   brief question, again through the on-device listener.
   _Prove:_ turn 3 carries a QUESTION reply — `count #transcript .tx-response.question >= 1`
   _Fail if:_ fewer than three turns were laid out — `count #transcript .tx-turn < 3`

5. **Every stage was spoken, and the loop's per-stage latency is measured**
   `waitForText #loop-metrics .lm-summary ~ 3 spoken`
   `scroll #loop-metrics`
   `wait 400`
   The instrumentation panel confirms the loop fired end-to-end on all three turns —
   turn-end to spoken reply — and breaks the cost down by leg (STT, gate, listener,
   TTS): the "warmed loop" measurement U6 exists to expose.
   _Prove:_ the panel reports three spoken turns — `text #loop-metrics .lm-summary ~ /3 spoken/`
   _Fail if:_ no per-stage legs were recorded — `hidden #loop-metrics .lm-legs`
