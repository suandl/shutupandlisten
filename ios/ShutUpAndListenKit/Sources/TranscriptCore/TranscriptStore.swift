// The spine: an actor holding the append-only transcript log, multicast to
// every consumer — live UI, persistence, agents, the turn engine's evidence
// feed (plan R4.1: ONE source of truth, everything else a subscriber).
//
// Three contracts this file implements, from the rewrite plan
// (docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md):
//
// MULTICAST. `AsyncStream` is single-consumer, so the store never exposes one
// shared stream: `updates()` mints a fresh stream per subscriber and the actor
// multicasts every event to all live registrations. The streams are
// PULL-based (`AsyncStream(unfolding:)`) so the per-subscriber queue lives in
// the actor where it can coalesce: volatile revisions are latest-wins per
// segment — a slow consumer sees the newest text, not a backlog of stale
// partials — while `.segmentAdded`/`.segmentFinalized`/`.turnStarted` buffer
// unbounded (they are the durable record; segment volumes are conversational).
// A never-consuming subscriber therefore holds at most snapshot + one
// revision per segment and back-pressures nobody. A late subscriber first
// receives the current segments as synthetic `.segmentAdded` events, then live
// deltas — no holes. Cleanup rides consumer-task cancellation (the way a
// pull-based stream terminates), deregistering the subscriber and releasing
// its queue.
//
// TURN TAGGING. The host stamps turn boundaries via `startTurn` (canonical
// audio time, from the fed-samples clock); the ENGINE knows nothing about
// turns. A segment is tagged with the turn whose boundary interval contains
// its `audioStart`; a revision re-derives the tag (a volatile growing across a
// boundary keeps its start-derived turn until finalization); a FINALIZED
// segment straddling a boundary is split at the boundary using its TimedRun
// timings so each final lies in one turn. `utteranceText(turn:)` is defined
// exactly where the old character-offset anchor was undefined: the current
// turn's finalized segments plus the post-boundary portion of a straddling
// open volatile (split by runs when available, whole-volatile when not).
//
// WRITES. Engine-driven thinker segments arrive via `append`/`revise`/
// `finalize` carrying engine-issued IDs; listener replies via
// `appendListener`/`closeListener` (the store mints those IDs — it CREATES
// listener segments, it never infers identity from ranges for anyone).

import Foundation
import TurnEngine

public actor TranscriptStore {
    // ── log state ──

    private var segments: [TranscriptSegment] = []
    /// Monotonic append-order stamp for the next new segment.
    private var nextIndex = 0
    /// Turn boundaries recorded by `startTurn`, ascending in time. Turn n owns
    /// the half-open interval [time(n), time(n+1)).
    private var boundaries: [(turn: Int, time: TimeInterval)] = []
    /// Run timings for OPEN volatile segments (when the engine supplies them
    /// with a revision) — used to carve the post-boundary portion in
    /// `utteranceText`. Finalized runs are consumed at finalization (for
    /// boundary splits) and not retained: boundaries only move forward, so a
    /// segment finalized before a boundary exists can never straddle it.
    private var volatileRuns: [SegmentID: [TimedRun]] = [:]

    // ── multicast state ──

    /// Per-subscriber pending events. A reference type ON PURPOSE: it is only
    /// ever touched inside the actor, and the registry needs to mutate entries
    /// in place (park/unpark, coalesce).
    private final class Subscriber {
        var queue: [TranscriptEvent] = []
        /// A consumer awaiting the next event while the queue is empty.
        var parked: CheckedContinuation<TranscriptEvent?, Never>?
    }

    private var subscribers: [UUID: Subscriber] = [:]

    public init() {}

    // ── subscriptions ──

    /// Mint a fresh event stream for one subscriber. With
    /// `replayingSnapshot` (the default), the stream first delivers the
    /// current segments as synthetic `.segmentAdded` events — each carrying
    /// the segment's CURRENT state — then live deltas, with no hole between.
    public func updates(replayingSnapshot: Bool = true) -> AsyncStream<TranscriptEvent> {
        let key = UUID()
        let sub = Subscriber()
        if replayingSnapshot {
            sub.queue = segments.map { .segmentAdded($0) }
        }
        subscribers[key] = sub
        return AsyncStream<TranscriptEvent>(
            unfolding: { [weak self] in
                guard let self else { return nil }
                return await self.next(for: key)
            },
            onCancel: { [weak self] in
                guard let self else { return }
                Task { await self.terminate(key) }
            }
        )
    }

    /// Deliver the subscriber's next event, parking until one arrives. Returns
    /// nil — ending the stream — when the subscription is gone (cancelled).
    private func next(for key: UUID) async -> TranscriptEvent? {
        guard let sub = subscribers[key] else { return nil }
        if !sub.queue.isEmpty { return sub.queue.removeFirst() }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<TranscriptEvent?, Never>) in
                // Still registered, and not cancelled in the window before we
                // could park? (terminate() may already have run.)
                guard let sub = subscribers[key], !Task.isCancelled else {
                    subscribers[key] = nil
                    cont.resume(returning: nil)
                    return
                }
                sub.parked = cont
            }
        } onCancel: {
            Task { await self.terminate(key) }
        }
    }

    private func terminate(_ key: UUID) {
        guard let sub = subscribers.removeValue(forKey: key) else { return }
        sub.parked?.resume(returning: nil)
        sub.parked = nil
    }

    /// Test hook: live registrations.
    var subscriberCount: Int { subscribers.count }

    private func publish(_ event: TranscriptEvent) {
        for sub in subscribers.values {
            if let parked = sub.parked {
                sub.parked = nil
                parked.resume(returning: event)
            } else if case .segmentRevised(let seg) = event,
                      let stale = sub.queue.lastIndex(where: { queued in
                          if case .segmentRevised(let q) = queued { return q.id == seg.id }
                          return false
                      }) {
                // Coalesce: latest revision wins, in the stale one's slot —
                // the consumer still sees SOME revision at the original point
                // in the order, just with the newest text.
                sub.queue[stale] = event
            } else {
                sub.queue.append(event)
            }
        }
    }

    // ── engine-driven writes (thinker segments; engine-issued IDs) ──

    /// Open a new volatile segment. `runs` may carry provisional word timings
    /// when the engine has them (used only for `utteranceText` boundary
    /// carving; most engines supply runs at finalization only).
    public func append(
        id: SegmentID,
        speaker: Speaker = .thinker,
        text: String,
        range: ClosedRange<TimeInterval>,
        runs: [TimedRun] = []
    ) {
        guard position(of: id) == nil else { return } // duplicate ID — engine bug; drop
        let seg = TranscriptSegment(
            id: id,
            speaker: speaker,
            text: text,
            state: .volatile,
            audioStart: range.lowerBound,
            audioEnd: range.upperBound,
            turn: turnTag(forStart: range.lowerBound),
            index: nextIndex
        )
        nextIndex += 1
        segments.append(seg)
        if !runs.isEmpty { volatileRuns[id] = runs }
        publish(.segmentAdded(seg))
    }

    /// Replace an open volatile segment's text/timing in place (the analyzer's
    /// successive volatile results). The turn tag is re-derived from the new
    /// `audioStart`. Ignored for unknown or already-final IDs.
    public func revise(
        id: SegmentID,
        text: String,
        range: ClosedRange<TimeInterval>,
        runs: [TimedRun] = []
    ) {
        guard let i = position(of: id), segments[i].state == .volatile else { return }
        segments[i].text = text
        segments[i].audioStart = range.lowerBound
        segments[i].audioEnd = range.upperBound
        segments[i].turn = turnTag(forStart: range.lowerBound)
        // Stale runs would misalign with the new text — replace or clear.
        volatileRuns[id] = runs.isEmpty ? nil : runs
        publish(.segmentRevised(segments[i]))
    }

    /// Close a volatile segment with the engine's finalized result(s) — one
    /// volatile may finalize into several sentence-level finals, each with its
    /// own engine-issued ID (reusing the volatile's ID for the first keeps
    /// that identity stable volatile → final). Each final is then split at any
    /// turn boundary it straddles, using its runs, so every stored final lies
    /// in exactly one turn. Emits `.segmentFinalized` per resulting segment,
    /// in order.
    public func finalize(id: SegmentID, into finals: [FinalizedText]) {
        guard let i = position(of: id), segments[i].state == .volatile else { return }
        let closing = segments[i]
        volatileRuns[id] = nil
        segments.remove(at: i)
        guard !finals.isEmpty else { return } // engine finalized to nothing: drop the volatile

        var replacement: [TranscriptSegment] = []
        for final in finals {
            let pieces = splitAtBoundaries(text: final.text, range: final.range, runs: final.runs)
            for (k, piece) in pieces.enumerated() {
                let index: Int
                if replacement.isEmpty {
                    index = closing.index // the first final inherits the closed slot's order
                } else {
                    index = nextIndex
                    nextIndex += 1
                }
                replacement.append(TranscriptSegment(
                    id: k == 0 ? final.id : SegmentID(), // split pieces beyond the first are store-minted
                    speaker: closing.speaker,
                    text: piece.text,
                    state: .final,
                    audioStart: piece.start,
                    audioEnd: piece.end,
                    turn: turnTag(forStart: piece.start),
                    tier: closing.tier,
                    bargedIn: closing.bargedIn,
                    index: index
                ))
            }
        }
        segments.insert(contentsOf: replacement, at: i)
        for seg in replacement { publish(.segmentFinalized(seg)) }
    }

    // ── host-driven writes ──

    /// Record a turn boundary (the detector's `turn-start`, stamped by the
    /// host in canonical audio time via the fed-samples clock). Existing
    /// segment tags are not retro-revised: open volatiles re-derive on their
    /// next revision or at finalization, and `utteranceText` reads boundaries
    /// live, so nothing downstream sees a stale carve.
    public func startTurn(_ turn: Int, atAudioTime time: TimeInterval) {
        boundaries.append((turn: turn, time: time))
        boundaries.sort { $0.time < $1.time }
        publish(.turnStarted(turn: turn, atAudioTime: time))
    }

    /// Append a listener reply as an OPEN segment with an estimated range
    /// (start = audioNow at speak, end = start + TTS estimate). The store
    /// mints the ID — the transcription engine never sees listener speech.
    @discardableResult
    public func appendListener(
        text: String,
        tier: Tier?,
        estimatedRange: ClosedRange<TimeInterval>
    ) -> SegmentID {
        let id = SegmentID()
        let seg = TranscriptSegment(
            id: id,
            speaker: .listener,
            text: text,
            state: .volatile,
            audioStart: estimatedRange.lowerBound,
            audioEnd: estimatedRange.upperBound,
            turn: turnTag(forStart: estimatedRange.lowerBound),
            tier: tier,
            index: nextIndex
        )
        nextIndex += 1
        segments.append(seg)
        publish(.segmentAdded(seg))
        return id
    }

    /// Close a listener segment with the ACTUAL end — natural finish, or the
    /// cut point on barge-in (`bargedIn: true`, so replay/export never present
    /// unspoken words as spoken).
    public func closeListener(id: SegmentID, actualEnd: TimeInterval, bargedIn: Bool = false) {
        guard let i = position(of: id),
              segments[i].speaker == .listener,
              segments[i].state == .volatile
        else { return }
        segments[i].audioEnd = actualEnd
        segments[i].bargedIn = bargedIn
        segments[i].state = .final
        publish(.segmentFinalized(segments[i]))
    }

    // ── reads ──

    /// The whole log, in order, as values.
    public func snapshot() -> [TranscriptSegment] {
        segments
    }

    /// Everything the THINKER has said so far (finalized + volatile), joined —
    /// the coverage check's input, matching the old transcriber's `fullText`.
    public var fullText: String {
        segments
            .filter { $0.speaker == .thinker && !$0.text.isEmpty }
            .map(\.text)
            .joined(separator: " ")
    }

    /// The thinker's utterance for `turn`, as the gate must see it (the WHOLE
    /// thought so far, spec §4b): the turn's finalized segments plus — when
    /// the open volatile straddles the turn's start boundary — the portion of
    /// its text at/after the boundary (carved by runs when the engine supplied
    /// them, the whole volatile text when not).
    public func utteranceText(turn: Int) -> String {
        let boundary = boundaries.first(where: { $0.turn == turn })?.time
        var parts: [String] = []
        for seg in segments where seg.speaker == .thinker {
            if seg.turn == turn {
                if !seg.text.isEmpty { parts.append(seg.text) }
            } else if seg.state == .volatile,
                      seg.turn < turn,
                      let boundary,
                      seg.audioStart < boundary, seg.audioEnd > boundary {
                let portion = postBoundaryPortion(of: seg, at: boundary)
                if !portion.isEmpty { parts.append(portion) }
            }
        }
        return parts.joined(separator: " ")
    }

    // ── turn derivation internals ──

    private func position(of id: SegmentID) -> Int? {
        segments.firstIndex { $0.id == id }
    }

    /// The turn whose boundary interval [time(n), time(n+1)) contains `t`;
    /// 0 before any recorded boundary.
    private func turnTag(forStart t: TimeInterval) -> Int {
        var tag = 0
        for b in boundaries where b.time <= t { tag = b.turn }
        return tag
    }

    private struct Piece {
        var text: String
        var start: TimeInterval
        var end: TimeInterval
        var runs: [TimedRun]
    }

    /// Split a finalized text at every recorded boundary strictly inside its
    /// range, cutting at the first run at/after each boundary. Without usable
    /// runs the text cannot be split and stays whole (start-derived tag) —
    /// best-effort by design.
    private func splitAtBoundaries(
        text: String, range: ClosedRange<TimeInterval>, runs: [TimedRun]
    ) -> [Piece] {
        var pieces = [Piece(text: text, start: range.lowerBound, end: range.upperBound, runs: runs)]
        let inner = boundaries.map(\.time)
            .filter { $0 > range.lowerBound && $0 < range.upperBound }
            .sorted()
        for b in inner {
            let last = pieces[pieces.count - 1]
            guard b > last.start, b < last.end, !last.runs.isEmpty,
                  let firstAfter = last.runs.first(where: { $0.audioStart >= b }),
                  firstAfter.charOffset > 0, firstAfter.charOffset < last.text.utf16.count
            else { continue }
            let cut = String.Index(utf16Offset: firstAfter.charOffset, in: last.text)
            var preText = String(last.text[..<cut])
            while let c = preText.last, c.isWhitespace { preText.removeLast() }
            var postText = String(last.text[cut...])
            let lead = postText.utf16.count
            postText = String(postText.drop(while: { $0.isWhitespace }))
            // Rebase the post piece's runs to its own (trimmed) text.
            let shift = firstAfter.charOffset + (lead - postText.utf16.count)
            pieces[pieces.count - 1] = Piece(
                text: preText, start: last.start, end: b,
                runs: last.runs.filter { $0.charOffset < firstAfter.charOffset }
            )
            pieces.append(Piece(
                text: postText, start: b, end: last.end,
                runs: last.runs
                    .filter { $0.charOffset >= firstAfter.charOffset }
                    .map { TimedRun(
                        charOffset: max(0, $0.charOffset - shift),
                        charLength: $0.charLength,
                        audioStart: $0.audioStart,
                        audioEnd: $0.audioEnd
                    ) }
            ))
        }
        return pieces
    }

    /// The slice of an open volatile's text at/after a boundary: from the
    /// first run at/after it when runs exist, the WHOLE text when they don't
    /// (an over-approximation is the safe direction for gate evidence — the
    /// gate sees at least everything said since the boundary).
    private func postBoundaryPortion(of seg: TranscriptSegment, at boundary: TimeInterval) -> String {
        guard let runs = volatileRuns[seg.id], !runs.isEmpty else { return seg.text }
        guard let firstAfter = runs.first(where: { $0.audioStart >= boundary }) else {
            return "" // everything timed lies before the boundary
        }
        guard firstAfter.charOffset > 0, firstAfter.charOffset < seg.text.utf16.count else {
            return seg.text
        }
        let cut = String.Index(utf16Offset: firstAfter.charOffset, in: seg.text)
        return String(seg.text[cut...].drop(while: { $0.isWhitespace }))
    }
}
