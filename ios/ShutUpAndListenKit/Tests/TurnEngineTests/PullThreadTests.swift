// The explicit "pull a thread" path must always ASK — no inherited restraint,
// no deferral. It uses a forcing instruction, not the gate's optional-silence
// question instruction.

import XCTest
@testable import TurnEngine

final class PullThreadTests: XCTestCase {
    func testRequestUsesForcingInstructionNotTheOptionalSilenceOne() {
        let req = buildPullThreadRequest(
            systemPrompt: "BASE PROMPT",
            currentTurnText: "here is a fragment",
            history: []
        )
        XCTAssertTrue(req.system.contains(pullThreadInstruction))
        // Must NOT carry the gate's question instruction, which invites silence.
        XCTAssertFalse(
            req.system.contains("stay silent if nothing specific is worth pulling on"),
            "the invited path must not inherit the restraint clause"
        )
        XCTAssertEqual(req.tier, .question)
    }

    func testForcingInstructionForbidsDeferral() {
        // The instruction itself must direct the model away from "take your time".
        XCTAssertTrue(pullThreadInstruction.contains("never tell them to take their time"))
        XCTAssertTrue(pullThreadInstruction.lowercased().contains("one specific question")
            || pullThreadInstruction.lowercased().contains("one question"))
    }

    func testCurrentTurnIsTheFinalUserMessage() {
        let req = buildPullThreadRequest(
            systemPrompt: "BASE",
            currentTurnText: "the thing I just said",
            history: [
                ConversationTurn(speaker: .thinker, text: "earlier"),
                ConversationTurn(speaker: .listener, text: "a question?"),
            ]
        )
        XCTAssertEqual(req.messages.last?.role, .user)
        XCTAssertEqual(req.messages.last?.content, "the thing I just said")
    }

    func testCurrentTurnMergesIntoTrailingThinkerTurn() {
        // The common runtime case (especially once acks are silent by default):
        // several thinker turns with no listener turn between. The current turn
        // must merge into the trailing thinker turn as ONE user message, so the
        // Messages API's role alternation holds.
        let req = buildPullThreadRequest(
            systemPrompt: "BASE",
            currentTurnText: "and also this",
            history: [ConversationTurn(speaker: .thinker, text: "earlier point")]
        )
        XCTAssertEqual(req.messages.count, 1)
        XCTAssertEqual(req.messages.last?.role, .user)
        XCTAssertEqual(req.messages.last?.content, "earlier point\n\nand also this")
    }
}
