# promptfoo — shutupandlisten evals

How to run and iterate on the prompts in this repo.

## Prerequisites

- Node 18+ with `npx`
- `OPENAI_API_KEY` exported in env
- `ANTHROPIC_API_KEY` exported in env

## Run all evals

```sh
cd promptfoo
npx promptfoo eval
```

## View results

```sh
npx promptfoo view
```

This opens a local UI for browsing per-scenario, per-provider, and
per-judge scores, with side-by-side run comparison.

## What's being tested

Each scenario in `scenarios/` defines a `topic`, an `emotional_arc`,
and a `starting_turn`. We run the system-under-test (loaded with one
of the prompts from `../prompts/`) against the starting turn, and
score its response with three LLM-rubric judges:

- `judges/probing-depth.md` — does the response engage with the
  *specific* thing the speaker said, or pivot to a generic prompt?
- `judges/variety.md` — across the conversation, do the listener's
  questions vary in stem and target?
- `judges/restraint.md` — does the listener stay out of the way, or
  take over with summary / coaching / paraphrase?

A user-simulator system prompt lives in `simulators/thinker.md` — it
defines a person thinking out loud (not asking for advice). The
intended pattern is a 4–6 turn conversation where the simulator
generates each user turn from the scenario's arc, and the system under
test produces a listener response per turn.

**v0 caveat:** `promptfooconfig.yaml` currently runs each scenario as
a single turn — the starting turn from the scenario file, evaluated
once. Multi-turn simulator integration (where the thinker simulator
produces follow-up turns reactive to the listener) is the planned
next iteration. See the `TODO` in `promptfooconfig.yaml`.

## Iteration loop

1. Edit `../prompts/claude.md` (or `chatgpt.md`)
2. `npx promptfoo eval`
3. `npx promptfoo view` — compare against the previous run
4. Repeat
