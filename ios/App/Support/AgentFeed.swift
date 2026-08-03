// The agent seam (plan R4.2): the public in-process subscription point over
// the running session's transcript. Any feature — coverage, a future
// companion, a debug console — attaches HERE rather than reaching into
// SessionController's internals: SessionController publishes a session-scoped
// AgentFeed at session start (nil between sessions), and every consumer gets
// its own multicast stream with snapshot-then-deltas, no polling, no
// back-pressure on the UI or the evidence feed (all inherited from the
// TranscriptStore's multicast contract — this type is deliberately a thin,
// discoverable API over `store.updates()`, not a second event system).
//
// FIRST CONSUMER: coverage mode. `checkCoverage` builds its transcript from
// `currentSnapshot()` — coverage is just another feed subscriber, the
// existence proof that the seam works. The opt-in TranscriptForwarder
// (finalized-only remote batches, R4.3) is the second.

import Foundation
import TranscriptCore

/// A session-scoped handle on the transcript spine. Safe to hand to any task:
/// it holds only the store actor, and every call is async and isolation-free.
final class AgentFeed: Sendable {
    private let store: TranscriptStore

    init(store: TranscriptStore) {
        self.store = store
    }

    /// Subscribe to the session's transcript events. With `replayingSnapshot`
    /// (the default) the stream first delivers the current segments as
    /// synthetic `.segmentAdded` events, then live deltas — a late subscriber
    /// misses nothing. Each call mints an independent stream; a slow consumer
    /// coalesces volatile revisions latest-wins and back-pressures nobody.
    func subscribe(replayingSnapshot: Bool = true) async -> AsyncStream<TranscriptEvent> {
        await store.updates(replayingSnapshot: replayingSnapshot)
    }

    /// The finalized-text-only view of `subscribe()`: yields each segment as
    /// its text settles (plus, with `replayingSnapshot`, the already-final
    /// segments of the snapshot). Volatile revisions never appear — the
    /// subscription the TranscriptForwarder rides so in-progress words cannot
    /// leave the device.
    func finalizedSegments(replayingSnapshot: Bool = true) async -> AsyncStream<TranscriptSegment> {
        let events = await store.updates(replayingSnapshot: replayingSnapshot)
        return AsyncStream { continuation in
            let pump = Task {
                for await event in events {
                    switch event {
                    case .segmentFinalized(let segment):
                        continuation.yield(segment)
                    case .segmentAdded(let segment) where segment.state == .final:
                        continuation.yield(segment) // snapshot replay of a settled segment
                    case .segmentAdded, .segmentRevised, .turnStarted:
                        break
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in pump.cancel() }
        }
    }

    /// The whole transcript log right now, in order, as values — for
    /// point-in-time consumers (coverage) and end-of-session reconciliation.
    func currentSnapshot() async -> [TranscriptSegment] {
        await store.snapshot()
    }
}
