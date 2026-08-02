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

    // ── commitPartial: surviving a task that never says goodbye ──

    func testCommitPartialLeavesTheVisibleTextUnchanged() {
        var s = TranscriptStitcher()
        s.commit("I was saying that")
        s.setPartial("saying that we should go")
        let before = s.text
        s.commitPartial()
        XCTAssertEqual(s.text, before)
        XCTAssertEqual(s.text, "I was saying that we should go")
    }

    func testCommittedPartialSurvivesTheReplacementTasksFirstPartial() {
        // The rotation this exists for: the outgoing task is torn down without
        // a final, so its partial is locked in first. The replacement's first
        // partial only re-covers the ~1.5 s replayed tail — without the lock-in
        // it would replace the whole minute with that tail.
        var s = TranscriptStitcher()
        s.setPartial("a long stretch of speech we should keep")
        s.commitPartial()
        s.setPartial("we should keep going")
        XCTAssertEqual(s.text, "a long stretch of speech we should keep going")
    }

    func testCommitPartialWithNothingInFlightIsANoOp() {
        // Callers fire it on every teardown path, including after a final has
        // already emptied the partial.
        var s = TranscriptStitcher()
        s.commit("settled text")
        s.commitPartial()
        s.commitPartial()
        XCTAssertEqual(s.text, "settled text")
    }

    func testFullTaskFinalAfterItsPartialWasCommittedWouldDouble() {
        // Why SpeechTranscriber drops a SUPERSEDED task's late final rather
        // than folding it in. Once that task's partial is committed, its final
        // arrives as the task's whole transcript — and a single revised opening
        // word (here the final's added comma) breaks the overlap match, so
        // merge appends the minute a second time.
        var s = TranscriptStitcher()
        s.setPartial("we talked about the budget")
        s.commitPartial()
        s.commit("We talked, about the budget again")
        XCTAssertEqual(s.text, "we talked about the budget We talked, about the budget again")
    }

    func testResetClears() {
        var s = TranscriptStitcher()
        s.commit("something")
        s.reset()
        XCTAssertEqual(s.text, "")
    }
}
