// The seam between the host and whichever backend produces substantive
// replies. Two conformers:
//
//   ClaudeClient  — direct Anthropic calls with a user-supplied key
//                   (developer mode; the original BYOK path)
//   ProxyClient   — the customer path: the shutupandlisten proxy holds the
//                   Anthropic key and the app holds a per-user session token
//                   (see server/API.md)
//
// SessionController talks only to this protocol, so the product/dev split is
// a configuration choice, not a code path.

import Foundation
import TurnEngine

public protocol ListenerService: Sendable {
    /// One substantive listener turn. An empty string is a valid reply — the
    /// model choosing silence is expected and free.
    func respond(to request: ListenerRequest) async throws -> String

    /// One substantive listener turn, plus the token usage the call reported.
    /// Backends that cannot surface usage return `usage: nil`.
    func respondWithUsage(to request: ListenerRequest) async throws -> ListenerReply

    /// Evaluate the recording so far against a checklist.
    func checkCoverage(
        transcript: String,
        criteria: [CoverageCriterion]
    ) async throws -> CoverageResult
}

public extension ListenerService {
    /// Default: reuse `respond` and report no usage. ClaudeClient overrides this
    /// to decode the `usage` block; ProxyClient keeps this default until the
    /// proxy passes usage through.
    func respondWithUsage(to request: ListenerRequest) async throws -> ListenerReply {
        ListenerReply(text: try await respond(to: request), usage: nil)
    }
}

extension ClaudeClient: ListenerService {}
