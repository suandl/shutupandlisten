// Wave 1b tests: session-mode prompt composition and the just-listen gate cap.
//
// The composition contract: `.open` with just-listen off is byte-identical to
// today's prompt; a tinted mode APPENDS to the base prompt (never rewrites or
// duplicates it). The just-listen contract is deterministic and lives in the
// gate: uninvited turns can never reach the model tiers, while both invited
// routes (a direct "?" from the thinker; the pull-a-thread path that bypasses
// the gate) still produce a question.

import XCTest
@testable import TurnEngine

final class SessionModeTests: XCTestCase {
    private func occurrences(of needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    func testOpenModeIsByteIdenticalToBasePrompt() {
        XCTAssertEqual(ListenerPrompt.systemPrompt(mode: .open), ListenerPrompt.systemPrompt)
        XCTAssertEqual(
            ListenerPrompt.systemPrompt(mode: .open, justListen: false),
            ListenerPrompt.systemPrompt
        )
    }

    func testOpenModeHasNoTint() {
        XCTAssertNil(SessionMode.open.promptTint)
    }

    func testTintedModesAppendWithoutDuplicatingBase() {
        let baseMarker = "Role: You are an idea-dictation partner"
        for mode in [SessionMode.rehearsal, .debrief] {
            guard let tint = mode.promptTint else {
                return XCTFail("\(mode) must carry a tint")
            }
            let prompt = ListenerPrompt.systemPrompt(mode: mode)
            XCTAssertTrue(prompt.hasPrefix(ListenerPrompt.systemPrompt),
                          "\(mode): base prompt must lead, unmodified")
            XCTAssertTrue(prompt.hasSuffix(tint), "\(mode): tint must be appended")
            XCTAssertEqual(occurrences(of: baseMarker, in: prompt), 1,
                           "\(mode): base prompt must appear exactly once")
        }
    }

    func testJustListenTintAppendsAfterModeTint() {
        // Open + just-listen: base, blank line, the one-line tint.
        XCTAssertEqual(
            ListenerPrompt.systemPrompt(mode: .open, justListen: true),
            ListenerPrompt.systemPrompt + "\n\n" + ListenerPrompt.justListenTint
        )
        // A tinted mode + just-listen: base, mode tint, then the just-listen line.
        let prompt = ListenerPrompt.systemPrompt(mode: .rehearsal, justListen: true)
        XCTAssertEqual(
            prompt,
            ListenerPrompt.systemPrompt + "\n\n" + SessionMode.rehearsal.promptTint!
                + "\n\n" + ListenerPrompt.justListenTint
        )
    }

    func testModePickerMetadataIsFullyFormed() {
        XCTAssertEqual(SessionMode.allCases.first, .open, "open is the default")
        for mode in SessionMode.allCases {
            XCTAssertFalse(mode.displayName.isEmpty)
            XCTAssertFalse(mode.blurb.isEmpty)
        }
    }
}

final class JustListenGateTests: XCTestCase {
    private let justListen = GateConfig(justListen: true)

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

    func testLowerRungsAreUntouched() {
        // Rules 1–4 behave exactly as without the cap.
        XCTAssertEqual(decideTier(ctx(text: "   "), config: justListen).tier, .silence)
        XCTAssertEqual(
            decideTier(ctx(text: "I think the core of the idea is that the whole onboarding flow should just disappear",
                           prob: 0.2), config: justListen).tier,
            .silence
        )
        XCTAssertEqual(decideTier(ctx(text: "so the thing is,"), config: justListen).tier, .silence)
        let aside = decideTier(ctx(turn: 3, text: "okay let me think."), config: justListen)
        XCTAssertEqual(aside.tier, .acknowledge)
        XCTAssertEqual(aside.ackText, defaultAcks[3 % defaultAcks.count])
    }

    func testSubstantiveOpenerCapsToAcknowledge() {
        // Without the cap this exact context is pinned as .reflection.
        let text = "So the idea is a reading app that hides every progress number so you read to read"
        let d = decideTier(ctx(turn: 1, text: text), config: justListen)
        XCTAssertEqual(d.tier, .acknowledge)
        XCTAssertFalse(d.callModel)
        XCTAssertNotNil(d.ackText)
    }

    func testEarnedQuestionTurnCapsToAcknowledge() {
        // Without the cap this exact context is pinned as .question (cooldown elapsed).
        let text = "and the second half of the idea is that the ranking would be fully per-user from day one"
        let prior = [
            PriorDecision(turn: 1, tier: .question),
            PriorDecision(turn: 2, tier: .reflection),
        ]
        let d = decideTier(ctx(turn: 3, text: text, prior: prior), config: justListen)
        XCTAssertEqual(d.tier, .acknowledge)
        XCTAssertFalse(d.callModel)
    }

    func testEmptyAckSetDegradesToSilence() {
        let text = "So the idea is a reading app that hides every progress number so you read to read"
        let d = decideTier(ctx(text: text), config: GateConfig(acks: [], justListen: true))
        XCTAssertEqual(d.tier, .silence)
        XCTAssertNil(d.ackText)
    }

    func testUninvitedTurnsNeverReachModelTiersAcrossTheLadder() {
        // Sweep finished, uninvited turns across sizes and histories: the gate
        // must never call the model under just-listen.
        let texts = [
            "okay.",
            "okay let me think.",
            "So the idea is a reading app that hides every progress number so you read to read",
            "and the second half of the idea is that the ranking would be fully per-user from day one so that's basically it",
        ]
        let histories: [[PriorDecision]] = [
            [],
            [PriorDecision(turn: 1, tier: .reflection)],
            [PriorDecision(turn: 1, tier: .question), PriorDecision(turn: 2, tier: .reflection)],
            [PriorDecision(turn: 1, tier: .question), PriorDecision(turn: 5, tier: .acknowledge)],
        ]
        for text in texts {
            for prior in histories {
                for turn in [1, 3, 9] {
                    let d = decideTier(ctx(turn: turn, text: text, prior: prior), config: justListen)
                    XCTAssertFalse(d.callModel, "\(text) @\(turn): must not call the model")
                    XCTAssertLessThanOrEqual(d.tier.rank, Tier.acknowledge.rank,
                                             "\(text) @\(turn): capped at acknowledge")
                }
            }
        }
    }

    func testInvitedQuestionBypassesTheCap() {
        // The thinker asked directly — answered in kind even under just-listen.
        let d = decideTier(ctx(turn: 1, text: "what do you think about that?"), config: justListen)
        XCTAssertEqual(d.tier, .question)
        XCTAssertTrue(d.callModel)
    }

    func testPullAThreadPathStillBuildsAQuestionRequest() {
        // "Pull a thread now" bypasses the gate entirely and builds a .question
        // request directly — under just-listen the request must still carry the
        // one-question tier instruction, with the just-listen line present so
        // the model knows the question was invited, not volunteered.
        let request = buildListenerRequest(
            systemPrompt: ListenerPrompt.systemPrompt(mode: .open, justListen: true),
            tier: .question,
            currentTurnText: "so that's the gist of it"
        )
        XCTAssertEqual(request.tier, .question)
        XCTAssertTrue(request.system.contains(ListenerPrompt.justListenTint))
        XCTAssertTrue(request.system.contains(tierInstruction(.question).trimmingCharacters(in: .whitespacesAndNewlines)))
    }
}
