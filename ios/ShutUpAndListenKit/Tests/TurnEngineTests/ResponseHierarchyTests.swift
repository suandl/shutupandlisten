// Unit tests for the escalate-slowly gate — the five stage-1 rules, in order,
// mirroring the behaviours web/src/response-hierarchy.test.ts pins.

import XCTest
@testable import TurnEngine

final class ResponseHierarchyTests: XCTestCase {
    private func ctx(
        turn: Int = 1,
        text: String,
        prob: Double = 1,
        prior: [PriorDecision] = []
    ) -> EvalContext {
        EvalContext(
            utteranceIndex: turn,
            utteranceTextSoFar: text,
            completionProb: prob,
            priorDecisions: prior
        )
    }

    func testRule1_emptyTranscriptHoldsSilence() {
        let d = decideTier(ctx(text: "   "))
        XCTAssertEqual(d.tier, .silence)
        XCTAssertFalse(d.callModel)
    }

    func testRule2_incompleteEouHoldsSilenceRegardlessOfWords() {
        let text = "I think the core of the idea is that the whole onboarding flow should just disappear"
        let d = decideTier(ctx(text: text, prob: 0.2))
        XCTAssertEqual(d.tier, .silence)
    }

    func testRule2_nonFiniteProbabilityFailsSafeToSilence() {
        let d = decideTier(ctx(text: "a perfectly substantive sentence with plenty of words in it today", prob: .nan))
        XCTAssertEqual(d.tier, .silence)
    }

    func testRule3_trailingOffHoldsSilence() {
        for text in ["so the thing is,", "and then we could…", "which means —"] {
            XCTAssertEqual(decideTier(ctx(text: text)).tier, .silence, text)
        }
    }

    func testRule4_briefFinishedAsideAcknowledges() {
        let d = decideTier(ctx(turn: 3, text: "okay let me think."))
        XCTAssertEqual(d.tier, .acknowledge)
        XCTAssertFalse(d.callModel)
        XCTAssertEqual(d.ackText, defaultAcks[3 % defaultAcks.count])
    }

    func testRule5_substantiveOpeningTurnIsReflectionNotQuestion() {
        let text = "So the idea is a reading app that hides every progress number so you read to read"
        let d = decideTier(ctx(turn: 1, text: text, prior: []))
        XCTAssertEqual(d.tier, .reflection)
        XCTAssertTrue(d.callModel)
    }

    func testRule5_invitedQuestionBypassesCooldown() {
        let d = decideTier(ctx(turn: 1, text: "what do you think about that?"))
        XCTAssertEqual(d.tier, .question)
    }

    func testRule5_questionEarnedAfterCooldown() {
        let text = "and the second half of the idea is that the ranking would be fully per-user from day one"
        let prior = [
            PriorDecision(turn: 1, tier: .question),
            PriorDecision(turn: 2, tier: .reflection),
        ]
        let d = decideTier(ctx(turn: 3, text: text, prior: prior))
        XCTAssertEqual(d.tier, .question, "cooldown of 2 elapsed (3 - 1 >= 2)")
    }

    func testRule5_questionCooldownHoldsToReflection() {
        let text = "and the second half of the idea is that the ranking would be fully per-user from day one"
        let prior = [PriorDecision(turn: 2, tier: .question)]
        let d = decideTier(ctx(turn: 3, text: text, prior: prior))
        XCTAssertEqual(d.tier, .reflection, "3 - 2 < cooldown 2 — question not earned")
    }

    func testChatMessagesMergeAndAlternate() {
        let messages = toChatMessages([
            ConversationTurn(speaker: .listener, text: ""), // silent — dropped
            ConversationTurn(speaker: .thinker, text: "first"),
            ConversationTurn(speaker: .thinker, text: "second"),
            ConversationTurn(speaker: .listener, text: "a question?"),
            ConversationTurn(speaker: .thinker, text: "third"),
        ])
        XCTAssertEqual(messages, [
            ListenerChatMessage(role: .user, content: "first\n\nsecond"),
            ListenerChatMessage(role: .assistant, content: "a question?"),
            ListenerChatMessage(role: .user, content: "third"),
        ])
    }

    func testCompletionProbBridge() {
        XCTAssertEqual(completionProb(fromTurnEnd: .extended), 0)
        XCTAssertEqual(completionProb(fromTurnEnd: .floor), 1)
    }

    func testLinguisticEouCues() {
        XCTAssertLessThan(LinguisticEOU.completionProbability(for: "and then we could just, you know, and"), 0.5)
        XCTAssertLessThan(LinguisticEOU.completionProbability(for: "so the thing is,"), 0.5)
        XCTAssertGreaterThan(LinguisticEOU.completionProbability(for: "That's basically it."), 0.5)
        XCTAssertGreaterThan(LinguisticEOU.completionProbability(for: "It hides every number. That's the whole thing."), 0.5)
    }
}
