# promptfoo — shutupandlisten evals

How to run and iterate on the prompts in this repo.

## Prerequisites

- Node 22 — the version in the repo-root [`.nvmrc`](../.nvmrc), so `nvm use`
  (or `fnm use`) from anywhere in the repo picks it up. **Not Node 24 by
  default:** Node 24 ships npm 12, which will not run a dependency's install
  script unless it is approved. `better-sqlite3` downloads its native binding
  *from* that script, so `npm ci` leaves the binding missing and every command
  here — `npm run validate` included — aborts with `Could not locate the
  bindings file`, which reads like a `promptfooconfig.yaml` problem and is not
  one. Nothing is actually incompatible: if you need Node 24, install with
  `npm ci --allow-scripts better-sqlite3` (or approve it once with
  `npm install-scripts approve better-sqlite3`) and promptfoo runs normally.
  Node 22 is pinned so that no one has to know this.
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

### Adding the Gemini key

The `google-gemini-2.5-flash` provider is wired into
`promptfooconfig.yaml` but **has no credential yet**, so its cells error
until one is provisioned. The enable is one line:

1. Create a `google` item with an `api-key` field in the
   `shutupandlisten` vault (same vault and service account as `openai`
   and `anthropic`).
2. Uncomment `GOOGLE_API_KEY=op://shutupandlisten/google/api-key` in
   `promptfoo/.env.op`.
3. Add `google-gemini-2.5-flash` to `EVAL_PROVIDERS` in
   `.github/workflows/promptfoo.yml` so CI covers it too.

That line ships commented out on purpose. `op run` resolves every
reference in `.env.op` *before* exec'ing the child and aborts the whole
invocation if any one of them misses — so a live reference to an item
that doesn't exist takes the OpenAI and Anthropic cells down with it,
not just Gemini. Keep it commented until the vault item exists.

promptfoo reads the key as `GOOGLE_API_KEY` →
`GOOGLE_GENERATIVE_AI_API_KEY` → `GEMINI_API_KEY`; any of the three
works if you are running with a personal key in `.env.local` instead.

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
npm test                    # gate, landing-phase, variety-gate, summary unit tests (keyless)
npm run test:judges         # OPT-IN: scores two fixture transcripts with a real grader (paid)
```

`npm test` is keyless and pins structure. `npm run test:judges` is the
acceptance test for the judges themselves — it scores a deliberately
restrained transcript and a deliberately intrusive one (identical idea,
identical wording, no banned phrases; they differ only in *when* the
listener speaks) and requires the restraint judge to separate them. It
makes paid grader calls, so `npm test` skips it unless
`RUN_JUDGE_ACCEPTANCE=1` is set.

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
- **Providers:** the two *credentialed* cloud providers only
  (`openai-gpt-4o`, `anthropic-claude-haiku-4-5`). The on-device
  `ollama:*` providers are skipped because the runner has no Ollama, and
  `google-gemini-2.5-flash` is skipped because no Gemini key is
  provisioned yet — add it to `EVAL_PROVIDERS` once the vault item
  exists (see "Adding the Gemini key" above).
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

Three listener prompts make up the prompt axis, and every one of them
runs against every provider — the file name is the variant's name, not
a binding to a vendor:

- `claude.md` — the **v0 baseline**, deliberately frozen. Silence during
  dictation, then exactly one anchored thread-pull. Best on
  probing-depth and no-summarize in the 2026-08-05 re-score.
- `chatgpt.md` — the **hardened** variant the web app ships. Adds voice
  hygiene, a response hierarchy, and a brevity cap; buys question
  variety and short replies at the cost of probing and B3.
- `gemini.md` — **v0 plus spoken-output hygiene** (su-5ky). Forked from
  `claude.md` and keeps its response discipline intact; adds only the
  format rules a spoken surface needs (no markdown, no stage
  directions, no preamble) plus a one-question-mark cap. It does *not*
  adopt the response hierarchy, which is the part of the hardening that
  cost probing and B3.

The multi-turn loop is orchestrated by `providers/multi-turn.js`,
which wraps a target listener model (e.g. `openai:gpt-4o` or
`anthropic:claude-haiku-4-5`) and a pinned simulator model
(`openai:gpt-4o` by default — kept constant across cells so the
thinker side is not a confound when comparing listener prompts and
models). It returns the full transcript as the cell's output.

**The dictation ends on purpose.** Each simulator call carries a phase
directive and the last one is a *landing* — finish the idea, come to a
natural stopping point — after which the transcript carries a marker
line. Restraint scores a transition (silence while the idea is dictated,
then one thread-pull once it lands), so a thinker who never finishes
makes the top of that rubric unreachable: every listener turn is
mid-dictation by construction. That is what pinned the column at 0-of-16
before su-lou.12, whatever the prompt or model did. The marker is added
when the transcript is formatted, so the judges see it and the listener
never does — it still has to hear the landing in the thinker's own words.

The transcript is scored by four judges in `judges/`:

- `judges/probing-depth.txt` — once the idea is laid out, does the
  listener's thread-pull engage a *specific* thread of the idea, or
  pivot to a generic / emotional prompt?
- `judges/restraint.txt` — does the listener stay silent while the
  idea is dictated, or take over with mid-stream acks / echoes /
  summary / coaching? Anchored on the landing marker above: turns
  before it are interjections, the one after it is the listener's
  legitimate window and is never penalised.
- `judges/no-summarize.txt` — B3, the dealbreaker: does any listener
  turn reflect the thinker's own thought back at them, in *any*
  wording? Scored semantically on purpose. `restraint.txt` caps the
  score on a list of banned phrases, and su-lou.11 caught a live
  on-device run walking straight around it — "it's interesting that
  you're thinking about the consequences and power of using Voice…"
  trips no phrase and is the identical violation. A phrase list
  cannot hold B3.
- `judges/variety.txt` — across the conversation, do the listener's
  questions vary in stem and target? Run behind `asserts/variety.js`,
  which counts the listener's questions first and returns **N/A** below
  two, excluding the cell from the column (the summary reports the
  count). Variety is undefined on a single sample, and the rubric's old
  "≤1 questions → 5" rule meant zero-question transcripts — the most
  degenerate output in the matrix — scored top marks on it.

## Iteration loop

1. Edit `../prompts/claude.md` (or `chatgpt.md`, or `gemini.md`)
2. `npm run eval`
3. `npm run view` — compare against the previous run
4. Repeat
