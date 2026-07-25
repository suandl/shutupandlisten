# fixtures — captured-session replays

A fixture is one recorded dictation session: the **thinker** utterances as the
speech-to-text layer actually produced them, plus enough metadata to know
where they came from. `providers/replay.js` feeds a fixture's utterances to
the listener under test verbatim — no simulator calls — so a replay cell
scores the listener on live-shaped disfluent input instead of the simulator's
clean prose (the clean-text upper bound documented in
[`docs/findings/on-device-text-quality.md`](../../docs/findings/on-device-text-quality.md) §5–6).

> **The two `hand-authored-*.json` files here are hand-authored
> placeholders, not device captures.** They made the replay path runnable
> and testable before the iOS export shipped; the disfluent text is
> written to *resemble* `SFSpeechRecognizer` output (fillers, restarts,
> dropped punctuation, run-ons), but nobody ever dictated it. Their
> `session.source` says `"hand-authored"` for exactly this reason — never
> label a fixture `"ios-sfspeechrecognizer"` unless it really came off a
> device. Keep the `hand-authored-` filename prefix for placeholders.

## Schema — the contract the iOS export must meet

This file is the CONTRACT. The executable version is
[`lib/fixture-schema.js`](../lib/fixture-schema.js) — it validates every
fixture in `npm run validate`, and `providers/replay.js` refuses to replay a
fixture that fails it. The iOS export produces this JSON from a SwiftData
`SessionRecord` (`ios/App/Support/SessionRecord.swift`): the pure encoder is
`ios/ShutUpAndListenKit/Sources/TurnEngine/FixtureExport.swift` — its tests
run the encoder's output through `lib/validate-fixtures.js` itself, so the
two sides cannot drift silently — and the session detail screen's "Export
eval fixture" action (`ios/App/UI/SessionDetailView.swift`) shares the file.
The mapping is noted per field.

```jsonc
{
  "schemaVersion": 1,              // required, literal 1 — bump on breaking change
  "session": {                     // required
    "id": "…",                     // required, non-empty — SessionRecord.id (UUID string)
    "date": "2026-07-25T09:30:00Z",// required, ISO-8601 — SessionRecord.startedAt
    "source": "…",                 // required, non-empty — provenance, e.g.
                                   //   "ios-sfspeechrecognizer" (real device capture)
                                   //   "hand-authored"          (placeholder, like the examples)
    "knobs": {}                    // optional object — the TurnKnobs in effect
                                   // (silenceFloorMs, incompleteExtensionMs,
                                   // completionThreshold, useSmartTurn), free-form
  },
  "utterances": [                  // required, non-empty, in spoken order — the
                                   // SessionRecord entries with speaker == "thinker",
                                   // text EXACTLY as the STT produced it (do not
                                   // clean up punctuation, casing, or fillers —
                                   // the disfluency is the data)
    {
      "text": "…",                 // required, non-empty
      "startSeconds": 0.0,         // optional, >= 0 — offset from session start
      "endSeconds": 12.3           // optional, >= startSeconds
    }
  ],
  "landingIndex": 4                // optional, 0-based utterance index of the turn
                                   // that ends the dictation (the landing —
                                   // CONCEPTS.md). Default: the last utterance,
                                   // mirroring the simulator loop where the last
                                   // thinker turn lands the idea.
}
```

Notes for the export:

- **Thinker turns only.** The listener side of the saved session is dropped —
  replay exists to produce a *fresh* listener response to the same input, so
  the recorded listener turns would only contaminate the history.
- **Do not synthesize what wasn't captured.** `startSeconds`/`endSeconds` and
  `session.knobs` are optional; omit them rather than inventing values. Timing
  is worth exporting when available — the live gate routes on it, and a future
  harness may too.
- **Unknown extra keys are tolerated** (the validator checks what it knows),
  but don't rely on that: anything load-bearing should become a schema field
  with a version bump.

## Using a fixture

Point a `providers/replay.js` entry at it in `promptfooconfig.yaml`
(`fixturePath` is relative to `promptfoo/`), or run the smoke cell:

```sh
npm run eval:smoke:replay   # claude prompt × replay of the reading-app fixture
npm run validate            # includes the schema check for every fixtures/*.json
```
