// swift-tools-version: 5.9
// ShutUpAndListenKit — the platform-agnostic core of the iOS quiet companion.
//
// TurnEngine is a pure Swift port of spec/turn-state-machine.md and the
// response-hierarchy gate (web/src/turn-detection.ts / response-hierarchy.ts).
// It contains no audio code and no UI, which is what lets the golden vectors
// (spec/turn-vectors/) test it headlessly — including on Linux CI.
//
// ClaudeClient is the raw-HTTP Messages API adapter the listener tiers use.
import PackageDescription

let package = Package(
    name: "ShutUpAndListenKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "TurnEngine", targets: ["TurnEngine"]),
        .library(name: "ClaudeClient", targets: ["ClaudeClient"]),
        .executable(name: "sul-demo", targets: ["sul-demo"]),
    ],
    targets: [
        .target(name: "TurnEngine"),
        .target(name: "ClaudeClient", dependencies: ["TurnEngine"]),
        .executableTarget(name: "sul-demo", dependencies: ["TurnEngine", "ClaudeClient"]),
        .testTarget(name: "TurnEngineTests", dependencies: ["TurnEngine"]),
        .testTarget(name: "ClaudeClientTests", dependencies: ["ClaudeClient"]),
    ]
)
