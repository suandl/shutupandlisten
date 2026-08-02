// The analyst has no pause of its own to fire on (spec §2): it recomputes after
// a finished substantive turn (marked by `pendingSince`), rate-limited so two
// cycles are never closer than the minimum interval. Pure reducer.

import XCTest
@testable import TurnEngine

final class AnalystCadenceTests: XCTestCase {
    func testNothingPendingDoesNotRun() {
        XCTAssertFalse(AnalystCadence.shouldRecompute(
            nowMs: 100_000, lastRunMs: 0, pendingSince: nil
        ))
    }

    func testPendingAndNeverRunRunsImmediately() {
        XCTAssertTrue(AnalystCadence.shouldRecompute(
            nowMs: 1_000, lastRunMs: nil, pendingSince: 500
        ))
    }

    func testPendingWithinIntervalWaits() {
        XCTAssertFalse(AnalystCadence.shouldRecompute(
            nowMs: 10_000, lastRunMs: 0, pendingSince: 5_000, minIntervalMs: 25_000
        ))
    }

    func testPendingAfterIntervalRuns() {
        XCTAssertTrue(AnalystCadence.shouldRecompute(
            nowMs: 30_000, lastRunMs: 0, pendingSince: 5_000, minIntervalMs: 25_000
        ))
    }
}
