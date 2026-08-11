// The analyst request (spec §2). Each cycle re-sends the whole transcript, but
// as an APPEND-ONLY sequence of system blocks split at fixed 4000-character
// boundaries, with the cache breakpoint on the last FULL chunk. A cache hit
// needs the block sequence to be byte-identical up to the breakpoint, and the
// cadence only fires after new transcript arrives — so the frozen chunks are
// what earns the read, and the still-growing tail plus the volatile "produce
// candidates now" instruction must sit after the breakpoint.

import XCTest
@testable import TurnEngine

final class AnalystPromptTests: XCTestCase {
    /// Deterministic filler with varied content, so "these blocks are equal"
    /// means the boundaries lined up — not that every character was the same.
    /// `from` continues the pattern, so `transcript(9000) + transcript(3000,
    /// from: 9000) == transcript(12000)`.
    private func transcript(_ n: Int, from offset: Int = 0) -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789 ")
        return String((0..<n).map { alphabet[($0 + offset) % alphabet.count] })
    }

    private func breakpointIndex(_ req: AnalystRequest) -> Int? {
        req.systemBlocks.firstIndex { $0.cached }
    }

    // ── block shape ──

    func testShortTranscriptIsInstructionsPlusVolatileTail() {
        let req = Analyst.buildRequest(transcript: "so the idea is a reading app")

        XCTAssertEqual(req.systemBlocks.count, 2,
                       "under one chunk there is nothing frozen yet: instructions + tail")
        XCTAssertEqual(req.systemBlocks[0].text, Analyst.transcriptHeader)
        XCTAssertTrue(req.systemBlocks[0].cached,
                      "with no full chunk the breakpoint falls on the instructions block")
        XCTAssertTrue(req.systemBlocks[1].text.contains("so the idea is a reading app"))
        XCTAssertFalse(req.systemBlocks[1].cached, "the growing tail is never cached")
    }

    func testTranscriptLivesInTheSystemBlocks() {
        let req = Analyst.buildRequest(transcript: "MARKER_PHRASE_XYZ")
        let all = req.systemBlocks.map(\.text).joined()
        XCTAssertTrue(all.contains("MARKER_PHRASE_XYZ"))
    }

    func testBreakpointSitsOnTheLastFullChunk() {
        // 9000 chars ⇒ two full 4000-char chunks + a 1000-char remainder.
        let req = Analyst.buildRequest(transcript: transcript(9000))

        XCTAssertEqual(req.systemBlocks.count, 4, "instructions + 2 chunks + tail")
        XCTAssertEqual(req.systemBlocks[1].text.count, Analyst.transcriptChunkSize)
        XCTAssertEqual(req.systemBlocks[2].text.count, Analyst.transcriptChunkSize)
        XCTAssertEqual(breakpointIndex(req), 2, "the breakpoint ends the last FROZEN chunk")
    }

    func testExactlyOneBlockCarriesTheBreakpoint() {
        for length in [0, 100, 4000, 9000, 20_000] {
            let req = Analyst.buildRequest(transcript: transcript(length))
            XCTAssertEqual(req.systemBlocks.filter(\.cached).count, 1,
                           "exactly one breakpoint at transcript length \(length)")
        }
    }

    func testVolatileInstructionIsAfterTheBreakpoint() {
        let req = Analyst.buildRequest(transcript: transcript(9000))
        let cut = breakpointIndex(req)!

        XCTAssertTrue(req.systemBlocks.last!.text.contains(Analyst.volatileInstruction))
        for block in req.systemBlocks[...cut] {
            XCTAssertFalse(block.text.contains(Analyst.volatileInstruction),
                           "nothing up to the breakpoint may carry the volatile instruction")
        }
    }

    // ── the property the caching depends on ──

    func testSameTranscriptProducesTheSameBlocks() {
        let a = Analyst.buildRequest(transcript: transcript(9000))
        let b = Analyst.buildRequest(transcript: transcript(9000))
        XCTAssertEqual(a.systemBlocks, b.systemBlocks)
    }

    func testGrowingTranscriptLeavesEarlierChunksByteIdentical() {
        let shorter = transcript(9000)                        // 2 full chunks + 1000 left over
        let longer = shorter + transcript(3000, from: 9000)   // 3 full chunks, nothing left over

        let a = Analyst.buildRequest(transcript: shorter)
        let b = Analyst.buildRequest(transcript: longer)

        // Instructions + both already-frozen chunks are unchanged — that prefix
        // is what the next cycle reads back from cache instead of re-writing.
        // TEXT only, deliberately: `cached` is the breakpoint MARKER, and it is
        // supposed to advance onto the newly-frozen chunk — which is what the
        // two breakpointIndex assertions below pin. SystemBlock is Equatable
        // over (text, cached), so comparing whole blocks here would demand the
        // marker stay put and contradict them.
        XCTAssertEqual(a.systemBlocks[0...2].map(\.text),
                       b.systemBlocks[0...2].map(\.text))

        // Only the newly-completed chunk is added, and the breakpoint moves onto it.
        XCTAssertEqual(a.systemBlocks.count, 4)
        XCTAssertEqual(b.systemBlocks.count, 5)
        XCTAssertEqual(breakpointIndex(a), 2)
        XCTAssertEqual(breakpointIndex(b), 3)
    }

    func testRevisedTailDoesNotDisturbTheFrozenChunks() {
        // Live partials rewrite only the very end of the transcript.
        let frozen = transcript(8000)
        let a = Analyst.buildRequest(transcript: frozen + "half a sentenc")
        let b = Analyst.buildRequest(transcript: frozen + "half a sentence, revised")

        XCTAssertEqual(Array(a.systemBlocks[0...2]), Array(b.systemBlocks[0...2]))
        XCTAssertNotEqual(a.systemBlocks.last, b.systemBlocks.last)
    }

    // ── unchanged contract ──

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
