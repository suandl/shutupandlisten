# PR-level demo capture

Point the engine at a markdown demo script and it produces a narrated MP4 that
**proves** a PR's behaviour — driven deterministically against the harness's sim
mode. Demos are for **human communication** — showing a teammate what a PR does — not
regression gates. The `_Prove:_` assertion each step carries against the live DOM is
there so what a demo shows is verified behaviour, not a screen tour.

First cut of su-lou.4 (parent), self-contained in this repo. Directional inspiration
from the suspended signal-loom rig's `demo-capture` skill; built from scratch to fit
su (npm, not pnpm; the Playwright **library**, not the MCP server; ffmpeg via
`ffmpeg-static`, not system ffmpeg or ImageMagick).

**This file is the engine reference — the grammar and the flags.** For the end-to-end
per-PR procedure (draft a script from a bead with the gc-toolkit `gc-demo-script`
skill, adapt, lint, capture, commit the MP4 through git-LFS), see the
[`pr-demo`](../../.claude/skills/pr-demo/SKILL.md) skill.

## Quick start

```bash
# one command: spins up the pinned :5173 dev server, drives the demo, tears down
npm run demo:u6

# check a script BEFORE spending a capture run on it
npm run demo:lint -- e2e/demos/<script>.md

# or point at any demo script
npm run demo:capture -- e2e/demos/<script>.md

# reuse a dev server you already have running (skip the spawn)
npm run demo:capture -- e2e/demos/u6-warmed-loop.md --base-url http://localhost:5173
```

Output lands at `e2e/demos/<script-name>.mp4` (silent) — or `<name>-narrated.mp4` when
narration is enabled (below). The MP4 keeps the script's basename verbatim, so a
bead-named script stays findable from its bead (`su-lou.10.6-silence-floor.md` →
`su-lou.10.6-silence-floor.mp4`). Flags: `--output <file.mp4>`, `--no-narrate`,
`--keep` (keep the `.captures/<run>/` frames + `manifest.json` + `issues.json`).

Committed MP4s under `demos/` are stored in **git-LFS** (root `.gitattributes`);
`git lfs install` once per machine before committing one.

**Exit code is non-zero if any step's proof fails** — the video is still written and
the `.captures/<run>/` dir (frames + `manifest.json` + `issues.json`) is kept even
without `--keep`, so a broken demo is never published silently and the failure is
inspectable.

## Prerequisites

- **Node ≥ 22** (runs the `.ts` engine directly via type stripping).
- **A Playwright browser.** Install once:
  ```bash
  npx playwright install chromium-headless-shell     # add --with-deps on a bare host (sudo apt)
  ```
  The engine prints this exact command if the browser is missing.
- **ffmpeg** — none needed system-wide, but it is **provisioned, not automatic**:
  ```bash
  npm run provision:ffmpeg
  ```
  `ffmpeg-static` (a devDependency) delivers its binary through an `install` lifecycle
  script, and npm ≥ 12 blocks install scripts for packages outside `allowScripts`. On
  such a host `npm ci` leaves the package directory populated but the binary absent
  (`npm install-scripts ls` lists it as blocked), so capture fails with a clear
  "no ffmpeg binary available" error until you run the line above. Alternatively point
  `FFMPEG_BIN` at a system ffmpeg. The `assemble.ts` unit tests that need a real binary
  skip cleanly while it is un-provisioned, so `npm test` passes either way.
- **Narration is optional.** With `OPENAI_API_KEY` set the engine synthesizes per-step
  narration (`tts-1`/`nova`, override via `DEMO_TTS_MODEL` / `DEMO_TTS_VOICE`) and mux
  it in. With no key — CI, a fresh clone — or on any narration failure it degrades to a
  **silent** MP4. The committed `u6-warmed-loop.mp4` is silent for exactly this reason.

## Demo-script format

Markdown that reads as a proof narrative and carries machine-checkable directives — the
same file documents the proof and drives it. See `demos/u6-warmed-loop.md`.

```markdown
# Demo: <title>

**Start:** `/?demo=<scenario>&llm=off&tts=off`
**Auth:** yes                        ← optional; accepted and ignored (no auth here)

<free prose → the cover subtitle>

## Steps

1. **<caption burned into the frame + spoken as narration>**
   `<action>`                       ← 0+ backtick directives, run in order
   <free prose → step description>
   _Prove:_ <human prose> `<assertion>`
   _Fail if:_ <human prose> `<assertion>`

## Scrutiny                          ← optional; rendered as a closing card
- <what a viewer should check critically>
```

**Superset of the gc-toolkit dialect.** `gc-demo-script` drafts scripts in the generic
`demo:capture` format — an `**Auth:**` line, a `## Scrutiny` section, and prose-only
`_Prove:_`/`_Fail if:_`. All of it parses here, so a raw draft runs unedited (its steps
record *manual* proofs, and the run output marks them as such) and adapting it is
purely additive: add the sim entrypoint, directives and assertions. Run
`npm run demo:lint` to see exactly which steps are still unproven.

**Actions:** `goto <path>` · `wait <ms>` · `waitFor <selector>` ·
`waitForText <selector> ~ <substring>` · `click <selector>` · `scroll <selector>`
(centre a below-the-fold panel so the frame shows it).

**Assertions** (in `_Prove:_` / `_Fail if:_`):
`visible <sel>` · `hidden <sel>` · `count <sel> <op> <n>` (`>= > == <= <`) ·
`text <sel> ~ <matcher>` · `eval <js-expression>`. A matcher is `/regex/`,
`"substring"`, or a bare substring. `_Prove:_` must hold (polled); `_Fail if:_` fails
the step if it matches.

## How it works

`capture.ts` parses the script (`demo-script.ts`, pure + unit-tested in
`demo-script.test.ts`), ensures the pinned :5173 dev server, then drives a headless
browser step by step: run the actions, check the assertion against the live DOM, burn
the caption in as a DOM overlay (so the screenshot carries crisp text in the app's own
font — no ffmpeg `drawtext`/ImageMagick), and screenshot the proof frame. It writes
`manifest.json` + `issues.json`, then `assemble.ts` concatenates the frames into an MP4
(with optional narration). The frame order is cover → steps → scrutiny card (when the
script has a `## Scrutiny` section). Intermediate frames live under `.captures/`
(gitignored, and where `gc-demo-script` drops its drafts under `demo-scripts/`); only
the demo script and the final MP4 under `demos/` are committed.

`lint.ts` is the pre-flight over the same parse: it reports what the driver would
silently ignore — unregistered `?demo=` scenarios, steps with no machine assertion,
directives dropped for a typo, over-long captions, missing git-LFS. Its `lintDemo()` is
pure over an explicit environment, so the rules are unit-tested in `lint.test.ts`.

## Deterministic sim substrate

Demos run against the harness's **sim mode** with `?demo=<scenario>` — a mic-less,
scripted warmed loop (`src/simulator.ts` `DEMO_SCRIPTS`). `llm=off&tts=off` forces the
labelled-stub listener + placeholder-tone voice so a run is fast and identical every
time. That is deliberate: the real on-device models currently degrade to the same
stub/tone in-browser (su-lou.8), which is exactly why sim mode — not a live mic — is
the deterministic substrate a committed proof needs. Live-mic / real-ONNX capture is a
follow-up.
