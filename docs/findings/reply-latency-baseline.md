---
title: "Reply-latency baseline: per-stage split (listener generation vs TTS first-audio) on the warmed loop"
type: findings
status: measured — browser/WASM rung, 2026-08-02; no lever selected (that is su-lou.14)
unit: U6 (loop instrumentation) · U5 (listener)
plan: docs/plans/2026-06-25-001-feat-on-device-quiet-companion-validation-plan.md
requirements: [R3, R4]
bead: su-lou.14.1
date: 2026-08-02
---

# Reply-latency baseline (browser rung, 2026-08-02)

su-lou.14 asks for the per-stage latency baseline *before* any lever is chosen:
"do not choose a lever before the numbers name the dominant stage." This is that
capture. **It picks no lever.**

The question it must answer is the split between:

- **(a) listener-LLM generation** — gate decides to speak → reply text
- **(b) TTS time-to-first-audio** — reply text → first audible sample

**Answer: (a) listener-LLM generation dominates, by ~2.8–4.3×.**

But the headline number is neither: a **one-time listener model load of 156.6 s**
that is 3.6× the generation cost and 10× TTS first-audio, and which made the
end-to-end loop run unmeasurable (1 of 3 turns spoken). Details below.

---

## 1. Substrate — read this before the numbers

Every backend below was **live and real**. No stage silently fell back to a stub;
this rig has been bitten exactly there twice (su-lou.8, su-lou.9), so the check is
explicit:

```
listener: load=wasm/q4 (156606ms, single-threaded — page not cross-origin isolated)
          smoke=wasm "It can be frustrating and exhausting to keep trying to solve…"
tts:      load=wasm (9558ms) smoke=wasm 68352 samples @16000Hz rms=0.1087
stt:      load=moonshine (8113ms) smoke=moonshine "The voice petaling is working."
eou:      load=model (1446ms) smoke=model P(complete)=0.7434
[listener] loaded wasm/q4 after skipping: webgpu/q4f16: skipped — no WebGPU adapter with 'shader-f16'
WORKS-CHECK PASS: stt + tts + smart-turn + listener — real backends, non-empty smoke output
```

Two environment facts set the whole scale, and both are properties of the *rung*,
not of the models:

| Fact | Value | Consequence |
|---|---|---|
| `crossOriginIsolated` | **false** | vite sends no COOP/COEP → no `SharedArrayBuffer` → ONNX Runtime WASM runs **single-threaded** |
| WebGPU adapter | **absent** (`no adapter with 'shader-f16'`) | the `webgpu/q4f16` rung is skipped; the listener lands on `wasm/q4` |

Host: 8 cores, 30 GB RAM, headless Chromium. Listener weights served for the taken
rung: **1,692,672,000 B** (1.69 GB, `wasm/q4`).

---

## 2. The (a)/(b) split — the number that answers the bead

From `works-check --with-listener`, which is the **only** instrument here that times
load and generation apart. Uncontended, one request at a time.

| Stage | Model load (one-time) | Work per reply |
|---|---:|---:|
| STT (moonshine) | 8,113 ms | **638 ms** (2.40 s fixture) |
| Smart-turn EOU | 1,446 ms | **244 ms** cold · **176 ms** warm |
| **(a) Listener LLM** (`wasm/q4`) | **156,606 ms** | **43,347 ms** — 16 tokens |
| **(b) TTS** (`wasm`) | 9,558 ms | **15,231 ms** — 68,352 samples @16 kHz (4.272 s of audio) |

Normalised, so the two legs can be compared at any reply length:

- **(a) listener generation: ~2,709 ms per token** (43,347 / 16). This matches the
  independent in-repo prior of "~2.5 s per token on the single-threaded WASM rung"
  recorded in `web/src/probe.ts`.
- **(b) TTS: ~3.57× slower than realtime** (15,231 ms to synthesize 4.272 s of audio).

### The dominant stage

| | (a) listener generation | (b) TTS first-audio | ratio |
|---|---:|---:|---:|
| `works-check` smoke (16 tokens / 1 sentence) | 43,347 ms | 15,231 ms | **2.85×** |
| In-loop, turn 3 (independent measurement) | 51,930 ms\* | 12,139 ms | **4.28×** (\*load-contaminated) |

> **(a) LISTENER-LLM GENERATION IS THE DOMINANT STAGE.** It is ~2.8–4.3× TTS
> time-to-first-audio, and it scales at ~2.7 s per generated token, so the gap
> *widens* with reply length rather than narrowing.

Per su-lou.14's own instruction, this document stops here and **selects no lever**.

### One measurement caveat on what (a) actually measures

The bead phrases (a) as "gate decides speak → **last token**". The harness's `reply`
mark is not last-token: `main.ts:442` marks it on the **first speakable sentence**
(first-write-wins), because the U6 wording for the stage is "first reply token" and
the engine does stream (`TextStreamer` is exported by `public/llm-engine.js`). So
`gate→reply` is *time-to-first-sentence*, which is the quantity that actually gates
audible latency — it is what TTS consumes. It is a **lower bound** on full
generation. This does not change which stage dominates; it makes the reported (a)
conservative.

---

## 3. Per-turn tables — every turn, as required

### 3a. Real provisioned models — `npm run -s measure:loop -- --json`

**This run TIMED OUT at 1 of 3 turns spoken, with a 35-minute horizon.** The table
is partial and the mean is *not* a pipeline number. Reported in full anyway, because
the failure is the finding.

| turn | rung | turn-end→transcript (STT) | transcript→gate | **gate→reply (a)** | **reply→speech-start (b)** | total |
|---|---|---:|---:|---:|---:|---:|
| 1 | REFLECTION (model call) | 71.9 ms | 0.3 ms | **64,706 ms** | — *(abandoned)* | — |
| 2 | ACKNOWLEDGE (rules-only, no model call) | 11.9 ms | 0.1 ms | **0 ms** | — *(abandoned)* | — |
| 3 | QUESTION (model call) | 51.6 ms | 0.1 ms | **51,930 ms** | **12,139 ms** | **64,120 ms** |

Reported means, for completeness — **do not read these as pipeline numbers**
(§3c): `turn-end→transcript` 45 ms · `transcript→gate` 0 ms · `gate→reply`
38,879 ms · `reply→speech-start` 12,139 ms · total 64,120 ms.

Knobs: `floor=200ms · extension=4000ms · threshold=0.5 · smart-turn=on`.
Substrate: `simulation: U6 warmed loop (demo)`, `listener=wasm/q4 · tts=wasm`.

### 3b. Stub substrate — structure sanity only

`npm run -s measure:loop -- --query 'llm=off&tts=off' --json`. 3/3 turns, everything
under 100 ms. This confirms the *harness* and the loop wiring are sound and that the
numbers in §3a are the models, not the instrument.

| turn | STT | gate | gate→reply | reply→speech-start | total |
|---|---:|---:|---:|---:|---:|
| 1 | 2.5 ms | 0.3 ms | 21.4 ms | 15.4 ms | 39.6 ms |
| 2 | 29.3 ms | 0.0 ms | 0.1 ms | 3.0 ms | 32.4 ms |
| 3 | 72.4 ms | 0.1 ms | 5.5 ms | 10.3 ms | 88.3 ms |
| **mean** | 35 ms | 0 ms | 9 ms | 10 ms | **53 ms** |

Substrate: `listener=stub · speaker=stub`.

### 3c. The overlap caveat — why the real mean is meaningless

The `?demo=` scenario spaces its turns for the **stub** response length. Measured
turn-end marks in the real run: **3,973.6 / 9,973.5 / 16,773.6 ms** — gaps of
**6.00 s** and **6.80 s**. The listener needed **~65 s**. So all three turns were in
flight simultaneously and the run degenerated:

1. **Turn 2's reply was abandoned.** Its ACKNOWLEDGE text was ready at t=9,985.5 ms
   (a rules-only rung — `gate→reply` = 0 ms, no model call), but it then waited on
   the *TTS* load. Turn 3's `turn-start` at t=16,773.6 ms called `stopSpeech()`
   (`main.ts:737`), which bumps `speechEpoch` and discards every queued sentence.
2. **Turn 1's reply was abandoned 3.1 ms after it landed.** Turn 1's text arrived at
   t=68,751.8 ms; turn 3's arrived at t=68,754.9 ms and started its own speech
   session, which calls `stopSpeech()` first (`main.ts:379`). Turn 1 never reached
   synthesis, so it has no `speech-start` and no total.
3. **Only turn 3 spoke**, at t=80,894 ms.

That 3.1 ms gap between turn 1's and turn 3's replies is the tell: both were
serialized behind **one lazy model load**, not two independent generations. So
**`gate→reply` in §3a is load + generation, not generation** — which is exactly what
the harness warns about in `loop-latency.mjs`, and why §2 uses `works-check
--with-listener` for the split instead.

**Turn 1 is normally the only always-clean turn. In this run it is not clean
either**, because the listener and voice are created lazily inside the first reply
that needs them, so turn 1 carries the full cold load.

---

## 4. The cold-load tax — bigger than either leg

| | ms |
|---|---:|
| Listener model load (`wasm/q4`, 1.69 GB, single-threaded) | **156,606** |
| (a) listener generation, 16 tokens | 43,347 |
| (b) TTS first-audio | 15,231 |
| TTS model load | 9,558 |
| STT model load | 8,113 |

The load is a **one-time, per-session** cost, and R3 explicitly excludes the
cold-load tax from the felt-timing judgment — so it does not change the (a)/(b)
answer for a *warmed* loop. It is recorded because it is the reason the end-to-end
run in §3a could not complete, and because `web/scripts/works-check.mjs` documents
the same model loading in **~52 s served cross-origin-isolated** versus the 156.6 s
measured here single-threaded.

---

## 5. Exact commands run

Host: 8-core Linux, headless Chromium, `polecat/su-lou.14.1` at base `a3437ce`.

```bash
cd web
npm ci

# Provisioned model trees (gitignored). These four verify/complete the trees;
# in this run they were pre-seeded by hardlink from a checkout at the same
# commit (a3437ce) and then verified complete by these same scripts.
npm run -s provision:stt        # 28 files, 688.1 MB
npm run -s provision:llm        # 14 files, 2686.3 MB
npm run -s provision:tts        # 11 files, 58.1 MB
npm run -s provision:smart-turn #  1 file,     8.3 MB

# (1) Real provisioned models — §3a. TIMED OUT at 1/3 spoken.
npm run -s measure:loop -- --port 5193 --timeout 2100000 --json

# (2) Stub substrate, structure sanity — §3b.
npm run -s measure:loop -- --query 'llm=off&tts=off' --port 5192 --json

# (3) The load-vs-generate split — §2. The only instrument that separates them.
npm run works-check -- --with-listener
```

### A correction to the command the bead specified

su-lou.14.1 specifies the stub run as `measure:loop -- --query llm=off`. That knob
turns off **only the listener**; `tts` is an independent knob (`src/main.ts:77,83`).
With a provisioned tree present, `llm=off` alone therefore runs the **real TTS
model**, which is not a stub substrate. Run literally, it timed out at 600 s with
1/3 turns spoken:

```
$ npm run -s measure:loop -- --query llm=off --port 5191 --json
loop-latency: 1/3 turns spoken…        # then killed at 600s
```

The demo's own canonical entrypoint is `?demo=u6-warmed-loop&llm=off&tts=off`
(`e2e/demos/u6-warmed-loop.md`), and that is what §3b reports.

---

## 6. What this does and does not establish

**Establishes.** On the browser/WASM rung, with every backend live: listener-LLM
generation is the dominant reply-latency stage at ~2.7 s/token, ~2.8–4.3× TTS
time-to-first-audio. A separate one-time 156.6 s listener load dominates the first
reply outright.

**Does not establish.** Anything about the WebGPU or cross-origin-isolated rungs —
neither was reachable in this environment, so the *browser floor* measured here is
not the product ceiling (R4). Nor anything about a real microphone: this is the
mic-less `?demo=` sim substrate throughout.

**Deliberately not done.** No lever is selected, enabled, or recommended. COOP/COEP
threading, WebGPU generation, a smaller listener model, and streaming TTS all remain
open candidates for su-lou.14 to choose between; nothing here was tuned, swapped, or
re-gated.

## 7. Reproduce

Every number above comes from the two commands in §5 — `measure:loop` for the
per-turn table and `works-check --with-listener` for the split. Both write
machine-readable output (`--json`, and `web/.works-check/report.json`
respectively).
