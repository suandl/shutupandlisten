// The gate's acknowledge rung is rules-only. When the user has acknowledgments
// off we speak nothing — but the decision still COUNTS as an acknowledge for
// question spacing. Recording it as silence (the old App behavior) distorted
// the cooldown. resolveAcknowledge is the pure mapping the host uses.

import XCTest
@testable import TurnEngine

final class AcknowledgeResolutionTests: XCTestCase {
    private func ackDecision(_ text: String? = "mm") -> GateDecision {
        GateDecision(tier: .acknowledge, callModel: false, ackText: text, reason: "test")
    }

    func testSpeaksAckWhenEnabled() {
        let r = resolveAcknowledge(ackDecision("mm"), speakAcknowledgments: true)
        XCTAssertEqual(r.recordedTier, .acknowledge)
        XCTAssertEqual(r.spokenText, "mm")
    }

    func testStaysSilentButStillRecordsAcknowledgeWhenDisabled() {
        let r = resolveAcknowledge(ackDecision("mm"), speakAcknowledgments: false)
        XCTAssertEqual(r.recordedTier, .acknowledge, "spacing bookkeeping must still see an acknowledge")
        XCTAssertNil(r.spokenText, "acks off ⇒ nothing spoken")
    }

    func testNoAckTextStaysSilentEvenWhenEnabled() {
        let r = resolveAcknowledge(ackDecision(nil), speakAcknowledgments: true)
        XCTAssertEqual(r.recordedTier, .acknowledge)
        XCTAssertNil(r.spokenText)
    }

    func testEmptyAckTextStaysSilentEvenWhenEnabled() {
        let r = resolveAcknowledge(ackDecision(""), speakAcknowledgments: true)
        XCTAssertEqual(r.recordedTier, .acknowledge)
        XCTAssertNil(r.spokenText, "an empty ack string is not something to speak")
    }
}
