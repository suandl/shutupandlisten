// The ambient analysis brain (spec §2): one background understanding of the
// whole conversation, kept as a small ranked pool of ready-to-speak candidate
// interjections. It never decides WHEN to speak — the reactive gate still owns
// that — it only keeps fresh options ready, so the gate can speak one instantly
// (no cold round-trip) and the screen can show it as a silent hint.
//
// All the correctness-bearing logic is pure and lives in TurnEngine
// (CandidatePool, Analyst, AnalystCadence); this is the impure driver. The pool
// is an optimization + coherence layer, NEVER a correctness dependency: any
// failure (offline, signed-out, proxy without /v1/analyst) leaves it cold and
// the gate falls back to today's single live call or silence.

import ClaudeClient
import Foundation
import TurnEngine

@MainActor
final class ConversationAnalyst {
    /// How to reach the model right now (nil ⇒ no account/key ⇒ stay cold).
    var makeService: () -> (any ListenerService)? = { nil }
    /// Bill each cycle's usage into the session cost accumulator.
    var onUsage: (Usage?) -> Void = { _ in }
    /// Fired whenever the visible candidate set changes (after a cycle or an
    /// expiry sweep) so the controller can republish the on-screen hint.
    var onCandidatesChanged: ([Candidate]) -> Void = { _ in }

    private var pool = CandidatePool()
    private var lastRunMs: Double?
    private var pendingSince: Double?
    private var inFlight = false
    /// Bumped by `reset()` to invalidate any cycle still in flight across a
    /// session boundary — a late reply from the previous session must not
    /// repopulate the new session's pool (its stale anchors would never expire).
    private var generation = 0

    /// A finished substantive thinker turn — new content worth a cycle.
    func noteFinishedTurn(atMs t: Double) {
        if pendingSince == nil { pendingSince = t }
    }

    /// Called on the controller's 0.1 s tick. Expires stale candidates against
    /// the live transcript, then runs a cycle if the cadence allows.
    func tick(nowMs: Double, transcript: String) {
        let before = pool.candidates
        pool.expire(currentPosition: transcript.count)
        if pool.candidates != before { onCandidatesChanged(pool.candidates) }

        guard !inFlight,
              AnalystCadence.shouldRecompute(
                  nowMs: nowMs, lastRunMs: lastRunMs, pendingSince: pendingSince
              )
        else { return }
        recompute(nowMs: nowMs, transcript: transcript)
    }

    /// The best-fitting still-fresh candidate for a gate register — the voice
    /// surface's pick. Nil ⇒ the gate falls back to a live call.
    func candidate(for register: Tier, transcriptLength: Int) -> Candidate? {
        pool.expire(currentPosition: transcriptLength)
        return pool.best(register: register)
    }

    /// New session: cold pool, no history. Any cycle still in flight is
    /// invalidated (its completion is dropped) via the generation bump.
    func reset() {
        pool = CandidatePool()
        lastRunMs = nil
        pendingSince = nil
        inFlight = false
        generation += 1
        onCandidatesChanged([])
    }

    private func recompute(nowMs: Double, transcript: String) {
        guard !transcript.isEmpty, let service = makeService() else { return }
        inFlight = true
        lastRunMs = nowMs
        pendingSince = nil
        let anchor = transcript.count
        let gen = generation
        let request = Analyst.buildRequest(transcript: transcript)

        Task { [weak self] in
            // Graceful degradation: swallow every failure — a cold pool is a
            // valid state and the gate has a live fallback.
            let reply = try? await service.analyze(request)
            await MainActor.run {
                guard let self else { return }
                // Drop a stale cycle whose session was reset while it was in
                // flight — its candidates are anchored to a transcript that no
                // longer exists.
                guard self.generation == gen else { return }
                self.inFlight = false
                guard let reply else { return }
                self.onUsage(reply.usage)
                let fresh = reply.result.candidates.compactMap { c -> Candidate? in
                    guard let register = Tier(rawValue: c.register),
                          register == .reflection || register == .question
                    else { return nil }
                    return Candidate(text: c.text, register: register, anchorPosition: anchor)
                }
                self.pool.replace(with: fresh)
                self.onCandidatesChanged(self.pool.candidates)
            }
        }
    }
}
