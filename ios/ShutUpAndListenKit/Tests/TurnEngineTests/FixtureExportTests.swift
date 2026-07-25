// Unit tests for the eval-fixture export — the promptfoo replay contract
// (promptfoo/fixtures/README.md) as seen from the Swift side: shape, thinker-
// only filtering, optionals omitted (never null), deterministic output.
//
// The last test closes the cross-language loop: it runs the encoder's actual
// bytes through promptfoo/lib/validate-fixtures.js — the same Node validator
// `npm run validate` uses — located from the repo checkout the same way
// GoldenVectorTests finds spec/. Where node is not installed (the CI Swift
// container), that one test skips with a message instead of failing.

import XCTest
@testable import TurnEngine

final class FixtureExportTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_784_367_000) // 2026-07-18T09:30:00Z

    private var thinkerEntries: [FixtureExport.Entry] {
        [
            .init(speaker: "thinker", text: "OK so um the idea is a reading app"),
            .init(speaker: "listener", text: "mm"),
            .init(speaker: "thinker", text: "so this one just hides it hides all of it"),
        ]
    }

    private func parse(_ json: String) throws -> [String: Any] {
        let any = try JSONSerialization.jsonObject(with: Data(json.utf8))
        return try XCTUnwrap(any as? [String: Any])
    }

    // ── shape ──

    func testRequiredFieldsAndOrder() throws {
        let json = try FixtureExport.json(
            sessionID: "ABC-123", date: date,
            source: FixtureExport.iosSFSpeechRecognizerSource,
            entries: thinkerEntries
        )
        let root = try parse(json)
        XCTAssertEqual(root["schemaVersion"] as? Int, 1)

        let session = try XCTUnwrap(root["session"] as? [String: Any])
        XCTAssertEqual(session["id"] as? String, "ABC-123")
        XCTAssertEqual(session["date"] as? String, "2026-07-18T09:30:00Z")
        XCTAssertEqual(session["source"] as? String, "ios-sfspeechrecognizer")

        let utterances = try XCTUnwrap(root["utterances"] as? [[String: Any]])
        XCTAssertEqual(utterances.map { $0["text"] as? String }, [
            "OK so um the idea is a reading app",
            "so this one just hides it hides all of it",
        ])
    }

    func testListenerAndBlankThinkerLinesAreDropped() throws {
        let json = try FixtureExport.json(
            sessionID: "s", date: date, source: "hand-authored",
            entries: [
                .init(speaker: "listener", text: "what would change your mind?"),
                .init(speaker: "thinker", text: "   "), // blank partial, never spoken
                .init(speaker: "thinker", text: "the only real line"),
            ]
        )
        let utterances = try XCTUnwrap(try parse(json)["utterances"] as? [[String: Any]])
        XCTAssertEqual(utterances.count, 1)
        XCTAssertEqual(utterances[0]["text"] as? String, "the only real line")
    }

    func testTextIsExportedVerbatim() throws {
        // The disfluency is the data: no trimming, no casing, no punctuation fixes.
        let raw = "and uh,  the the thing is\u{2026} yeah "
        let json = try FixtureExport.json(
            sessionID: "s", date: date, source: "hand-authored",
            entries: [.init(speaker: "thinker", text: raw)]
        )
        let utterances = try XCTUnwrap(try parse(json)["utterances"] as? [[String: Any]])
        XCTAssertEqual(utterances[0]["text"] as? String, raw)
    }

    // ── optionals: omitted, never null, never invented ──

    func testAbsentOptionalsAreOmitted() throws {
        let json = try FixtureExport.json(
            sessionID: "s", date: date, source: "hand-authored",
            entries: thinkerEntries
        )
        let root = try parse(json)
        let session = try XCTUnwrap(root["session"] as? [String: Any])
        XCTAssertNil(root["landingIndex"], "absent landingIndex must be omitted")
        XCTAssertNil(session["knobs"], "absent knobs must be omitted")
        let utterances = try XCTUnwrap(root["utterances"] as? [[String: Any]])
        for u in utterances {
            XCTAssertNil(u["startSeconds"])
            XCTAssertNil(u["endSeconds"])
        }
        XCTAssertFalse(json.contains("null"), "omission means no key, not null")
    }

    func testTimingsAndKnobsExportedWhenPresent() throws {
        var knobs = TurnKnobs.defaults
        knobs.silenceFloorMs = 900
        knobs.useSmartTurn = false
        let json = try FixtureExport.json(
            sessionID: "s", date: date, source: "hand-authored", knobs: knobs,
            entries: [
                .init(speaker: "thinker", text: "first", startSeconds: 0.0, endSeconds: 12.3),
                .init(speaker: "thinker", text: "second", startSeconds: 15.5),
            ],
            landingIndex: 1
        )
        let root = try parse(json)
        let exported = try XCTUnwrap((root["session"] as? [String: Any])?["knobs"] as? [String: Any])
        XCTAssertEqual(exported["silenceFloorMs"] as? Double, 900)
        XCTAssertEqual(exported["incompleteExtensionMs"] as? Double, knobs.incompleteExtensionMs)
        XCTAssertEqual(exported["completionThreshold"] as? Double, knobs.completionThreshold)
        XCTAssertEqual(exported["useSmartTurn"] as? Bool, false)
        XCTAssertNil(exported["responseDurationMs"], "per-response sizing is not a session knob")

        let utterances = try XCTUnwrap(root["utterances"] as? [[String: Any]])
        XCTAssertEqual(utterances[0]["startSeconds"] as? Double, 0.0)
        XCTAssertEqual(utterances[0]["endSeconds"] as? Double, 12.3)
        XCTAssertEqual(utterances[1]["startSeconds"] as? Double, 15.5)
        XCTAssertNil(utterances[1]["endSeconds"], "half-known timing exports only what it has")
        XCTAssertEqual(root["landingIndex"] as? Int, 1)
    }

    // ── errors ──

    func testNoThinkerUtterancesThrows() {
        XCTAssertThrowsError(try FixtureExport.json(
            sessionID: "s", date: date, source: "hand-authored",
            entries: [.init(speaker: "listener", text: "mm")]
        )) { error in
            XCTAssertEqual(error as? FixtureExport.ExportError, .noThinkerUtterances)
        }
    }

    func testLandingIndexBoundsAreCheckedAgainstFilteredUtterances() {
        // Index 2 is valid against the raw 3 entries but not against the 2
        // surviving thinker lines — the schema indexes the FILTERED array.
        XCTAssertThrowsError(try FixtureExport.json(
            sessionID: "s", date: date, source: "hand-authored",
            entries: thinkerEntries, landingIndex: 2
        )) { error in
            XCTAssertEqual(error as? FixtureExport.ExportError,
                           .landingIndexOutOfRange(index: 2, utteranceCount: 2))
        }
        XCTAssertThrowsError(try FixtureExport.json(
            sessionID: "s", date: date, source: "hand-authored",
            entries: thinkerEntries, landingIndex: -1
        ))
        XCTAssertNoThrow(try FixtureExport.json(
            sessionID: "s", date: date, source: "hand-authored",
            entries: thinkerEntries, landingIndex: 1
        ))
    }

    // ── determinism & naming ──

    func testOutputIsByteStable() throws {
        let a = try FixtureExport.json(sessionID: "s", date: date,
                                       source: "hand-authored", entries: thinkerEntries)
        let b = try FixtureExport.json(sessionID: "s", date: date,
                                       source: "hand-authored", entries: thinkerEntries)
        XCTAssertEqual(a, b)
    }

    func testFileName() {
        XCTAssertEqual(
            FixtureExport.fileName(sessionID: "6E1BD253-92E0-4A4B-B7F5-000000000000"),
            "sul-fixture-6e1bd253.json"
        )
        XCTAssertEqual(FixtureExport.fileName(sessionID: "abc"), "sul-fixture-abc.json")
    }

    // ── the cross-language contract check ──

    private static var repoRoot: URL {
        // …/ios/ShutUpAndListenKit/Tests/TurnEngineTests/FixtureExportTests.swift
        // → repo root is four directories up (same walk as GoldenVectorTests).
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TurnEngineTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ShutUpAndListenKit
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
    }

    /// First `node` executable on PATH, or nil (the CI Swift container has none).
    private static func findNode() -> URL? {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        for dir in path.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent("node")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    /// Exit status of `node promptfoo/lib/validate-fixtures.js <file>`.
    private func runValidator(node: URL, file: URL) throws -> Int32 {
        let process = Process()
        process.executableURL = node
        process.arguments = [
            Self.repoRoot.appendingPathComponent("promptfoo/lib/validate-fixtures.js").path,
            file.path,
        ]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    func testNodeValidatorAcceptsExportedFixture() throws {
        guard let node = Self.findNode() else {
            throw XCTSkip("node not on PATH — the cross-language schema check "
                + "runs where node is installed (dev machines, the promptfoo CI job)")
        }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("fixture-export-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // The real encoder output, everything populated, must pass.
        let good = dir.appendingPathComponent(FixtureExport.fileName(sessionID: "test-session"))
        try FixtureExport.jsonData(
            sessionID: "test-session", date: date,
            source: FixtureExport.iosSFSpeechRecognizerSource,
            knobs: .defaults,
            entries: [
                .init(speaker: "thinker", text: "so um the idea is", startSeconds: 0.0, endSeconds: 4.2),
                .init(speaker: "listener", text: "mm"),
                .init(speaker: "thinker", text: "yeah that's basically it", startSeconds: 6.0, endSeconds: 8.1),
            ],
            landingIndex: 1
        ).write(to: good)
        XCTAssertEqual(try runValidator(node: node, file: good), 0,
                       "the Node schema validator rejected the encoder's output")

        // And a broken file must fail — proving the validator's single-file
        // mode actually checks rather than vacuously passing.
        let bad = dir.appendingPathComponent("bad.json")
        try Data(#"{"schemaVersion": 1, "session": {}, "utterances": []}"#.utf8).write(to: bad)
        XCTAssertEqual(try runValidator(node: node, file: bad), 1,
                       "the validator accepted a fixture that violates the schema")
    }
}
