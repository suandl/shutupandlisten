---
title: "Testing strategy — the three tiers and the works-gate"
description: The rig's standing answer to "what proves a deliverable works?" — the principle, the three testing tiers and what each is blind to, the works-gate's assertions and home, and the named deferred tier.
type: strategy
status: standing — tiers 1 and 2 run today; the works-check ships and runs standalone, its pre-land enforcement is decided but not yet built (U8/U10)
unit: U9 (epic su-ljrb)
plan: docs/plans/2026-07-18-001-feat-rig-works-gate-strategy-plan.md
requirements: [R11, R12]
bead: su-ljrb.7
date: 2026-08-09
---

# Testing strategy — the three tiers and the works-gate

## Scope

**Mandate.** What proves a deliverable works before it reaches the operator:
the tiers of automated check this rig runs, what question each one answers,
which one owns the real-backend verdict, and where that verdict is enforced.

**Boundaries.** This doc does not say what "good output" is — the acceptance
rubric lives in `docs/usefulness-bar.md` and the judges in `CONCEPTS.md`. It
does not specify the works-check's internals; those are the code
(`web/scripts/works-check.mjs`, `web/scripts/works-verdict.mjs`) and the plan
it was built from. It governs the browser-deliverable gate; the iOS app's
capture checks are their own subject.

## The principle

**Every operator-facing deliverable has an automated works-check for the
stages a gate host can run.** The operator is not the integration test.

The evidence this exists for: at `1d36c86` the `web/` `node --test` suite was
green — 25/25 — while a real browser degraded three of five pipeline stages to
their labelled fallback (denoise→passthrough, smart-turn→heuristic,
TTS→stub, `su-lou.8`). Nothing but the operator caught it, because nothing in
CI ever loaded a real backend. A stage that degrades quietly is the failure
class this strategy targets.

## The three tiers

Each tier answers a different question. None substitutes for another, and the
gap between tiers 1 and 3 is where `su-lou.8` lived.

| Tier | Question it answers | Command | Where it runs |
|---|---|---|---|
| **1 — unit logic** | Does the code's logic hold at its seams? | `node --test` (`web/`, `server/`, `promptfoo/`); `swift test` (`ios/ShutUpAndListenKit`) | anywhere, no models |
| **2 — prompt quality** | Is the listener's *output* good — restraint, variety, probing-depth, no-summarize? | `npm run eval` in `promptfoo/` | locally, and on PRs via `.github/workflows/promptfoo.yml` |
| **3 — real-backend works-gate** | Do the shipped stages load their **real** backend and actually produce output? | `npm run works-check` in `web/` | headless on the rig host |

What each tier is blind to, stated plainly:

- **Tier 1** drives stub and fallback *logic* on `FakeWorker` seams
  (`web/src/stt.test.ts`, `web/src/tts.test.ts`). It can be fully green while
  every real backend is broken.
- **Tier 2** scores text the listener produced. It says nothing about whether
  the browser can load the model that produces it.
- **Tier 3** is liveness, not accuracy. It proves a stage runs and emits
  something; whether what it emits is *good* is tier 2's question, and whether
  it is worth reaching for is the usefulness bar's.

## What the works-gate asserts

Each stage's expected real backend is **declared explicitly**, so a stage whose
intended floor is a fallback is never counted as a regression. The declarations
live in `web/scripts/works-verdict.mjs`.

| Stage | Real backend | Labelled degrade | Smoke-run |
|---|---|---|---|
| STT | `moonshine`, `whisper` | `stub`, `sim` | fixture WAV → non-empty transcript |
| TTS | `wasm` | `stub` | fixture text → non-empty, non-silent audio |
| smart-turn | `model` | `heuristic` | a usable completion probability in [0,1] |
| listener | `webgpu`, `wasm` — both are honest live backends; the gate host always lands on `wasm` | `stub` | weight assets served per device-ladder rung (always); load + generate a reply (opt-in `--with-listener`) |
| denoise | — | — | **not guarded** — an AudioWorklet over a live mic; the gate host has neither |

Two rules hold the gate honest:

- **The load-assert alone is not sufficient.** A mis-fixed stage can report the
  right backend and still emit a placeholder — proven in the spike, where a
  typed-but-wrong config made the TTS pipeline load and then dispatch to an
  absent vocoder. Every guarded stage must also smoke-run and produce real
  output.
- **"Not provisioned" is never "broken."** Missing assets or a missing browser
  are reported as infra with the remedy, never as a regression.

**Verdict taxonomy:** `0` pass · `100` real regression, summary naming the
stage · anything else infra-flake. A regression blocks the land; a flake does
not block but is surfaced prominently. This mirrors the rig's existing
precedent in `.github/workflows/promptfoo.yml`.

## The works-gate's home

**Refinery, headless-on-host.** The gate runs on the rig host, reusing the
already-provisioned assets under `web/public/models/`, and consumes no
GitHub-Actions minutes.

The mechanism was decided by the operator on 2026-07-18: a **minimal, generic,
config-driven pre-land gate** in the gc-toolkit refinery ("E3"). A rig declares
a pre-land command; the refinery runs it against the PR head between
`merge-skill.sh`'s CLEAN gate and the squash-merge, mapped by the exit codes
above — pass proceeds, regression holds, flake passes through. It is generic
across rigs because it touches shared infra every importer rig runs; the
works-check is its first consumer.

**Status: decided, not yet built.** `merge-skill.sh` carries no pre-land gate
today and no rig config points at the works-check. Until the gc-toolkit hook
(U8) and the rig wiring (U10) land, the works-check is **standalone-only** —
run `npm run works-check` by hand before a web deliverable lands. The check
shipping before its enforcement is deliberate: the check is host-agnostic and
independently useful, and the enforcement touches shared infra.

## The deferred tier

Named, so a coverage boundary is never mistaken for coverage.

**Operator-side, or any GPU/audio-capable host:**

- **denoise** — an AudioWorklet over a live mic MediaStream; the gate host has
  no mic and no audio graph.
- **the WebGPU listener rung** — this browser exposes no WebGPU adapter with
  `shader-f16`, so the gate proves the deploy *serves* the `webgpu/q4f16`
  weights, never that they load. The rung an operator actually runs is checked
  by an operator.
- **full-loop end-to-end liveness** across all five stages — out of headless
  reach.

**GitHub Actions** remains a further tier for cheap or occasional checks,
minutes permitting. Tier 2 already lives there; the heavy paths (the ~2.7 GB
LLM) do not, on Action-minute budget.

**Outside this strategy's identity:** output quality belongs to tier 2 and the
usefulness bar; the on-device/native endgame beyond the browser floor is the
`su-lou` epic's scope.
