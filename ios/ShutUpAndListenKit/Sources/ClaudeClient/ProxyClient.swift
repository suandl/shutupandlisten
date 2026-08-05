// The customer-path ListenerService — the shutupandlisten proxy over raw HTTP
// (server/API.md). The server holds the Anthropic key; this client holds only
// the per-user session token from AccountClient and forwards the same
// requests ClaudeClient would have made directly:
//
//   respond(to:)               → POST /v1/listener  (metered pass-through)
//   checkCoverage(transcript:) → POST /v1/coverage  (server-side prompt+schema)
//
// SessionController talks only to ListenerService, so swapping this in for
// the BYOK ClaudeClient is a configuration choice, not a code path.

import Foundation
import TurnEngine
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public final class ProxyClient: ListenerService, @unchecked Sendable {
    private let config: ProxyConfig
    private let sessionToken: String
    private let urlSession: URLSession

    public init(config: ProxyConfig, sessionToken: String, urlSession: URLSession = .shared) {
        self.config = config
        self.sessionToken = sessionToken
        self.urlSession = urlSession
    }

    /// One substantive listener turn via the proxy. An empty string is a
    /// valid reply — the model choosing silence is expected and free.
    public func respond(to request: ListenerRequest) async throws -> String {
        let body: [String: Any] = [
            "system": request.system,
            "messages": request.messages.map {
                ["role": $0.role.rawValue, "content": $0.content]
            },
            "maxTokens": request.maxTokens,
            "tier": request.tier.rawValue,
        ]
        let data = try await post("v1/listener", body: body)

        struct ListenerResponse: Decodable { let text: String }
        do {
            let decoded = try JSONDecoder().decode(ListenerResponse.self, from: data)
            return decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw ProxyError.decoding(String(describing: error))
        }
    }

    /// Coverage check via the proxy. The server owns the coverage system
    /// prompt and the structured-outputs schema (kept in sync with
    /// TurnEngine/Coverage.swift), so the response body IS a CoverageResult.
    public func checkCoverage(
        transcript: String,
        criteria: [CoverageCriterion]
    ) async throws -> CoverageResult {
        let body: [String: Any] = [
            "transcript": transcript,
            "criteria": criteria.map { $0.topic },
        ]
        let data = try await post("v1/coverage", body: body)
        do {
            return try JSONDecoder().decode(CoverageResult.self, from: data)
        } catch {
            throw ProxyError.decoding(String(describing: error))
        }
    }

    /// One analyst cycle via the proxy. The server owns the analyst system
    /// prompt, the structured-outputs schema, AND the transcript's cache-block
    /// layout (all kept in sync with TurnEngine/AnalystPrompt.swift), so the
    /// client sends only the transcript text and the response body IS an
    /// AnalystResult. Overrides the empty-pool default in ListenerService so
    /// proxy users get a live candidate pool instead of a cold one.
    ///
    /// `AnalystRequest.systemBlocks` (the pre-built, cache-flagged block
    /// sequence) is the BYOK path's concern; over the proxy the server rebuilds
    /// that layout from the transcript, so we forward `request.transcript` and
    /// let the server do the chunking. The proxy surfaces no token usage (as with
    /// the respondWithUsage default), so the reply carries `usage: nil`.
    public func analyze(_ request: AnalystRequest) async throws -> AnalystReply {
        let body: [String: Any] = [
            "transcript": request.transcript,
        ]
        let data = try await post("v1/analyst", body: body)
        do {
            let result = try JSONDecoder().decode(AnalystResult.self, from: data)
            return AnalystReply(result: result, usage: nil)
        } catch {
            throw ProxyError.decoding(String(describing: error))
        }
    }

    private func post(_ path: String, body: [String: Any]) async throws -> Data {
        try await ProxyWire.post(
            config.baseURL.appendingPathComponent(path),
            body: body,
            bearerToken: sessionToken,
            session: urlSession
        )
    }
}
