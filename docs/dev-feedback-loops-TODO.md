# Dev feedback loops — closing the visibility gap (TODO / backlog)

**Created:** 2026-07-30 · **Branch:** `claude/ios-app-evaluation-wre62e`

## Why this exists

This is a real-time, audio-first iOS app. Its *quality* lives in the on-device,
real-time layer — turn-taking timing, whether interjections land on the right
beat, whether the analyst says something useful, whether the transcript is
right. In-container development can only build/test the pure Kit
(`ios/ShutUpAndListenKit`, `swift test`); the App target is Xcode/macOS-only and
the live behaviour is invisible to the agent. So the quality-determining parts
are exactly the parts the agent can't see. These feedback loops exist to convert
real behaviour into **artifacts the agent can inspect** and **tests it can run**.

Origin: brainstorm on 2026-07-27 (five loops below). Status updated 2026-07-30
after the capture / audio-injection work landed.

## Status legend
✅ exists · 🟡 partial · ⬜ TODO · (where it runs: **container** = agent can run it · **Mac/CI** · **phone**)

---

## 1. Session tracing → replayable vectors — 🟡 partial
**Goal:** emit one session as a structured, timestamped **trace** (VAD
speech-start/end, `TurnDetector` state transitions, each gate decision *with its
`reason` string*, each model call = prompt+response+usage+latency, TTS
start/stop/barge-in), then fold real traces into `spec/turn-vectors/` and replay
them through `TurnDetector`/`decideTier` in `swift test`.

- ✅ **Observe a real session end-to-end** (Mac/CI): the visual-capture CI +
  in-app audio-injection pipeline runs the real app on a fixture `.wav` through
  the real VAD/turn/gate/analyst and captures screenshots + video.
  (`ios/scripts/capture-demo.sh`, `.github/workflows/ios-visual.yml`,
  `ios/App/Audio/CaptureAudioInjector.swift`; see memory
  `ios-visual-capture-ci-status`, `ios-capture-audio-injection-status`.)
- ⬜ **Structured trace emitter** (App): no JSONL / decision-log emitter exists
  yet (`grep` for trace/jsonl/decisionLog → none). The gate already produces a
  per-decision `reason`; this needs a sink that writes the whole timeline to a
  file saved next to the `.m4a`, plus a "share trace" affordance.
- ⬜ **Real-session → golden-vector capture** (container): turn a captured trace
  into a `spec/turn-vectors/` case so a "the timing felt wrong here" report
  becomes a reproducible `swift test`. `GoldenVectorTests` already replays vectors.

**Highest leverage remaining item in this whole doc.**

## 2. Offline session simulator the agent can run — 🟡 mostly exists
**Goal:** run the real decision path over a scripted/captured session and print
the timeline, no phone.

- ✅ **`sul-demo`** (container): replays a scripted session through the EXACT
  production path (TurnDetector → escalate-slowly gate → listener model).
  `swift run sul-demo` (deterministic) · `--realtime` (paced) ·
  `ANTHROPIC_API_KEY=… --live` (real Claude replies).
  (`ios/ShutUpAndListenKit/Sources/sul-demo/Demo.swift`.)
- ⬜ **Drive it from a captured real trace** instead of only the canned script —
  depends on #1's trace format. This is the bridge that makes a real bad session
  reproducible in-container.
- ⬜ **Print a decision timeline** (state, reason, chosen interjection) in a
  diff-friendly form the agent can compare across changes.

## 3. Prompt-quality evals (promptfoo) — 🟡 partial (listener done)
**Goal:** grade interjection *content* quality separately from real-time timing.

- ✅ **Listener prompt** (container, needs model network): `promptfoo/` has
  scenarios (feature-idea, essay-thesis, research-hunch, story-premise), judges
  (restraint, probing-depth, no-summarize, variety), a multi-turn provider, and
  a `thinker.md` simulator.
- ⬜ **Pull-thread prompt** evals (does it always ask a specific question / an
  honest "not yet", never defer).
- ⬜ **Analyst prompt** evals (candidates anchored to what was said, correct
  register, freshness/expiry behaviour, silence when appropriate).

## 4. Live debug panel in the app — 🟡 partial
- ✅ Developer-gated Settings section; cost readout (`showCostReadout`); capture
  seed state.
- ⬜ Live internals readout: current turn state, patience progress, last gate
  decision + `reason`, last prompt/response, current analyst candidates +
  freshness. Doubles as the human-readable face of #1's trace.

## 5. "Bad moment" report format — ⬜ TODO
A template pairing a session timestamp + what it did + what was wanted + the
trace/audio, so feedback lands as something directly actionable (lined up against
the transcript's `startMs`/`endMs`) rather than reconstructed from prose.

---

## Enablers (cheap, high-return)
- ⬜ **Commit a few anonymized real session bundles** (transcript JSON + trace +
  `.m4a`) into `ios/fixtures/` so the agent develops against real conversations.
- ✅ **Model endpoints allowlisted** in the devcontainer firewall: `api.openai.com`
  and `api.anthropic.com` have been in `.devcontainer/allowed-domains.txt` since
  #24. The network half of running #3's evals and `sul-demo --live` in-container
  is already done.
- ⬜ **Get the keys into the container** — what actually gates those live runs is
  credentials, not network. `sul-demo --live` reads `ANTHROPIC_API_KEY` from the
  environment; promptfoo takes `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from either
  a repo-root `.env.local` (gitignored) or 1Password via `scripts/eval-keys.sh`
  (`op run`, authed by `OP_SERVICE_ACCOUNT_TOKEN` or
  `~/.config/gascity/op-sa-token`). Note the `op` path resolves its `op://`
  references over the network and **no 1Password domain is allowlisted** — that
  path needs one added (plus `sudo /usr/local/bin/init-firewall.sh` to re-apply);
  the `.env.local` path needs no firewall change at all.

## Suggested order
1. **#1 structured trace emitter + real-session→vector capture** — unlocks the
   only loop that turns a felt bug into a test the agent owns.
2. **#2 trace-driven `sul-demo`** — replay that trace in-container.
3. **#3 analyst + pull-thread evals** — for the "it says dumb things" class.
4. #4 / #5 as ongoing support.
