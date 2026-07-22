---
title: "On-device text-quality scores (U2): tri-runtime listener candidates, full-brain + reduced-role"
type: findings
status: harness-ready — on-device score cells pending an Ollama/MLX host
unit: U2
plan: docs/plans/2026-06-25-001-feat-on-device-quiet-companion-validation-plan.md
requirements: [R2, R10, R11]
date: 2026-06-26
---

# On-device text-quality scores (U2)

Picks the **U5 listener model class** by scoring small, on-device-class models
with the existing `promptfoo` judges (restraint, variety, probing-depth) in two
configurations:

- **full-brain** — the small model produces every listener turn
  (`providers/multi-turn.js`).
- **reduced-role** — a text rules gate answers response-hierarchy levels 1–2
  with a no-model acknowledgment and calls the model only for substantive turns
  (`providers/reduced-role.js`), lowering the bar a tiny model must clear.

> **Read this first — what is and isn't measured here.**
> This PR lands the *runnable harness* plus the verified tri-runtime candidate
> set. The on-device **score cells below are intentionally empty**: the build
> sandbox that produced this PR has **no `ollama`/MLX runtime and no GPU**, so
> it cannot execute a 3B model. The numbers are filled by running one command
> (§"Reproduce") on any host with Ollama installed — nothing else changes. The
> harness path itself is **validated end-to-end** against cloud `gpt-4o` (§"Harness
> validation"): same loop, same judges, same output shape — only the listener
> target model differs. We deliberately do **not** fabricate on-device scores.

---

## 1. Tri-runtime candidate set (verified 2026-06-26)

A candidate enters the sweep only if it has a build on **all three** runtimes
the pipeline targets, so the class picked here is runnable on every rung:

- **Ollama / llama.cpp** — the runtime this harness drives (`ollama:chat:*`).
- **WebLLM prebuilt (MLC)** — Rung 1, in-browser (WebGPU). "Prebuilt" matters:
  a model not in `prebuiltAppConfig` would need a custom MLC compile.
- **MLX 4-bit** — Rung 2, Apple-Silicon-native (the iOS precursor).

| Candidate | Params | Ollama tag | WebLLM prebuilt `model_id` (q4f16_1) | MLX 4-bit repo | Tri-runtime |
|---|---|---|---|---|---|
| Llama-3.2-3B-Instruct | 3.2B | `llama3.2:3b` | `Llama-3.2-3B-Instruct-q4f16_1-MLC` | `mlx-community/Llama-3.2-3B-Instruct-4bit` | ✅ |
| Qwen2.5-3B-Instruct | 3.1B | `qwen2.5:3b` | `Qwen2.5-3B-Instruct-q4f16_1-MLC` | `mlx-community/Qwen2.5-3B-Instruct-4bit` | ✅ |
| Phi-3.5-mini-instruct | 3.8B | `phi3.5` | `Phi-3.5-mini-instruct-q4f16_1-MLC` | `mlx-community/Phi-3.5-mini-instruct-4bit` | ✅ |
| Gemma-2-2B-it | 2.6B | `gemma2:2b` | `gemma-2-2b-it-q4f16_1-MLC` | `mlx-community/gemma-2-2b-it-4bit` | ✅ |

Sources: WebLLM `prebuiltAppConfig`
(`mlc-ai/web-llm` `src/config.ts`); Hugging Face `mlx-community/*-4bit`
model cards (each card states "converted to MLX format from <upstream> using
mlx-lm"); Ollama library tags. All four also have a WebLLM **and** an MLX build,
satisfying the U2 gate "confirmed to have a browser and a Core ML/MLX build
before entering the sweep." Llama-3.2-3B and Qwen2.5-3B carry the most mature
tri-runtime tooling; Gemma-2-2B is the smallest (lightest WebGPU VRAM
footprint, relevant to the plan's per-tab VRAM ceiling); Phi-3.5-mini is the
largest of the four.

> 1B fallback: `Llama-3.2-1B-Instruct` exists on all three runtimes too and is
> the plan's VRAM-pressure drop-target. It is out of the primary sweep but is
> the obvious add if every 2–3B candidate misses the VRAM budget in U6.

---

## 2. Score table — full-brain (R2)

One conversation per (candidate × scenario): `maxTurns: 5`, pinned
`openai:gpt-4o` thinker, scored 1–5 by each judge. Report the mean over the four
`scenarios/*.yaml`. Higher is better on all three judges.

| Candidate (full-brain) | restraint | variety | probing-depth | Notes |
|---|---|---|---|---|
| Llama-3.2-3B-Instruct | _pending_ | _pending_ | _pending_ | |
| Qwen2.5-3B-Instruct | _pending_ | _pending_ | _pending_ | |
| Phi-3.5-mini-instruct | _pending_ | _pending_ | _pending_ | |
| Gemma-2-2B-it | _pending_ | _pending_ | _pending_ | |

## 3. Score table — reduced-role (R11)

Same cells, but the gate answers light turns with a no-model ack.
`model_calls` is `listenerModelCalls / listenerTurns` (lower = the model stayed
out of more turns). Expect restraint to rise (gated turns are maximally
restrained by construction) and probing-depth to fall (the model speaks less).

| Candidate (reduced-role) | restraint | variety | probing-depth | model_calls |
|---|---|---|---|---|
| Llama-3.2-3B-Instruct | _pending_ | _pending_ | _pending_ | _pending_ |
| Qwen2.5-3B-Instruct | _pending_ | _pending_ | _pending_ | _pending_ |
| Phi-3.5-mini-instruct | _pending_ | _pending_ | _pending_ | _pending_ |
| Gemma-2-2B-it | _pending_ | _pending_ | _pending_ | _pending_ |

---

## 4. Harness validation (cloud `gpt-4o`, run 2026-06-26)

These are **not** on-device candidate scores — they prove the U2 harness path
end-to-end on a model the build sandbox *can* reach, and calibrate the judges.
The on-device cells will produce this exact shape once a runtime is available.

- **`npm run eval:smoke`** (base provider, `gpt-4o`, `career-decision`, 5 turns,
  all three judges) produced a well-formed THINKER/LISTENER transcript and three
  judge verdicts:

  | judge | score | pass |
  |---|---|---|
  | restraint | 5 | ✓ |
  | variety | 5 | ✓ (0 questions → max by rubric) |
  | probing-depth | 1 | ✗ (gpt-4o stayed at "Hmm." / "A lot to consider there." — engaged nothing specific) |

  The case fails overall **only** because probing-depth is below the rubric
  threshold — a real signal (this run was *too* withholding), not a harness
  defect. This is the precise output `eval:smoke:ondevice` yields per candidate.

  > **Two of these numbers are superseded (su-lou.12, 2026-07-22).** The
  > variety row is the defect rather than a result: the rubric awarded a
  > perfect 5 for asking *zero* questions, so the column flattered exactly the
  > degenerate output the bar rejects. That cell now returns **N/A** and is
  > excluded from the column. The restraint row predates the simulator's
  > landing phase and is not comparable with later runs either — restraint now
  > scores each turn against *where the dictation ended*, which is a boundary
  > this run's transcript did not have. Re-run before quoting either number;
  > probing-depth is unaffected.

- **Full-brain vs reduced-role on `gpt-4o`** (no judges) produced **identical,
  valid transcripts** with `listenerModelCalls = 4/4` for *both*. See §5 for why
  the reduced-role saving doesn't appear with a clean-prose thinker — it is a
  finding, not a null result.

---

## 5. Reduced-role: mechanism, and why call-savings under-show in the text harness

The gate (`providers/reduced-role.js`) keys on the only signals a transcript
exposes: an explicit question cue (`?`), trailing-off discourse markers
(`…`, `—`, `,`), and utterance length (`gateSubstantiveWords`, default 12). It
escalates to the model only on positive evidence a substantive reply is invited;
otherwise it emits a rotating minimal ack (`mm`, `yeah`, …) — hierarchy level 2,
**not** a `[silence]` sentinel the judges never learned to read.

Unit tests (`promptfoo/test/reduced-role.test.js`, keyless) prove the mechanism:
light/trailing turns ack with **zero** model calls and escalation fires on
questions and long turns; a full loop driven by a short-turn thinker records
`listenerModelCalls = 0`.

**But the pinned `gpt-4o` thinker emits uniformly long, fluent turns** — it
rarely produces the short "…yeah" / trailing pauses that trigger an ack. So in
the text harness the gate escalates nearly every turn and reduced-role ≈
full-brain on call count (the 4/4 result in §4). Two consequences for the pick:

- The harness `model_calls` for reduced-role is a **lower bound** on the live
  saving: real thinking-out-loud is far more disfluent and pause-heavy than the
  clean simulator, so the live gate (U5) will ack many more turns.
- Reduced-role's measurable U2 *quality* effect (restraint ↑) also only shows on
  acked turns, so it too is muted by the verbose simulator. The honest read:
  **reduced-role's benefit is best measured live (U5), or by a simulator tuned
  to emit disfluent/short turns** — left as a deliberate U2→U5 handoff, since the
  plan fixes `simulators/thinker.md` and `scenarios/*.yaml` for U2.

---

## 6. U2 → U5 handoff gaps (read before trusting these numbers for the live build)

1. **Clean-text upper bound (quality).** The thinker emits clean prose; live STT
   output is disfluent (fillers, restarts, mis-transcriptions). U2 judge scores
   are an **upper bound** on what the same model scores on live STT text.
2. **Simulator-verbosity lower bound (call savings).** Per §5, the verbose clean
   thinker makes the reduced-role `model_calls` a **lower bound** on live savings.
3. **Text gate vs live gate.** U2's gate routes on text only; the live gate (U5)
   adds silence-duration buckets and the smart-turn EOU veto on the audio
   stream. U5 measures live-gate routing accuracy against this text gate.

---

## 7. How to pick the U5 model class (decision rule)

Once §2–§3 are populated, pick the **smallest** candidate that:

1. clears the restraint bar in **reduced-role** (this is the configuration U5
   ships — the model must be restrained on the substantive turns it does field), and
2. keeps **probing-depth** acceptable in **full-brain** (head-room for turns the
   gate escalates), and
3. fits the U6 per-tab VRAM budget at q4f16 (smaller wins ties — it loads faster
   and leaves KV head-room).

Tie-breakers: tri-runtime tooling maturity (Llama-3.2-3B / Qwen2.5-3B lead) and
WebGPU footprint (Gemma-2-2B lightest). **Prior, to be confirmed by the scores,
not asserted as the result:** Phi-3.5-mini is the largest and tends to
instruction-follow verbosely (a restraint risk for a *quiet* companion);
Gemma-2-2B is the VRAM-friendliest if it holds restraint; Llama-3.2-3B and
Qwen2.5-3B are the balanced front-runners. Confirm against the table before
committing the U5 pick.

---

## 8. Reproduce

Prereqs: Node 18+, `promptfoo/` deps (`npm ci`), an OpenAI key for the pinned
thinker + judges (via `scripts/eval-keys.sh` / `.env.op`, or `.env.local`), and
**Ollama running** with the candidate models pulled. The judges/simulator are
cloud; only the *listener* is local — there is no global base URL override.

```sh
cd promptfoo
npm ci

# Pull the tri-runtime candidates into Ollama (the harness runtime):
ollama pull llama3.2:3b qwen2.5:3b phi3.5 gemma2:2b

# Schema check (keyless) and gate/sync unit tests (keyless):
npm run validate
npm test

# One on-device model, one scenario, three judges (transcript + scores):
npm run eval:smoke:ondevice

# Full on-device sweep — every ollama-* cell (full-brain + reduced-role),
# chatgpt prompt only (the two prompts are byte-identical; U5 uses chatgpt.md):
../scripts/eval-keys.sh npx promptfoo eval --filter-providers ollama --filter-prompts chatgpt
npm run view   # browse per-judge scores; transcribe means into §2/§3
```

For an OpenAI-compatible local server instead of Ollama (`mlx_lm.server`,
`llama-server`), set the listener target on the `openai:` family and pass the
base URL via a per-listener `targetConfig` (never a global `OPENAI_BASE_URL`,
which would also redirect the pinned thinker and the judges):

```yaml
targetModel: openai:chat:<served-model-id>
targetConfig: { apiBaseUrl: "http://localhost:8080/v1", apiKey: "local" }
```
