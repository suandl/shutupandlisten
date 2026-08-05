---
title: "PatienceRing levelNorm/levelDb: intentional level-reactivity, not dead code"
type: findings
status: audited — 2026-08-04; verdict KEEP (no deletion)
bead: su-uzy9.3
date: 2026-08-04
---

# PatienceRing `levelNorm` / `levelDb` audit

## The question

su-uzy9 originally carried this as a "vestigial `levelNorm`/`levelDb` chain in
`PatienceRing` after the glow removal (harmless dead-code)." The host corrected
that framing before filing su-uzy9.3 and asked for an audit, **not** a delete:
decide whether the residual `levelNorm` effects are intentional (a subtle
level-reactive ring) or leftovers of a removed glow — and, because this is
visible UI, decide *before* touching anything.

## Verdict: intentional and fully live — KEEP as-is

`levelNorm` (derived from `levelDb`, normalised at
`ios/App/UI/PatienceRing.swift:157-158`) drives **three live expressions**, all
on `main`:

1. `PatienceRing.swift:61` — the interior glow bloom's opacity
   (`0.04 + 0.16 * levelNorm`), rendered while `phase == .listening ||
   .thinkerSpeaking`.
2. `PatienceRing.swift:103` — `.animation(.easeOut(duration: 0.18), value:
   levelNorm)`, which smooths the follow so the glow/scale glide with the voice
   instead of stepping per audio buffer.
3. `PatienceRing.swift:139` — the `levelScale` "lean-in"
   (`1 + 0.02 * levelNorm`), a subtle scale that composes with the timed-pause
   breath in `ringScale`.

These are not orphaned. The code comments describe them as a deliberate
redesign — the level-responsive glow "reads as one smooth, breathing response
to your voice rather than the old fixed-rate shimmer" (`PatienceRing.swift:54-58`),
and the lean-in makes listening "feel responsive instead of inert"
(`PatienceRing.swift:134-136`). The original "after the glow removal" premise is
itself wrong: the glow was **redesigned into** this level-reactive form, not
removed.

## The feed is live end to end

The value is plumbed from the microphone all the way to the ring; nothing in the
chain is stubbed or dead:

```
CaptureController.onLevel (mic dBFS)
  → SessionController.swift:886-887  capture.onLevel = { … self?.inputLevelDb = db }
  → SessionController.swift:108      @Published private(set) var inputLevelDb   (re-renders SwiftUI on change)
  → SessionView.swift:188            PatienceRing(… levelDb: controller.inputLevelDb)
  → PatienceRing.swift:41            var levelDb
  → PatienceRing.swift:157-158       levelNorm = clamp((levelDb + 60) / 50, 0…1)
  → the three expressions above
```

## Action taken

None on the code — deleting any of it would remove visible, intentional UI
behaviour. The only correction owed was to the framing, and that lived on the
su-uzy9 bead, not in the source: a search of `ios/` for
`dead-code|vestigial|glow removal|leftover` turned up no such note in the code.
This document is the durable record that the chain was examined and is being
kept on purpose, so it is not re-flagged as dead code later.
