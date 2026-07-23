// Golden-vector parity tests — the cross-runtime contract.
//
// Replays every vector in spec/turn-vectors/scenarios/ through the Swift
// TurnDetector and asserts the emitted output matches exactly (spec §8: the
// machine is fully deterministic in (knobs, event stream)). Per the spec's
// two-runtimes note, this is what "reuse U3 logic" means: the Swift build must
// reproduce the same emitted events from the same inputs, or it has diverged
// from spec/turn-state-machine.md.
//
// The vectors are read from the repo checkout via #filePath, so there is a
// single source of truth (no copied fixtures to drift). Running the tests
// therefore requires the full repo checkout, which is how this package ships.

import XCTest
@testable import TurnEngine

// ── vector schema ──

private struct Vector: Decodable {
    struct Knobs: Decodable {
        var silenceFloorMs: Double?
        var incompleteExtensionMs: Double?
        var completionThreshold: Double?
        var responseDurationMs: Double?
        var useSmartTurn: Bool?
    }

    struct Event: Decodable {
        let t: Double
        let type: String
        let verdict: String?
        let completionProb: Double?
        let outcome: String?
    }

    struct Expected: Decodable {
        let turnEnds: [TurnEnd]
        let turnStartCount: Int?
        let turnEndCount: Int?
        let emit: [EmittedEvent]?
    }

    struct TurnEnd: Decodable {
        let t: Double
        let turn: Int
        let reason: String
    }

    let name: String
    let knobs: Knobs?
    let events: [Event]
    let expected: Expected
}

/// A normalized emitted event, comparable field-for-field with the JSON `emit`
/// entries (absent fields nil on both sides).
private struct EmittedEvent: Decodable, Equatable, CustomStringConvertible {
    let t: Double
    let type: String
    let turn: Int
    let evaluation: Int?
    let reason: String?
    let trigger: String?

    init(t: Double, type: String, turn: Int, evaluation: Int? = nil,
         reason: String? = nil, trigger: String? = nil) {
        self.t = t
        self.type = type
        self.turn = turn
        self.evaluation = evaluation
        self.reason = reason
        self.trigger = trigger
    }

    init(_ e: OutputEvent) {
        switch e {
        case .turnStart(let t, let turn):
            self.init(t: t, type: "turn-start", turn: turn)
        case .evaluate(let t, let turn, let evaluation, let reason, let trigger):
            self.init(t: t, type: "evaluate", turn: turn, evaluation: evaluation,
                      reason: reason.rawValue, trigger: trigger.rawValue)
        case .turnEnd(let t, let turn, let evaluation, let reason):
            self.init(t: t, type: "turn-end", turn: turn, evaluation: evaluation,
                      reason: reason.rawValue)
        case .responseStart(let t, let turn):
            self.init(t: t, type: "response-start", turn: turn)
        case .responseEnd(let t, let turn, let reason):
            self.init(t: t, type: "response-end", turn: turn, reason: reason.rawValue)
        case .bargeIn(let t, let turn):
            self.init(t: t, type: "barge-in", turn: turn)
        }
    }

    var description: String {
        var s = "{t:\(t) \(type) turn:\(turn)"
        if let evaluation { s += " eval:\(evaluation)" }
        if let reason { s += " reason:\(reason)" }
        if let trigger { s += " trigger:\(trigger)" }
        return s + "}"
    }
}

final class GoldenVectorTests: XCTestCase {
    private static var scenariosDir: URL {
        // …/ios/ShutUpAndListenKit/Tests/TurnEngineTests/GoldenVectorTests.swift
        // → repo root is four directories up.
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TurnEngineTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ShutUpAndListenKit
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("spec/turn-vectors/scenarios")
    }

    func testAllScenarioVectors() throws {
        let files = try FileManager.default
            .contentsOfDirectory(at: Self.scenariosDir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        XCTAssertFalse(files.isEmpty, "no golden vectors found at \(Self.scenariosDir.path)")

        for file in files {
            let vector = try JSONDecoder().decode(Vector.self, from: Data(contentsOf: file))
            try run(vector)
        }
    }

    private func run(_ vector: Vector) throws {
        var knobs = TurnKnobs.defaults
        if let k = vector.knobs {
            if let v = k.silenceFloorMs { knobs.silenceFloorMs = v }
            if let v = k.incompleteExtensionMs { knobs.incompleteExtensionMs = v }
            if let v = k.completionThreshold { knobs.completionThreshold = v }
            if let v = k.responseDurationMs { knobs.responseDurationMs = v }
            if let v = k.useSmartTurn { knobs.useSmartTurn = v }
        }

        let detector = TurnDetector(knobs: knobs)
        var emitted: [EmittedEvent] = []
        for e in vector.events {
            let input: InputEvent
            switch e.type {
            case "speech-start": input = .speechStart(t: e.t)
            case "speech-end": input = .speechEnd(t: e.t)
            case "eou":
                input = .eou(t: e.t, verdict: e.verdict.flatMap(Verdict.init(rawValue:)),
                             completionProb: e.completionProb)
            case "decision":
                guard let outcome = e.outcome.flatMap(DecisionOutcome.init(rawValue:)) else {
                    XCTFail("\(vector.name): decision event without a valid outcome")
                    return
                }
                input = .decision(t: e.t, outcome: outcome)
            case "tick": input = .tick(t: e.t)
            default:
                XCTFail("\(vector.name): unknown event type \(e.type)")
                return
            }
            emitted.append(contentsOf: detector.input(input).map(EmittedEvent.init))
        }

        // turn-ends must match exactly: time, turn id, reason.
        let turnEnds = emitted.filter { $0.type == "turn-end" }
        XCTAssertEqual(turnEnds.count, vector.expected.turnEnds.count,
                       "\(vector.name): turn-end count")
        for (got, want) in zip(turnEnds, vector.expected.turnEnds) {
            XCTAssertEqual(got.t, want.t, "\(vector.name): turn-end time")
            XCTAssertEqual(got.turn, want.turn, "\(vector.name): turn-end turn id")
            XCTAssertEqual(got.reason, want.reason, "\(vector.name): turn-end reason")
        }

        if let want = vector.expected.turnStartCount {
            XCTAssertEqual(emitted.filter { $0.type == "turn-start" }.count, want,
                           "\(vector.name): turn-start count")
        }
        if let want = vector.expected.turnEndCount {
            XCTAssertEqual(turnEnds.count, want, "\(vector.name): turnEndCount")
        }
        if let want = vector.expected.emit {
            XCTAssertEqual(emitted, want, "\(vector.name): full ordered emit stream")
        }
    }
}
