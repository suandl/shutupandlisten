// The live transcript must survive a recognition-task rotation without
// dropping or doubling words. `merge` is the pure overlap de-dup: it appends
// `incoming` onto `committed`, stripping the leading run of `incoming` that
// duplicates the trailing run of `committed` (the replayed audio tail). Only a
// run of at least `minOverlapWords` counts, so a one-word coincidence between
// genuinely-new speech is appended rather than swallowed.

import XCTest
@testable import TurnEngine

final class TranscriptStitcherTests: XCTestCase {
    // ── merge: the pure overlap de-dup ──

    func testMergeIntoEmptyReturnsIncoming() {
        XCTAssertEqual(TranscriptStitching.merge(committed: "", incoming: "hello there"),
                       "hello there")
    }

    func testMergeEmptyIncomingReturnsCommitted() {
        XCTAssertEqual(TranscriptStitching.merge(committed: "hello there", incoming: ""),
                       "hello there")
    }

    func testMergeNoOverlapAppendsWithSpace() {
        XCTAssertEqual(TranscriptStitching.merge(committed: "a b c", incoming: "d e f"),
                       "a b c d e f")
    }

    func testMergeStripsTwoWordOverlap() {
        XCTAssertEqual(
            TranscriptStitching.merge(committed: "I think we should", incoming: "we should ship it"),
            "I think we should ship it"
        )
    }

    func testMergePrefersLongestOverlap() {
        // "b c d" (3-word) overlap chosen over any shorter tail.
        XCTAssertEqual(TranscriptStitching.merge(committed: "a b c d", incoming: "b c d e"),
                       "a b c d e")
    }

    func testMergeIncomingFullyContainedLeavesCommittedUnchanged() {
        XCTAssertEqual(TranscriptStitching.merge(committed: "one two three", incoming: "two three"),
                       "one two three")
    }

    func testMergeOverlapIsCaseInsensitive() {
        XCTAssertEqual(TranscriptStitching.merge(committed: "So the Number", incoming: "the number is high"),
                       "So the Number is high")
    }

    func testMergeSingleWordOverlapNotSwallowed() {
        // Below minOverlapWords (2): a lone coincidental word is appended, not
        // treated as a seam — losing text is worse than a rare doubled word.
        XCTAssertEqual(TranscriptStitching.merge(committed: "alpha beta", incoming: "beta gamma"),
                       "alpha beta beta gamma")
    }

    // ── TranscriptStitcher: the live two-task lifecycle ──

    func testPartialAppearsInText() {
        var s = TranscriptStitcher()
        s.setPartial("hello world")
        XCTAssertEqual(s.text, "hello world")
    }

    func testCommitThenNewPartialAppends() {
        var s = TranscriptStitcher()
        s.commit("hello world")
        s.setPartial("how are you")
        XCTAssertEqual(s.text, "hello world how are you")
    }

    func testFinalReplacesItsOwnPartialWithoutDoubling() {
        var s = TranscriptStitcher()
        s.setPartial("hello wor")      // in-flight
        s.commit("hello world")        // the same task's final
        XCTAssertEqual(s.text, "hello world")
    }

    func testRotationReplayTailIsDeDuped() {
        var s = TranscriptStitcher()
        s.commit("I was saying that")                 // task 1 finalized
        // task 2 was fed a replayed tail, so it re-transcribes "saying that":
        s.setPartial("saying that we should go")
        XCTAssertEqual(s.text, "I was saying that we should go")
        s.commit("saying that we should go now")      // task 2 final, still overlaps
        XCTAssertEqual(s.text, "I was saying that we should go now")
    }

    func testResetClears() {
        var s = TranscriptStitcher()
        s.commit("something")
        s.reset()
        XCTAssertEqual(s.text, "")
    }
}
