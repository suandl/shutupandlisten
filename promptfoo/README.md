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
and a `starting_turn`. Each scenario runs as a 4–6 turn conversation:
`simulators/thinker.md` (a user-simulator system prompt — a person
thinking out loud, not asking for advice) drives the user side,
parameterised with the scenario's `topic` and `emotional_arc` and
reactive to the listener's reply each turn. The system under test
(one of the prompts from `../prompts/`) produces the listener turn.

The multi-turn loop is orchestrated by `providers/multi-turn.js`,
which wraps a target listener model (e.g. `openai:gpt-4o` or
`anthropic:claude-haiku-4-5`) and a pinned simulator model
(`openai:gpt-4o` by default — kept constant across cells so the
thinker side is not a confound when comparing listener prompts and
models). It returns the full transcript as the cell's output.

The transcript is scored by three LLM-rubric judges in `judges/`:

- `judges/probing-depth.txt` — across the listener's turns, do they
  engage with the *specific* things the thinker said, or pivot to
  generic prompts?
- `judges/restraint.txt` — does the listener stay out of the way, or
  take over with summary / coaching / paraphrase?
- `judges/variety.txt` — across the conversation, do the listener's
  questions vary in stem and target? (Returns 5 if the listener asks
  ≤1 questions — restraint penalises over-questioning separately.)

## Iteration loop

1. Edit `../prompts/claude.md` (or `chatgpt.md`)
2. `npm run eval`
3. `npm run view` — compare against the previous run
4. Repeat
