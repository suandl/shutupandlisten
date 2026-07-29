---
title: 'Per-PR demo flow: a landed bead becomes a committed, narrated MP4'
type: process
status: in use — worked example at web/e2e/demos/su-lou.10.6-silence-floor.md
unit: su-lou.4
beads: [su-lou.4.1, su-lou.4.2]
date: 2026-07-29
---

# Per-PR demo flow

Turn a landed PR of the web harness into a short video that **proves** what it
changed, and commit that video to this repo.

Demos here are for **human communication** — showing a teammate what a PR does.
They are not regression gates. The machine assertions each step carries exist so
what the video shows is verified behaviour rather than a screen tour.

Two halves, from two places:

| Half | Where it lives | What it does |
| --- | --- | --- |
| `gc-demo-script` | gc-toolkit pack (a skill) | Reads a closed bead — description, notes, parent, PR body and diff — and drafts a demo script |
| `demo:capture` | this repo (`web/e2e/`) | Drives the script against sim mode, checks each proof, assembles the MP4 |

The split is deliberate: drafting needs the bead ledger, capturing needs this
repo's toolchain. A draft is reviewable before anyone spends a capture run on it.

## Prerequisites

- **Node ≥ 22**, and `npm ci` in `web/`.
- **A Playwright browser** — `npx playwright install chromium-headless-shell`
  (add `--with-deps` on a bare host). The engine prints this exact command if it
  is missing.
- **git-lfs**, on the machine that COMMITS a video:
  `sudo apt install git-lfs && git lfs install` (once). Without it, git stores
  raw video bytes while `.gitattributes` claims a pointer. `npm run demo:lint`
  warns when this is the case.
- **ffmpeg** — none needed; `ffmpeg-static` is a devDependency.
- **`OPENAI_API_KEY` — optional.** With it, each step's caption is also spoken
  and muxed in (`tts-1`/`nova`, ~$0.01 a demo). Without it, or on any narration
  failure, the engine degrades to a **silent** MP4. Both committed demos are
  silent for this reason.

## The flow

### 1. Draft from the bead

```bash
# in a session where the gc-toolkit pack's skills are materialised
/gc-demo-script <bead-id> --pr <n> --focus "<area>"
```

It writes `web/e2e/.captures/demo-scripts/<bead-id>-<slug>.md` and stops. It does
NOT capture — review the draft first.

The draft is written for a generic web app, so expect it to describe your feature
in prose without knowing how to drive this harness. That is fine and expected: the
grammar this repo executes is a strict **superset** of the generic dialect, so a
raw draft parses and runs unedited — its steps simply record manual proofs.

Two mismatches worth knowing about, because the skill cannot know them:

- Its file-category table is Next.js-shaped (`src/app/**`, `src/components/**`).
  Here, user-facing means `web/index.html`, `web/src/main.ts`, and the modules
  behind the panels (`knobs.ts`, `transcript.ts`, `loop-metrics.ts`,
  `response-hierarchy.ts`). Everything under `spec/`, `promptfoo/`, `docs/` and
  the `*.test.ts` files is not.
- Its `**Auth:** yes` line is meaningless here (a local dev server, no auth). The
  parser accepts and drops it.

### 2. Adapt it to the harness

Copy the draft to `web/e2e/demos/<bead-id>-<short-slug>.md` and add what makes it
a proof. Adaptation is **additive** — you never restructure the file:

- **A start URL that arms the substrate.** Either a loop-driving scenario
  (`/?demo=u6-warmed-loop&llm=off&tts=off`) or a step that clicks one of the
  classic timing scripts in the sim controls. `llm=off&tts=off` forces the
  labelled-stub listener and placeholder tone, so a run is fast and identical
  every time.
- **Directives** — backtick actions run in order:
  `goto` · `wait` · `waitFor` · `waitForText` · `click` · `scroll`.
- **A machine assertion on every `_Prove:_`** (and ideally `_Fail if:_`):
  `visible` · `hidden` · `count <sel> <op> <n>` · `text <sel> ~ <matcher>` ·
  `eval <js>`. This is the difference between a demo that proves and one that
  merely shows.

Keep the draft's narration voice — the bold headings are burned into the frames
and spoken. Keep its `## Scrutiny` items too; they render as a closing card, and a
demo that names its own open risks is worth more than one that implies all is well.

See `web/e2e/README.md` for the full grammar, and
`web/e2e/demos/su-lou.10.6-silence-floor.md` for the worked example.

### 3. Lint before you capture

```bash
cd web && npm run demo:lint -- e2e/demos/<script>.md
```

A capture costs a dev server, a browser and an encode, and a script that will
produce a screen tour looks fine in markdown. The linter reads the script exactly
as the driver will and reports what the driver would silently do nothing about: a
`?demo=` scenario that is not registered (an error — the harness would boot
unarmed), steps with no machine assertion, directives dropped for a typo, captions
too long for the frame, and whether the MP4 could even be committed correctly.

On the raw draft for su-lou.10.6 it printed 13 warnings — one per adaptation the
draft needed. That list IS the adaptation checklist.

### 4. Capture

```bash
cd web && npm run demo:capture -- e2e/demos/<script>.md
```

Output: `web/e2e/demos/<script-name>.mp4` (and `<name>-narrated.mp4` when
narration is on). Flags: `--base-url` to reuse a running server, `--output`,
`--no-narrate`, `--keep` to keep the frames.

**A failed proof exits non-zero**, keeps `.captures/<run>/` (frames +
`manifest.json` + `issues.json`), and burns a PROOF FAILED badge into the frame.
A broken demo is never published quietly. Fix the script — or the feature — and
re-run.

### 5. Commit the video

```bash
git add web/e2e/demos/<script>.md web/e2e/demos/<script>.mp4
git show :web/e2e/demos/<script>.mp4 | head -1   # expect: version https://git-lfs...
```

Commit the script beside the video. The script is the video's source: it says what
was claimed and how it was checked, and it can be re-run when the harness moves.

MP4s are committed **for posterity, through git-LFS** (the su-lou.4 operator
decision): `.gitattributes` routes `*.mp4` through the LFS filter, so history
carries a ~130-byte pointer and the bytes live in LFS storage. If `git show` above
prints binary instead of a pointer, git-lfs was not installed when you committed —
undo the commit, install it, and re-add.

Link the video in the PR body. GitHub renders a committed MP4 inline.

## Naming

`<bead-id>-<short-slug>` for both files, and the MP4 keeps the script's basename
verbatim (`outputSlug`, not `slugify` — dots in a bead id survive). That keeps the
one mapping this flow depends on: from a bead, find its demo.

## Deliberate limits

- **Sim mode is the substrate, not live mic.** It is mic-less and scripted, so two
  runs are identical and a committed video means something. Live-mic / real ONNX
  capture is a separate axis (su-lou.8 notes the real models degrade to the same
  stubs in-browser today anyway).
- **Not one frozen script.** Each PR gets its own, demoing whatever is right for
  that PR — the flow is the fixed part, the script is not.
- **Not a CI gate.** Nothing runs captures automatically. A demo is made when
  someone wants to show a PR.
- **Deferred:** serving a demo over a tailscale URL for remote/clickable viewing
  (the optional half of su-lou.4.2); narrated audio on a machine with a key.
