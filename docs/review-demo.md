# Demo check — shutupandlisten capture engine

The draft half of the demo method is the pack's `skills/gc-demo-script/SKILL.md`,
used as-is: it reads the bead and the diff and writes a `demo:capture`-format
script. The capture half is this repo's own, not the pack's
`skills/demo-capture/SKILL.md`.

Capture runs through `web/e2e/` (`npm run demo:*`), a Playwright library plus
`ffmpeg-static` that drives the script against the web harness's deterministic
sim mode, checks each step's proof, and assembles the MP4, committed through
git-LFS. `.claude/skills/pr-demo/SKILL.md` drives the whole flow end to end.

Demos here prove a `web/` harness change to a human; they are not regression
gates. This capture flow covers the `web/` harness; the iOS app's capture is its
own subject (`docs/testing-strategy.md`). The demo check judges whether a change
the operator must watch was recorded doing the thing.
