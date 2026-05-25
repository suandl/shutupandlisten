# promptfoo — shutupandlisten evals

How to run and iterate on the prompts in this repo.

## Prerequisites

- Node 18+
- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in a `.env.local` file at
  the repo root (gitignored). The scripts below pass it to promptfoo
  via `--env-file ../.env.local`.

## Setup (one-time)

```sh
cd promptfoo
npm install
```

## Run

```sh
npm run eval         # full matrix (all scenarios × providers × prompts)
npm run eval:smoke   # one scenario × openai × claude-prompt (cheap)
npm run validate     # schema-check the config without calling APIs
```

## View results

```sh
npm run view
```

This opens a local UI for browsing per-scenario, per-provider, and
per-judge scores, with side-by-side run comparison.

## What's being tested

Each scenario in `scenarios/` defines a `topic`, an `emotional_arc`,
and a `starting_turn`. We run the system-under-test (loaded with one
of the prompts from `../prompts/`) against the starting turn, and
score its response with LLM-rubric judges in `judges/`:

- `judges/probing-depth.txt` *(active)* — does the response engage
  with the *specific* thing the speaker said, or pivot to a generic
  prompt?
- `judges/restraint.txt` *(active)* — does the listener stay out of
  the way, or take over with summary / coaching / paraphrase?
- `judges/variety.txt` *(gated, multi-turn only)* — across the
  conversation, do the listener's questions vary in stem and target?
  Disabled at v0 because v0 produces a single listener turn per
  scenario; re-enabled when the multi-turn simulator lands.

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
2. `npm run eval`
3. `npm run view` — compare against the previous run
4. Repeat
