// SessionCost is pure arithmetic — the per-session token tally and its dollar
// value under Opus 4.8 pricing. Metered/approximate turns on whether every
// call reported usage.

import XCTest
@testable import ClaudeClient

final class SessionCostTests: XCTestCase {
    func testEmptyCostIsZeroAndExact() {
        let cost = SessionCost()
        XCTAssertEqual(cost.dollars(pricing: .opus48), 0, accuracy: 1e-12)
        XCTAssertTrue(cost.isExact, "a session with no calls has nothing unmetered")
    }

    func testInputAndOutputPriced() {
        var cost = SessionCost()
        cost.add(Usage(inputTokens: 1_000_000, outputTokens: 1_000_000,
                       cacheCreationInputTokens: 0, cacheReadInputTokens: 0))
        // 1M input @ $5 + 1M output @ $25 = $30.
        XCTAssertEqual(cost.dollars(pricing: .opus48), 30, accuracy: 1e-9)
        XCTAssertTrue(cost.isExact)
    }

    func testCacheWriteAndReadPriced() {
        var cost = SessionCost()
        cost.add(Usage(inputTokens: 0, outputTokens: 0,
                       cacheCreationInputTokens: 1_000_000,   // $6.25
                       cacheReadInputTokens: 1_000_000))      // $0.50
        XCTAssertEqual(cost.dollars(pricing: .opus48), 6.75, accuracy: 1e-9)
    }

    func testUsageAccumulatesAcrossCalls() {
        var cost = SessionCost()
        cost.add(Usage(inputTokens: 500_000, outputTokens: 0,
                       cacheCreationInputTokens: 0, cacheReadInputTokens: 0))
        cost.add(Usage(inputTokens: 500_000, outputTokens: 0,
                       cacheCreationInputTokens: 0, cacheReadInputTokens: 0))
        XCTAssertEqual(cost.inputTokens, 1_000_000)
        XCTAssertEqual(cost.dollars(pricing: .opus48), 5, accuracy: 1e-9)
    }

    func testNilUsageMarksApproximate() {
        var cost = SessionCost()
        cost.add(Usage(inputTokens: 1_000, outputTokens: 1_000,
                       cacheCreationInputTokens: 0, cacheReadInputTokens: 0))
        cost.add(nil) // e.g. the proxy path, which does not surface usage yet
        XCTAssertFalse(cost.isExact, "an unmetered call makes the tally approximate")
        // The metered call still counts toward the figure.
        XCTAssertEqual(cost.inputTokens, 1_000)
    }
}
