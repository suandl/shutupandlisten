// The analyst request (spec §2). Each cycle re-sends the whole transcript so
// far — a stable, growing PREFIX — marked as the cache breakpoint so Opus reads
// it back at ~0.1× input. The volatile "produce candidates now" instruction
// must sit AFTER the breakpoint so the cached prefix stays byte-identical.

import XCTest
@testable import TurnEngine

final class AnalystPromptTests: XCTestCase {
    func testCachedPrefixIsATruePrefixOfSystem() {
        let req = Analyst.buildRequest(transcript: "so the idea is a reading app")
        XCTAssertNotNil(req.cachedSystemPrefix)
        XCTAssertTrue(req.system.hasPrefix(req.cachedSystemPrefix!),
                      "the cached prefix must be a byte-for-byte prefix of system")
    }

    func testTranscriptLivesInsideTheCachedPrefix() {
        let req = Analyst.buildRequest(transcript: "MARKER_PHRASE_XYZ")
        XCTAssertTrue(req.cachedSystemPrefix!.contains("MARKER_PHRASE_XYZ"),
                      "the transcript is part of the stable, cacheable prefix")
    }

    func testVolatileInstructionIsAfterTheBreakpoint() {
        let req = Analyst.buildRequest(transcript: "anything")
        let suffix = String(req.system.dropFirst(req.cachedSystemPrefix!.count))
        XCTAssertTrue(suffix.contains(Analyst.volatileInstruction),
                      "the volatile instruction must be outside the cached prefix")
        XCTAssertFalse(req.cachedSystemPrefix!.contains(Analyst.volatileInstruction))
    }

    func testHasExactlyOneUserMessage() {
        // The Messages API requires a user turn even for a system-driven analysis.
        let req = Analyst.buildRequest(transcript: "anything")
        XCTAssertEqual(req.messages.count, 1)
        XCTAssertEqual(req.messages.first?.role, .user)
    }

    func testResultSchemaDeclaresCandidates() {
        let props = Analyst.resultSchema["properties"] as? [String: Any]
        XCTAssertNotNil(props?["candidates"], "the structured output is a candidate list")
        XCTAssertEqual(Analyst.resultSchema["type"] as? String, "object")
    }
}
