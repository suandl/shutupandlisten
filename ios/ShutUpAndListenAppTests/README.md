# ShutUpAndListenAppTests

Simulator-only tests for the SwiftData layer of the Phase 4 rewrite
(`docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md`):
the V1 → V2 schema migration stage (`MigrationTests`) and the
`PersistenceWriter` per-final save / close-out / zero-speech / recovery
behavior (`WriterTests`). These cannot run headless — they exercise
SwiftData against a real store — so they live in an Xcode unit-test-bundle
target, which is **not yet wired into the project**: in Xcode, add a new
target (File → New → Target → Unit Testing Bundle), name it
`ShutUpAndListenAppTests` with the `ShutUpAndListen` app as its host
application, and point its folder at `ios/ShutUpAndListenAppTests` as a
file-system-synchronized group (matching the app target's setup) so these
files are picked up automatically; then run with ⌘U on any iOS 26 simulator.
