---
name: pr-demo
description: >-
  Turn a landed PR of the shutupandlisten web harness into a committed, narrated
  MP4 that PROVES what it changed. Drives the whole per-PR demo flow end to end,
  no human step: drafts a script from the bead/PR (via the gc-toolkit
  gc-demo-script skill), adapts it to this repo's deterministic sim harness,
  lints, captures, and commits the MP4 through git-LFS with a link in the PR
  body. Use when asked to demo a PR, make/record a demo video, or produce a
  proof capture for a shutupandlisten web change.
---

# Per-PR demo — shutupandlisten web harness

Turn a landed PR of the web harness (`web/`) into a short video that **proves**
what it changed, and commit that video to this repo for posterity.

Demos here are for **human communication** — showing a teammate what a PR does.
They are not regression gates. The machine assertion each step carries exists so
what the video shows is *verified behaviour* rather than a screen tour.

This flow is **fully agent-driven** — no human executes any step. It has two
halves from two places, and this skill is the su-side consumer that runs both:

| Half | Where it lives | What it does |
| --- | --- | --- |
| draft | gc-toolkit pack — the `gc-demo-script` skill | Reads a closed bead (description, notes, parent, PR body + diff) and drafts a demo script |
| capture | **this repo** — `web/e2e/` (`npm run demo:*`) | Drives the script against sim mode, checks each proof, assembles the MP4 |

The split is deliberate: drafting needs the bead ledger and is generic;
capturing needs this repo's toolchain. Note the engine here is su's own
(`web/e2e/`, the Playwright **library** + `ffmpeg-static`) — **not** the
gc-toolkit `demo:capture` MCP skill. Only the *draft* step reaches into
gc-toolkit.

## Inputs

- A **landed / open PR** of the web harness and its **bead id** (e.g.
  `su-lou.10.6`, PR #33). The demo proves that PR's change.
- Optionally a `--focus "<area>"` to steer the draft.

## Prerequisites (ensure these before capturing; each is a one-time setup)

- **Node ≥ 22** and `npm ci` in `web/`.
- **A Playwright browser**: `npx playwright install chromium-headless-shell`
  (add `--with-deps` on a bare host). The engine prints this exact command if
  it is missing.
- **git-lfs**, on the machine that COMMITS the video: `git lfs install` (once).
  Without it, git stores raw video bytes while `.gitattributes` claims a
  pointer. `npm run demo:lint` warns when this is the case.
- **ffmpeg** — none needed; `ffmpeg-static` is a devDependency.
- **`OPENAI_API_KEY` — optional.** With it, each step's caption is also spoken
  and muxed in (`tts-1`/`nova`, ~$0.01 a demo). Without it, or on any narration
  failure, the engine degrades to a **silent** MP4 — that is fine and expected;
  committed demos are silent for exactly this reason.

## The flow

### 1. Draft from the bead — invoke `gc-demo-script`

Invoke the gc-toolkit **`gc-demo-script`** skill on the bead + PR:

```
/gc-demo-script <bead-id> --pr <n> --focus "<area>"
```

It writes `web/e2e/.captures/demo-scripts/<bead-id>-<slug>.md` and stops. It
does **not** capture. Do not reimplement drafting here — the general
bead→script capability is owned by gc-toolkit and stays there.

The draft is written for a **generic** web app: it describes the feature in
prose without knowing how to drive *this* harness. That is expected. The grammar
this repo executes is a strict **superset** of the generic dialect, so a raw
draft parses and runs unedited — its steps simply record *manual* proofs until
you adapt them.

### 2. Adapt to THIS harness — the part the draft cannot know

Copy the draft to `web/e2e/demos/<bead-id>-<short-slug>.md` and make it a proof.
Adaptation is **additive** — never restructure the file. Keep the draft's bold
step captions (they are burned into the frames and spoken) and its `## Scrutiny`
section (it renders as a closing card; a demo that names its own open risks is
worth more than one that implies all is well).

Add these three things the generic draft omits:

1. **A start URL that arms the deterministic substrate.** Either
   - a loop-driving sim scenario: `**Start:** /?demo=<scenario>&llm=off&tts=off`
     — `<scenario>` must be one registered in `src/simulator.ts` `DEMO_SCRIPTS`
     (e.g. `u6-warmed-loop`); or
   - `**Start:** /?llm=off&tts=off` plus a step that clicks one of the classic
     timing scripts in the sim controls (e.g.
     `` `click #sim-controls button:has-text("Thinking pause")` ``).

   `llm=off&tts=off` forces the labelled-stub listener and placeholder tone, so
   a run is fast and **identical every time** — the property a committed proof
   depends on.

2. **Directives** — backtick actions, run in order:
   `` `goto <path>` `` · `` `wait <ms>` `` · `` `waitFor <selector>` `` ·
   `` `waitForText <selector> ~ <substring>` `` · `` `click <selector>` `` ·
   `` `scroll <selector>` `` (centre a below-the-fold panel so the frame shows
   it).

3. **A machine assertion on every `_Prove:_`** (and ideally each `_Fail if:_`) —
   this is the difference between a demo that proves and one that merely shows:
   `` `visible <sel>` `` · `` `hidden <sel>` `` ·
   `` `count <sel> <op> <n>` `` (`>= > == <= <`) ·
   `` `text <sel> ~ <matcher>` `` · `` `eval <js>` ``. A matcher is `/regex/`,
   `"substring"`, or a bare substring.

**Two known mismatches in every gc-demo-script draft** (the skill cannot know
them — do not treat them as errors):

- Its **file-category table is Next.js-shaped** (`src/app/**`,
  `src/components/**`). Here, *user-facing* means `web/index.html`,
  `web/src/main.ts`, and the modules behind the panels (`knobs.ts`,
  `transcript.ts`, `loop-metrics.ts`, `response-hierarchy.ts`). Everything under
  `spec/`, `promptfoo/`, `docs/`, and the `*.test.ts` files is **not**
  user-facing — do not build demo steps around them.
- Its **`**Auth:** yes`** line is meaningless here (a local dev server, no auth).
  The parser accepts and drops it; leave it or remove it, either is fine.

The full grammar (every directive, assertion, and flag) lives in
[`web/e2e/README.md`](../../../web/e2e/README.md). The canonical worked example —
a real PR turned into a committed proof — is
[`web/e2e/demos/su-lou.10.6-silence-floor.md`](../../../web/e2e/demos/su-lou.10.6-silence-floor.md).
Read both when adapting.

### 3. Lint before you capture

```bash
cd web && npm run demo:lint -- e2e/demos/<script>.md
```

A capture costs a dev server, a browser and an encode, and a script that will
produce a screen tour looks fine in markdown. The linter reads the script
exactly as the driver will and reports what the driver would silently do nothing
about: a `?demo=` scenario that is not registered (an **error** — the harness
would boot unarmed), steps with no machine assertion, directives dropped for a
typo, captions too long for the frame, and whether the MP4 could even be
committed correctly. **Fix every warning** — the warning list *is* your
adaptation checklist. Re-lint until clean.

### 4. Capture

```bash
cd web && npm run demo:capture -- e2e/demos/<script>.md
```

Output: `web/e2e/demos/<script-name>.mp4` (and `<name>-narrated.mp4` when
narration is on). Flags: `--base-url` to reuse a running server, `--output`,
`--no-narrate`, `--keep` to keep the frames.

**A failed proof exits non-zero**, keeps `.captures/<run>/` (frames +
`manifest.json` + `issues.json`), and burns a `PROOF FAILED` badge into the
frame. A broken demo is never published quietly. Fix the script — or the
feature — and re-run until the capture is green.

### 5. Commit the video (git-LFS) and link it in the PR

```bash
git add web/e2e/demos/<script>.md web/e2e/demos/<script>.mp4
git show :web/e2e/demos/<script>.mp4 | head -1   # expect: version https://git-lfs...
```

Commit the script **beside** the video — the script is the video's source: it
says what was claimed and how it was checked, and it can be re-run when the
harness moves.

MP4s are committed **for posterity, through git-LFS** (the su-lou.4 operator
decision): root `.gitattributes` routes `*.mp4` through the LFS filter, so
history carries a ~130-byte pointer and the bytes live in LFS storage. If the
`git show` above prints binary instead of a pointer, git-lfs was not installed
when you committed — undo the commit, `git lfs install`, and re-add.

Then **link the video in the PR body** — GitHub renders a committed MP4 inline.

## Naming

Use `<bead-id>-<short-slug>` for **both** files, and let the MP4 keep the
script's basename verbatim (the engine's `outputSlug`, not `slugify` — dots in a
bead id survive). That preserves the one mapping this flow depends on: from a
bead, find its demo.

## Deliberate limits

- **Sim mode is the substrate, not live mic.** It is mic-less and scripted, so
  two runs are identical and a committed video means something. (Live-mic /
  real-ONNX capture is a separate axis; the real models degrade to the same
  stubs in-browser today anyway — su-lou.8.)
- **Not one frozen script.** Each PR gets its own, demoing whatever is right for
  that PR — the flow is the fixed part, the script is not.
- **Not a CI gate.** Nothing runs captures automatically; a demo is made when
  someone wants to show a PR.
