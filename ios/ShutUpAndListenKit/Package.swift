// swift-tools-version: 6.1
// ShutUpAndListenKit — the platform-agnostic core of the iOS quiet companion.
//
// TurnEngine is a pure Swift port of spec/turn-state-machine.md and the
// response-hierarchy gate (web/src/turn-detection.ts / response-hierarchy.ts).
// It contains no audio code and no UI, which is what lets the golden vectors
// (spec/turn-vectors/) test it headlessly — including on Linux CI.
//
// TranscriptCore is the transcript spine of the iOS 26 capture rewrite
// (docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md): the
// append-only TranscriptStore actor, segment/event model, turn tagging, and
// the storage-entry mapping. It depends on TurnEngine (for Tier) — TurnEngine
// itself stays a pure leaf with no incoming dependencies added here.
//
// ClaudeClient is the raw-HTTP Messages API adapter the listener tiers use.
//
// Platform versions are string literals, not `.v26` constants: the headless
// toolchain that runs `swift test` (Swift 6.1 on Linux/macOS) predates the
// PackageDescription that defines `.iOS(.v26)`, and the string form is
// accepted by every toolchain. The macOS floor stays low on purpose so
// headless `swift test` keeps working (plan, Phase 0).
import PackageDescription

let package = Package(
    name: "ShutUpAndListenKit",
    platforms: [.iOS("26.0"), .macOS("14.0")],
    products: [
        .library(name: "TurnEngine", targets: ["TurnEngine"]),
        .library(name: "TranscriptCore", targets: ["TranscriptCore"]),
        .library(name: "ClaudeClient", targets: ["ClaudeClient"]),
        .executable(name: "sul-demo", targets: ["sul-demo"]),
    ],
    targets: [
        // The pre-rewrite targets stay in Swift 5 language mode: the tools
        // bump would otherwise flip them into Swift 6 strict concurrency, and
        // the plan keeps TurnEngine/ClaudeClient source-unchanged (TurnEngine
        // especially — it is the healthiest code in the build and out of
        // scope). TranscriptCore (and its tests) build in full Swift 6 mode.
        .target(name: "TurnEngine", swiftSettings: [.swiftLanguageMode(.v5)]),
        .target(name: "TranscriptCore", dependencies: ["TurnEngine"]),
        .target(name: "ClaudeClient", dependencies: ["TurnEngine"],
                swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "sul-demo", dependencies: ["TurnEngine", "ClaudeClient"],
                          swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "TurnEngineTests", dependencies: ["TurnEngine"],
                    swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "TranscriptCoreTests", dependencies: ["TranscriptCore"]),
        .testTarget(name: "ClaudeClientTests", dependencies: ["ClaudeClient"],
                    swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
