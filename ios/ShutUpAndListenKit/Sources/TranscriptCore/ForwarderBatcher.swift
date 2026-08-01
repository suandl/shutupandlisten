// The pure half of the opt-in transcript forwarder (plan R4.3, Phase 5): a
// small value type that accumulates FINALIZED segments and turns cadence
// ticks into batches. No clock, no network, no actor — the app-side
// TranscriptForwarder owns the timer and the POST; this type owns the only
// logic worth testing headlessly: what goes into a batch, and when a tick
// emits one.
//
// Finals-only is enforced HERE as well as at the subscription: `feed` ignores
// every event except finalized text (a live `.segmentFinalized`, or a
// snapshot-replay `.segmentAdded` already carrying `.final` state), so even a
// consumer wired to the raw event stream could never leak volatile text into
// a batch.

import Foundation

public struct ForwarderBatcher: Sendable {
    /// One cadence-tick's worth of finalized segments, ready to encode as the
    /// POST body. `index` is monotonic from 0 within the session so the
    /// receiving end can detect drops — delivery is best-effort by design.
    public struct Batch: Codable, Equatable, Sendable {
        public let sessionID: UUID
        public let index: Int
        public let segments: [TranscriptSegment]

        public init(sessionID: UUID, index: Int, segments: [TranscriptSegment]) {
            self.sessionID = sessionID
            self.index = index
            self.segments = segments
        }
    }

    private let sessionID: UUID
    private var pending: [TranscriptSegment] = []
    private var nextBatchIndex = 0

    public init(sessionID: UUID) {
        self.sessionID = sessionID
    }

    /// Accumulate a store event. Only finalized text is kept; volatile
    /// adds/revisions and turn markers are dropped (volatile text never
    /// reaches a batch — see the header).
    public mutating func feed(_ event: TranscriptEvent) {
        switch event {
        case .segmentFinalized(let segment):
            pending.append(segment)
        case .segmentAdded(let segment) where segment.state == .final:
            pending.append(segment) // a late subscriber's snapshot replay
        case .segmentAdded, .segmentRevised, .turnStarted:
            break
        }
    }

    /// A cadence tick: everything finalized since the last flush, or nil when
    /// nothing arrived — no empty batches on the wire.
    public mutating func tick() -> Batch? {
        flush()
    }

    /// Session end: whatever is still pending. The same emission rule as a
    /// tick — named separately so call sites read as what they are.
    public mutating func flushRemaining() -> Batch? {
        flush()
    }

    private mutating func flush() -> Batch? {
        guard !pending.isEmpty else { return nil }
        let batch = Batch(sessionID: sessionID, index: nextBatchIndex, segments: pending)
        nextBatchIndex += 1
        pending = []
        return batch
    }
}
