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

    /// Evaluate the recording so far against a checklist.
    func checkCoverage(
        transcript: String,
        criteria: [CoverageCriterion]
    ) async throws -> CoverageResult
}

extension ClaudeClient: ListenerService {}
