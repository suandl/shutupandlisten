# ShutUpAndListenAppTests

Tests for the SwiftData layer of the Phase 4 rewrite
(`docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md`): the
V1 → V2 migration (`MigrationTests`), the `PersistenceWriter` per-final save /
close-out / zero-speech / recovery behavior (`WriterTests`), launch recovery and
the orphan sweep (`RecoveryTests`), and `SpeechOutput`'s completion contract
(`TTSSinkTests`).

They cannot run headless — they exercise SwiftData against a real store and
AVFoundation against a real synthesizer — so they live in a unit-test bundle
target hosted by the app, and need a simulator or device.

Run them with ⌘U in Xcode, or on their own from the command line:

```sh
xcodebuild test \
  -project ios/ShutUpAndListen.xcodeproj \
  -scheme ShutUpAndListen \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:ShutUpAndListenAppTests
```

`-only-testing:` matters more than it looks. The scheme's two testables are
`parallelizable`, so a plain ⌘U runs this bundle and `ShutUpAndListenUITests` in
separate processes with separate log streams — and the UI test drives a full
70-second capture session on a device. Isolating this bundle keeps the run to a
few seconds and puts every result in one place.

A simulator destination is preferred: these tests build their own stores under
`temporaryDirectory` and never touch the real library, so they gain nothing from
real hardware while paying for code signing and keychain access.
