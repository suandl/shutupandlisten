// The remote arm of the agent seam (plan R4.3): an AgentFeed subscriber that
// batches FINALIZED transcript segments and POSTs them as JSON to a
// user-configured HTTPS endpoint at a configurable cadence (default 5 s).
// Instantiated by SessionController ONLY when the Settings toggle is on —
// with it off (the default), this type never exists and zero transcript
// text leaves the device.
//
// Volatile text NEVER leaves the device: the forwarder subscribes to
// `feed.finalizedSegments()` — a stream that structurally cannot yield an
// in-progress segment — and the pure ForwarderBatcher (TranscriptCore,
// headless-tested) enforces finals-only a second time on the way into a
// batch.
//
// Delivery is silent best-effort: a failed POST is logged to the console in
// DEBUG builds and the batch dropped — no user-facing error spam for a
// background firehose the user pointed at their own endpoint. The receiving
// end can detect drops via the monotonic batch index.
// v2: retry with a bounded on-device backlog, so a flaky endpoint gets the
// missed batches on the next successful push instead of a hole.

import Foundation
import TranscriptCore

actor TranscriptForwarder {
    private let feed: AgentFeed
    private let endpoint: URL
    private let cadenceSeconds: TimeInterval
    private var batcher: ForwarderBatcher
    /// Store append indexes already fed to the batcher — lets `stop()`
    /// reconcile against the post-drain snapshot without double-sending
    /// (the same closeOut pattern PersistenceWriter uses).
    private var ingestedIndexes: Set<Int> = []
    private var consumeTask: Task<Void, Never>?
    private var tickTask: Task<Void, Never>?
    private var stopped = false

    init(feed: AgentFeed, sessionID: UUID, endpoint: URL, cadenceSeconds: TimeInterval) {
        self.feed = feed
        self.endpoint = endpoint
        self.cadenceSeconds = min(max(cadenceSeconds, 2), 30) // the Settings stepper's range
        self.batcher = ForwarderBatcher(sessionID: sessionID)
    }

    /// Attach to the feed and start the cadence clock. Idempotent.
    func start() {
        guard consumeTask == nil, !stopped else { return }
        consumeTask = Task {
            let finals = await feed.finalizedSegments()
            for await segment in finals {
                ingest(segment)
            }
        }
        tickTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(cadenceSeconds * 1_000_000_000))
                guard !Task.isCancelled, !stopped else { return }
                if let batch = batcher.tick() {
                    let delivered = await post(batch)
                    if !delivered, Task.isCancelled {
                        // stop() cancelled us mid-POST: URLSession tore the
                        // request down, but these segments are already marked
                        // ingested, so the stop-path reconcile would skip
                        // them. Give the batch back to the batcher so
                        // stop()'s flushRemaining still sends the words.
                        requeue(batch)
                        return
                    }
                }
            }
        }
    }

    /// Session end: stop consuming, reconcile any finals the pull loop had
    /// not caught up on against the host's post-drain snapshot, and flush the
    /// tail batch. Called by SessionController after the engine drain, so the
    /// snapshot holds every finalized segment.
    func stop() async {
        guard !stopped else { return }
        stopped = true
        let tick = tickTask
        consumeTask?.cancel()
        tickTask?.cancel()
        consumeTask = nil
        tickTask = nil
        // Await the tick loop before reconciling: a cancel that landed mid-POST
        // requeues its batch only when the loop resumes, and flushRemaining
        // below is the last flush those words can catch. Awaiting releases the
        // actor, so the loop's requeue can run — no deadlock.
        await tick?.value
        for segment in await feed.currentSnapshot() where segment.state == .final {
            ingest(segment)
        }
        if let batch = batcher.flushRemaining() {
            // Deliberately discarded, unlike the tick loop's call: this is the
            // LAST flush of the session. The tick site acts on the result only
            // to hand a cancelled batch back for this flush to retry — there is
            // no flush after this one, and the batcher is per-session and dies
            // with the actor, so a requeue here would strand the words rather
            // than resend them. A failure is already logged inside `post`, which
            // is the documented contract for this feed (see the header: silent
            // best-effort, drop on failure, receiver detects holes via the
            // monotonic batch index).
            _ = await post(batch)
        }
    }

    // ── internals ──

    private func ingest(_ segment: TranscriptSegment) {
        guard segment.state == .final else { return } // belt-and-braces; the stream is finals-only
        guard !ingestedIndexes.contains(segment.index) else { return }
        ingestedIndexes.insert(segment.index)
        batcher.feed(.segmentFinalized(segment))
    }

    /// Put a torn-down batch's segments back in the batcher (they stay in
    /// `ingestedIndexes` — the reconcile must still skip them; the batcher is
    /// now the one holding them for the tail flush).
    private func requeue(_ batch: ForwarderBatcher.Batch) {
        for segment in batch.segments {
            batcher.feed(.segmentFinalized(segment))
        }
    }

    /// One plain JSON POST — the "configurable consumer" is whatever the user
    /// pointed the URL at (the server/ endpoint is out of scope, plan Phase 5).
    /// Returns whether the batch was handed to the endpoint (any HTTP status
    /// counts — a rejection is the receiver's choice, not a lost request).
    private func post(_ batch: ForwarderBatcher.Batch) async -> Bool {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15 // best-effort: fail fast, drop, move on
        do {
            request.httpBody = try JSONEncoder().encode(batch)
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, !(200 ... 299).contains(http.statusCode) {
                #if DEBUG
                print("TranscriptForwarder: batch \(batch.index) rejected — HTTP \(http.statusCode)")
                #endif
            }
            return true
        } catch {
            #if DEBUG
            print("TranscriptForwarder: batch \(batch.index) dropped — \(error.localizedDescription)")
            #endif
            return false
        }
    }
}
