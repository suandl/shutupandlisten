// Multicast contract tests — every consumer gets its own stream, late
// subscribers get snapshot-then-deltas with no hole, a slow (or never-
// consuming) subscriber back-pressures nobody, and volatile revisions coalesce
// latest-wins per segment (plan R4.1/R4.2).

import XCTest
@testable import TranscriptCore
import TurnEngine

/// Pull up to `n` events from a stream, giving up after `timeout` so a store
/// bug hangs an assertion, not the suite.
func collect(
    _ n: Int,
    from stream: AsyncStream<TranscriptEvent>,
    timeout: TimeInterval = 5
) async -> [TranscriptEvent] {
    await withTaskGroup(of: [TranscriptEvent]?.self) { group in
        group.addTask {
            var out: [TranscriptEvent] = []
            for await event in stream {
                out.append(event)
                if out.count == n { break }
            }
            return out
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            return nil
        }
        let winner = await group.next()! ?? []
        group.cancelAll()
        return winner
    }
}

final class TranscriptMulticastTests: XCTestCase {
    /// The scripted session both ordering tests replay.
    private func performScript(on store: TranscriptStore) async -> (SegmentID, SegmentID) {
        let a = SegmentID()
        let b = SegmentID()
        await store.startTurn(1, atAudioTime: 0.0)
        await store.append(id: a, text: "hello", range: 0.0...0.5)
        await store.revise(id: a, text: "hello there", range: 0.0...1.0)
        await store.finalize(id: a, into: [FinalizedText(id: a, text: "Hello there.", range: 0.0...1.0)])
        await store.startTurn(2, atAudioTime: 2.0)
        await store.append(id: b, text: "next", range: 2.1...2.4)
        return (a, b)
    }

    func testTwoSubscribersReceiveEveryEventInAppendOrder() async {
        let store = TranscriptStore()
        let first = await store.updates(replayingSnapshot: false)
        let second = await store.updates(replayingSnapshot: false)
        let (a, b) = await performScript(on: store)

        let expected: [TranscriptEvent] = [
            .turnStarted(turn: 1, atAudioTime: 0.0),
            .segmentAdded(TranscriptSegment(
                id: a, speaker: .thinker, text: "hello", state: .volatile,
                audioStart: 0.0, audioEnd: 0.5, turn: 1, index: 0)),
            .segmentRevised(TranscriptSegment(
                id: a, speaker: .thinker, text: "hello there", state: .volatile,
                audioStart: 0.0, audioEnd: 1.0, turn: 1, index: 0)),
            .segmentFinalized(TranscriptSegment(
                id: a, speaker: .thinker, text: "Hello there.", state: .final,
                audioStart: 0.0, audioEnd: 1.0, turn: 1, index: 0)),
            .turnStarted(turn: 2, atAudioTime: 2.0),
            .segmentAdded(TranscriptSegment(
                id: b, speaker: .thinker, text: "next", state: .volatile,
                audioStart: 2.1, audioEnd: 2.4, turn: 2, index: 1)),
        ]
        let firstEvents = await collect(expected.count, from: first)
        let secondEvents = await collect(expected.count, from: second)
        XCTAssertEqual(firstEvents, expected)
        XCTAssertEqual(secondEvents, expected)
    }

    func testLateSubscriberGetsSnapshotThenDeltasWithNoHole() async {
        let store = TranscriptStore()
        _ = await performScript(on: store) // a finalized + b volatile already in the log

        let late = await store.updates() // replayingSnapshot defaults true
        let c = SegmentID()
        await store.append(id: c, text: "after subscribing", range: 3.0...3.5)

        let events = await collect(3, from: late)
        guard events.count == 3 else { return XCTFail("expected 3 events, got \(events)") }
        // Snapshot: the CURRENT segments as synthetic adds, in log order,
        // carrying their current state…
        guard case .segmentAdded(let s0) = events[0],
              case .segmentAdded(let s1) = events[1]
        else { return XCTFail("snapshot must arrive as segmentAdded, got \(events)") }
        XCTAssertEqual(s0.text, "Hello there.")
        XCTAssertEqual(s0.state, .final)
        XCTAssertEqual(s1.text, "next")
        XCTAssertEqual(s1.state, .volatile)
        // …then live deltas, nothing missed in between.
        guard case .segmentAdded(let s2) = events[2] else {
            return XCTFail("expected the live delta, got \(events[2])")
        }
        XCTAssertEqual(s2.id, c)
    }

    func testNeverConsumingSubscriberDoesNotBlockOthers() async {
        let store = TranscriptStore()
        _ = await store.updates(replayingSnapshot: false) // parked forever, never consumed
        let active = await store.updates(replayingSnapshot: false)

        let id = SegmentID()
        await store.append(id: id, text: "words", range: 0.0...0.5)
        await store.finalize(id: id, into: [FinalizedText(id: id, text: "Words.", range: 0.0...0.5)])

        let events = await collect(2, from: active)
        XCTAssertEqual(events.count, 2, "the active subscriber sees everything promptly")
        guard case .segmentAdded = events[0], case .segmentFinalized = events[1] else {
            return XCTFail("unexpected events \(events)")
        }
    }

    func testVolatileCoalescingKeepsOnlyNewestRevisionPerSegment() async {
        let store = TranscriptStore()
        let slow = await store.updates(replayingSnapshot: false)

        // Two interleaved volatile segments revised repeatedly while the
        // consumer sleeps: revisions must coalesce PER SEGMENT, finals and
        // adds must all survive.
        let a = SegmentID()
        let b = await store.appendListener(text: "mm", tier: .acknowledge, estimatedRange: 5.0...5.4)
        await store.append(id: a, text: "v1", range: 0.0...0.3)
        await store.revise(id: a, text: "v1 v2", range: 0.0...0.6)
        await store.revise(id: a, text: "v1 v2 v3", range: 0.0...0.9)
        await store.closeListener(id: b, actualEnd: 5.3)
        await store.revise(id: a, text: "v1 v2 v3 v4", range: 0.0...1.2)
        await store.finalize(id: a, into: [FinalizedText(id: a, text: "V1 v2 v3 v4.", range: 0.0...1.2)])

        // Expected queue: listener add, thinker add, ONE coalesced revision
        // (newest text, in the first revision's slot), listener finalized,
        // thinker finalized — and nothing else: were coalescing broken, slot 2
        // would hold the STALE first revision and the finals would sit deeper
        // in the queue.
        let events = await collect(5, from: slow, timeout: 2)
        guard events.count == 5 else { return XCTFail("expected 5 events, got \(events)") }
        guard case .segmentAdded(let e0) = events[0],
              case .segmentAdded(let e1) = events[1],
              case .segmentRevised(let e2) = events[2],
              case .segmentFinalized(let e3) = events[3],
              case .segmentFinalized(let e4) = events[4]
        else { return XCTFail("unexpected shape \(events)") }
        XCTAssertEqual(e0.id, b)
        XCTAssertEqual(e1.id, a)
        XCTAssertEqual(e2.id, a)
        XCTAssertEqual(e2.text, "v1 v2 v3 v4", "latest revision wins")
        XCTAssertEqual(e3.id, b)
        XCTAssertEqual(e4.id, a)
    }

    func testLiveSubscriberStillSeesEveryRevision() async {
        // Coalescing is a SLOW-consumer policy: a consumer that keeps up gets
        // each revision as it lands.
        let store = TranscriptStore()
        let stream = await store.updates(replayingSnapshot: false)
        let id = SegmentID()

        await store.append(id: id, text: "v1", range: 0.0...0.3)
        let first = await collect(1, from: stream)
        await store.revise(id: id, text: "v2", range: 0.0...0.6)
        let second = await collect(1, from: stream)
        await store.revise(id: id, text: "v3", range: 0.0...0.9)
        let third = await collect(1, from: stream)

        guard case .segmentAdded = first.first,
              case .segmentRevised(let r1) = second.first,
              case .segmentRevised(let r2) = third.first
        else { return XCTFail("unexpected events") }
        XCTAssertEqual(r1.text, "v2")
        XCTAssertEqual(r2.text, "v3")
    }

    func testCancelledSubscriberIsDeregistered() async throws {
        let store = TranscriptStore()
        let stream = await store.updates()
        let consumer = Task {
            for await _ in stream {} // parks on the empty store
        }
        // Let the consumer reach its park, then cancel it.
        try await Task.sleep(nanoseconds: 50_000_000)
        let before = await store.subscriberCount
        XCTAssertEqual(before, 1)
        consumer.cancel()
        _ = await consumer.value

        // Cleanup runs on a detached hop; poll briefly.
        for _ in 0..<50 {
            if await store.subscriberCount == 0 { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let after = await store.subscriberCount
        XCTAssertEqual(after, 0, "cancellation must clean up the registration")
    }
}
