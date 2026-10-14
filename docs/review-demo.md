# Demo check — shutupandlisten visual surfaces

A review can capture the `web/` harness, a browser app, and the HTML mockups of
the iOS app's screens under `ios/mockups/`. The iOS app itself has no capture
path a review uses. The pack has none, and this repo's
`.github/workflows/ios-visual.yml`, which records the app on a simulator, is
left for a person to dispatch on purpose (its header says why). A change a
person must see in the app is therefore a visual the review cannot produce. The
generic method's note for that case applies, and it can name that workflow as
what would produce the visual.

## Capturing the web harness

Serve the reviewed worktree with the harness's dev server. Install its
dependencies with `npm ci` in `$REVIEW_WT/web`, then give `rig-demo-capture.sh`
`--serve "npm run dev" --cwd "$REVIEW_WT/web"`. The dev server is pinned to port
5173, which is also the capture script's default port, and it exits rather than
move to another port when 5173 is taken.

Start the script in sim mode with the on-device models switched off:

    **Start:** `/?demo=<scenario>&llm=off&tts=off`

The harness loads in sim mode, which needs no microphone. `demo=<scenario>`
plays one of the scripted loops in `DEMO_SCRIPTS` (`web/src/simulator.ts`) a
moment after the page loads. An unknown name plays nothing and logs the known
names to the console. `llm=off` forces the labelled stub listener and `tts=off`
forces the placeholder tone, so the run is fast and the same every time. Leave
out `demo=` when the steps reach the change by interacting with the page.

`web/e2e/demos/` holds this repo's own demo scripts. They show which scenarios,
selectors, and assertions prove a harness behavior, so read them for a starting
point. They are written for the repo's own capture engine in `web/e2e/`, which
the `pr-demo` skill (`.claude/skills/pr-demo/SKILL.md`) uses to commit a demo of
a landed change. A review does not use that flow: it captures with
`rig-demo-capture.sh` and delivers the clip inline, never committed.

## Capturing the iOS mockups

The pages under `ios/mockups/` are self-contained HTML that link only to each
other. Serve them with `--serve-dir "$REVIEW_WT/ios/mockups"` and start at the
page the diff changes, for example:

    **Start:** `/session-screen.html`

## Committed demo clips

Every MP4 this repo commits is stored in git-LFS (`.gitattributes`), the demo
clips under `web/e2e/demos/` included. The reviewed commit holds a pointer to
each clip, not the clip itself, so `demo-repo-artifact.sh deliver` refuses them.
