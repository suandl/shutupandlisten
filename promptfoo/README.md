# promptfoo — shutupandlisten evals

How to run and iterate on the prompts in this repo.

## Prerequisites

- Node 18+
- API keys, via either of:
  - **1Password (default, nothing on disk):** the [1Password CLI](https://developer.1password.com/docs/cli/)
    (`op`) plus a service-account token (see below). When no
    `.env.local` exists, the npm scripts run promptfoo through
    `scripts/eval-keys.sh`, which uses `op run` to resolve the
    `op://` references in `.env.op` and inject `OPENAI_API_KEY` /
    `ANTHROPIC_API_KEY` into the promptfoo process **at use-time,
    in-memory** — no plaintext key ever lands on disk.
  - **Personal keys (local dev):** `OPENAI_API_KEY` and
    `ANTHROPIC_API_KEY` in a `.env.local` file at the repo root
    (gitignored). If `.env.local` exists, the scripts pass it to
    promptfoo via `--env-file ../.env.local` exactly as before.

### How key injection works (1Password path)

`promptfoo/.env.op` is committed — it contains only `op://` *references*
(vault/item/field paths), not secrets, so it is safe in git.
`scripts/eval-keys.sh <command>` authenticates `op` and runs
`op run --env-file=promptfoo/.env.op -- <command>`, which resolves the
references and exports the real keys into the child process environment
only. Auth comes from:

- `OP_SERVICE_ACCOUNT_TOKEN`, if already set in the environment, or
- the token file `~/.config/gascity/op-sa-token` (mode 0600; override
  the path with `OP_SA_TOKEN_FILE`).

**CI variant:** store the service-account token as a repo secret and
expose it as `OP_SERVICE_ACCOUNT_TOKEN` in the workflow env — the
wrapper honors a pre-set token and never needs the token file:

```yaml
env:
  OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
```

You can also invoke the wrapper directly, from any directory:

```sh
scripts/eval-keys.sh npx promptfoo eval   # run from promptfoo/ as ../scripts/...
```

(promptfoo itself still resolves `promptfooconfig.yaml` from the
current directory, so run eval commands from `promptfoo/`.)

## Setup (one-time)

```sh
cd promptfoo
npm install
```

## Run

```sh
npm run eval                # full matrix (all scenarios × providers × prompts)
npm run eval:smoke          # one scenario × openai × claude-prompt (cheap)
npm run eval:smoke:ondevice # one on-device (Ollama) model × one scenario (needs Ollama)
npm run validate            # schema-check the config without calling APIs
npm test                    # gate + banned-phrase-sync unit tests (keyless, no model)
```

The on-device-class candidates (full-brain and reduced-role) and the
runtime they each need are documented in
[`docs/findings/on-device-text-quality.md`](../docs/findings/on-device-text-quality.md);
filter the whole on-device family with `--filter-providers ollama`.

## CI (evals on PRs)

`.github/workflows/promptfoo.yml` runs the evals on pull requests and
posts a per-provider × scenario × judge score summary as a PR comment,
so probing-depth / restraint / variety regressions surface in review.
The full machine-readable report (`results.json` + `results.html`) is
uploaded as a workflow artifact.

- **Trigger:** PRs that touch `prompts/**` or `promptfoo/**`. Because
  each cell makes paid API calls, the eval job is **gated** — it runs
  only when a maintainer adds the `run-evals` label to the PR (or via a
  manual **Run workflow** dispatch). Push a new commit after labeling
  and it re-runs.
- **Providers:** the two cloud providers only
  (`openai-gpt-4o`, `anthropic-claude-haiku-4-5`); the on-device
  `ollama:*` providers are skipped because the runner has no Ollama.
- **Secret:** set one repository secret, `OP_SERVICE_ACCOUNT_TOKEN` — a
  1Password [service-account](https://developer.1password.com/docs/service-accounts/)
  token with read access to the `shutupandlisten` vault (the same
  `op://` references in `.env.op`). Keys are injected at use-time by
  `scripts/eval-keys.sh`; no raw `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
  is ever stored in GitHub. Fork PRs get no secrets, so evals only run
  on same-repo branches.

## View results

```sh
npm run view
```

This opens a local UI for browsing per-scenario, per-provider, and
per-judge scores, with side-by-side run comparison.

## What's being tested

Each scenario in `scenarios/` defines a `topic`, an `idea_arc`,
and a `starting_turn`. Each scenario runs as a 4–6 turn conversation:
`simulators/thinker.md` (a user-simulator system prompt — a person
dictating an idea out loud, not asking for advice) drives the user side,
parameterised with the scenario's `topic` and `idea_arc` and
reactive to the listener's reply each turn. The system under test
(one of the prompts from `../prompts/`) produces the listener turn.

The multi-turn loop is orchestrated by `providers/multi-turn.js`,
which wraps a target listener model (e.g. `openai:gpt-4o` or
`anthropic:claude-haiku-4-5`) and a pinned simulator model
(`openai:gpt-4o` by default — kept constant across cells so the
thinker side is not a confound when comparing listener prompts and
models). It returns the full transcript as the cell's output.

The transcript is scored by three LLM-rubric judges in `judges/`:

- `judges/probing-depth.txt` — once the idea is laid out, does the
  listener's thread-pull engage a *specific* thread of the idea, or
  pivot to a generic / emotional prompt?
- `judges/restraint.txt` — does the listener stay silent while the
  idea is dictated, or take over with mid-stream acks / echoes /
  summary / coaching?
- `judges/variety.txt` — across the conversation, do the listener's
  questions vary in stem and target? (Returns 5 if the listener asks
  ≤1 questions — restraint penalises over-questioning separately.)

## Iteration loop

1. Edit `../prompts/claude.md` (or `chatgpt.md`)
2. `npm run eval`
3. `npm run view` — compare against the previous run
4. Repeat
