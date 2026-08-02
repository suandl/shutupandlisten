// The candidate pool (spec §2). A ranked, best-first set of ready-to-speak
// interjections. Freshness is anchored to a transcript position: a candidate
// expires once the thinker has clearly moved past what it was built on. The
// pool is NEVER a correctness dependency — empty pool ⇒ nil, caller falls back.

import XCTest
@testable import TurnEngine

final class CandidatePoolTests: XCTestCase {
    private func c(_ text: String, _ register: Tier, anchor: Int) -> Candidate {
        Candidate(text: text, register: register, anchorPosition: anchor)
    }

    func testEmptyPoolSelectsNil() {
        let pool = CandidatePool()
        XCTAssertTrue(pool.isEmpty)
        XCTAssertNil(pool.best())
        XCTAssertNil(pool.bestQuestion())
    }

    func testReplaceCapsToMaxCount() {
        var pool = CandidatePool(maxCount: 2)
        pool.replace(with: [
            c("one", .reflection, anchor: 0),
            c("two", .question, anchor: 0),
            c("three", .reflection, anchor: 0),
        ])
        XCTAssertEqual(pool.candidates.count, 2)
        XCTAssertEqual(pool.candidates.map(\.text), ["one", "two"])
    }

    func testBestReturnsFirstOverall() {
        var pool = CandidatePool()
        pool.replace(with: [c("top", .reflection, anchor: 0), c("next", .question, anchor: 0)])
        XCTAssertEqual(pool.best()?.text, "top")
    }

    func testBestOfRegisterReturnsFirstMatching() {
        var pool = CandidatePool()
        pool.replace(with: [c("a reflection", .reflection, anchor: 0), c("a question?", .question, anchor: 0)])
        XCTAssertEqual(pool.best(register: .question)?.text, "a question?")
        XCTAssertEqual(pool.best(register: .reflection)?.text, "a reflection")
    }

    func testBestQuestionSkipsReflections() {
        var pool = CandidatePool()
        pool.replace(with: [
            c("r1", .reflection, anchor: 0),
            c("r2", .reflection, anchor: 0),
            c("the question?", .question, anchor: 0),
        ])
        XCTAssertEqual(pool.bestQuestion()?.text, "the question?")
    }

    /// The transcript-core port's analyst-basis defect, one layer up from
    /// `TranscriptStore.finalizedText` (port plan §4.2).
    ///
    /// Expiry is `currentPosition - anchorPosition > maxDrift`, which is only
    /// meaningful while `currentPosition` never decreases. The host used to
    /// feed it `fullText.count`, and `fullText` includes VOLATILE segments that
    /// SpeechAnalyzer revises in place — a revision can be shorter. Drift then
    /// goes negative and NOTHING ever expires, precisely while the transcript
    /// is churning. Fed from `finalizedText` (monotonic by construction, since
    /// finalization is one-way), the same pool keeps expiring correctly.
    ///
    /// `CandidatePool` itself is unchanged by the port; this pins the contract
    /// the host must honor when choosing which projection to hand it.
    func testCandidatesExpireWhileVolatileChurns() {
        var pool = CandidatePool(maxDrift: 600)
        pool.replace(with: [c("what changed?", .question, anchor: 100)])

        // The wrong basis: a shortening volatile revision drags the reported
        // position BACKWARDS past the anchor.
        let volatileHigh = 900   // fullText.count with a long open volatile
        let volatileLow = 120    // …after the engine revises it shorter
        XCTAssertGreaterThan(volatileHigh - 100, 600,
                             "fixture check: the long reading is past maxDrift")
        XCTAssertLessThan(volatileLow - 100, 600,
                          "fixture check: the short reading is not — the basis really does move both ways")

        var churning = pool
        churning.expire(currentPosition: volatileLow)
        XCTAssertFalse(churning.isEmpty,
                       "a non-monotonic basis lets a stale candidate survive indefinitely")

        // The finalized basis only ever grows, so the same candidate expires
        // once the thinker has genuinely moved on.
        var settled = pool
        settled.expire(currentPosition: 400)
        XCTAssertFalse(settled.isEmpty, "still within the drift window")
        settled.expire(currentPosition: 800)
        XCTAssertTrue(settled.isEmpty,
                      "past maxDrift on a monotonic basis — the candidate retires")

        // And monotonicity is what makes that irreversible: a later, larger
        // position can never resurrect what an earlier one dropped.
        settled.expire(currentPosition: 900)
        XCTAssertTrue(settled.isEmpty)
    }

    func testExpireDropsCandidatesPastMaxDrift() {
        var pool = CandidatePool(maxDrift: 100)
        pool.replace(with: [c("stale", .question, anchor: 0), c("fresh", .question, anchor: 500)])
        pool.expire(currentPosition: 550) // stale drifted 550 > 100; fresh drifted 50
        XCTAssertEqual(pool.candidates.map(\.text), ["fresh"])
    }

    func testExpireKeepsCandidateAtExactBoundary() {
        var pool = CandidatePool(maxDrift: 100)
        pool.replace(with: [c("edge", .question, anchor: 0)])
        pool.expire(currentPosition: 100) // drift == maxDrift ⇒ still fresh
        XCTAssertEqual(pool.candidates.map(\.text), ["edge"])
    }

    func testRemoveDropsOnlyTheSpokenCandidate() {
        var pool = CandidatePool()
        let spoken = c("said it", .reflection, anchor: 0)
        pool.replace(with: [spoken, c("still fresh", .reflection, anchor: 0), c("q?", .question, anchor: 0)])
        pool.remove(spoken)
        XCTAssertEqual(pool.candidates.map(\.text), ["still fresh", "q?"])
    }

    func testRemoveOfAbsentCandidateLeavesPoolUnchanged() {
        var pool = CandidatePool()
        pool.replace(with: [c("one", .reflection, anchor: 0)])
        pool.remove(c("never in the pool", .reflection, anchor: 0))
        XCTAssertEqual(pool.candidates.map(\.text), ["one"])
    }

    func testReplaceDiscardsPreviousSet() {
        var pool = CandidatePool()
        pool.replace(with: [c("old", .question, anchor: 0)])
        pool.replace(with: [c("new", .reflection, anchor: 0)])
        XCTAssertEqual(pool.candidates.map(\.text), ["new"])
    }
}
