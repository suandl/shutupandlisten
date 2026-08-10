# shutupandlisten

## What this is

This repo holds the `shutupandlisten` system prompt — a set of model
instructions that make a voice-mode AI behave as a quiet thought
companion. The prompt holds the model back during the speaker's
stream-of-thought and, when it does respond, biases toward a short
acknowledgment or one brief probing question rather than a summary,
reframe, or coaching beat.

The prompt is meant to be pasted into:

- **ChatGPT** — as a Custom GPT system prompt (applied to both chat and voice mode for that GPT)
- **Claude** — as a Claude Projects custom instruction

## Repo layout

- `prompts/` — the prompt variants. `claude.md` and `chatgpt.md` are
  byte-identical at v0; they will fork as we tune for each model's
  voice behavior.
- `promptfoo/` — the evaluation harness used to iterate on the prompts.
  Scenarios, a user-simulator, and three LLM-rubric judges (probing
  depth, variety, restraint).
- `spec/` — the runtime-agnostic turn state machine spec and its golden
  vectors: the cross-runtime contract every build reimplements.
- `web/` — the browser build of the full pipeline (VAD → smart-turn →
  STT → listener LLM → TTS) and the live tuning harness.
- `ios/` — the native iOS app: the same spec and response hierarchy,
  with on-device STT/TTS and Claude as the listener. See
  [`ios/README.md`](ios/README.md).
- `server/` — the account-backed proxy for the customer build of the
  iOS app: Sign in with Apple, metered listener/coverage endpoints,
  the Anthropic key held server-side. Contract in
  [`server/API.md`](server/API.md).

## Node version

`promptfoo/`, `web/`, and `server/` all run on the Node version pinned in
[`.nvmrc`](.nvmrc) — Node 22. Run `nvm use` (or `fnm use`) before any `npm`
command; CI reads the same file, so the workflow and a local checkout cannot
drift apart.

It is pinned rather than a floor because the window is closed at both ends:

- **Older fails.** `web/` and `server/` execute their `.ts` sources directly
  under Node's native type-stripping — there is no build step — so a Node
  without it cannot run their tests, nor `server`'s entrypoint.
- **Newer needs a step we would rather not require.** Node 24 ships npm 12,
  which refuses to run a dependency's install script unless it is approved.
  `better-sqlite3` downloads its native binding *from* that script, so under
  npm 12 no binding is ever fetched and every `promptfoo` command aborts with
  `Could not locate the bindings file`, which reads like a
  `promptfooconfig.yaml` problem and is not one. Node 22 ships npm 10, which
  still runs install scripts, so the pinned version needs no approval step.

Each package's `engines` field records its own half of that constraint, and
each sets `engine-strict=true`, so `npm ci` on an out-of-range Node refuses
with the version it wants instead of installing a tree that breaks later.

`.nvmrc` names the Node 22 line, which is the only line all three accept. Keep
it current within that line (`nvm install 22`): `promptfoo/` inherits a
`>=22.22.0` floor from promptfoo itself, so an early 22.x is refused at install
— clearly, and with the range it wants, which is the point.

## Iterating on the prompt

See [`promptfoo/README.md`](promptfoo/README.md) for how to run the
evals locally, what they measure, and the edit-run-compare loop.

## Demoing a PR

A landed PR of the web harness can be turned into a short video that
proves what it changed, committed here for posterity (via git-LFS). The
end-to-end flow is the agent-invocable
[`pr-demo`](.claude/skills/pr-demo/SKILL.md) skill; see
[`web/e2e/README.md`](web/e2e/README.md) for the capture engine.

## Site

A public site at `shutupandlisten.sh` is planned but **not live yet**.
Visual design is being handled separately; this repo holds only the
prompt and its evaluation harness for now.

## License

MIT — see [LICENSE](LICENSE).
