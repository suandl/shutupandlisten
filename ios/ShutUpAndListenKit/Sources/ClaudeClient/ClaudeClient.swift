// The listener-model adapter — Claude over raw HTTP.
//
// Swift has no official Anthropic SDK, so this calls POST /v1/messages
// directly with URLSession. Replies here are short by design (the response
// hierarchy caps a reflection/question at a sentence or two), so non-streaming
// requests are well inside HTTP timeouts.
//
// Only the substantive tiers reach this module — silence and acknowledgments
// are answered by the rules layer (TurnEngine.decideTier) with no model call,
// which is the "reduced role" split from CONCEPTS.md.

import Foundation
import TurnEngine
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct ClaudeConfig: Sendable {
    public var apiKey: String
    public var model: String
    public var endpoint: URL

    public init(
        apiKey: String,
        model: String = "claude-opus-4-8",
        endpoint: URL = URL(string: "https://api.anthropic.com/v1/messages")!
    ) {
        self.apiKey = apiKey
        self.model = model
        self.endpoint = endpoint
    }
}

public enum ClaudeClientError: Error, LocalizedError {
    case missingAPIKey
    case http(status: Int, message: String)
    case refusal
    case emptyResponse
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "No Claude API key configured. Add one in Settings."
        case .http(let status, let message):
            return "Claude API error (\(status)): \(message)"
        case .refusal:
            return "The model declined this request."
        case .emptyResponse:
            return "The model returned no text."
        case .decoding(let detail):
            return "Could not decode the API response: \(detail)"
        }
    }
}

public final class ClaudeClient: @unchecked Sendable {
    private let config: ClaudeConfig
    private let session: URLSession

    public init(config: ClaudeConfig, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    /// One listener turn: the gate's ListenerRequest → the model's reply text.
    /// An empty string is a valid reply — the prompt tells the model that
    /// silence is the correct response for most turns.
    public func respond(to request: ListenerRequest) async throws -> String {
        try await respondWithUsage(to: request).text
    }

    /// As `respond`, but also returns the token usage the call reported (nil if
    /// the response carried no `usage` block).
    public func respondWithUsage(to request: ListenerRequest) async throws -> ListenerReply {
        let result = try await complete(
            systemField: Self.systemField(request.system, cachedPrefix: request.cachedSystemPrefix),
            messages: request.messages.map { ["role": $0.role.rawValue, "content": $0.content] },
            maxTokens: request.maxTokens,
            // A text-less reply is the model choosing silence — a valid outcome
            // the host maps to `.silence` (declining is free). Only the coverage
            // path, which must decode JSON, treats an empty body as an error.
            allowEmpty: true
        )
        return ListenerReply(
            text: result.text.trimmingCharacters(in: .whitespacesAndNewlines),
            usage: result.usage
        )
    }

    /// Coverage check: transcript + checklist → structured CoverageResult,
    /// enforced by the Messages API's structured outputs (output_config.format).
    public func checkCoverage(
        transcript: String,
        criteria: [CoverageCriterion]
    ) async throws -> CoverageResult {
        let result = try await complete(
            systemField: Self.systemField(Coverage.systemPrompt, cachedPrefix: nil),
            messages: [[
                "role": "user",
                "content": Coverage.userMessage(transcript: transcript, criteria: criteria),
            ]],
            maxTokens: 2048,
            outputSchema: Coverage.resultSchema
        )
        guard let data = result.text.data(using: .utf8) else {
            throw ClaudeClientError.decoding("coverage result was not UTF-8")
        }
        do {
            return try JSONDecoder().decode(CoverageResult.self, from: data)
        } catch {
            throw ClaudeClientError.decoding("coverage result did not match schema: \(error)")
        }
    }

    /// One analyst cycle: whole-transcript request (sent as the analyst's block
    /// sequence, cache breakpoint included) → parsed `AnalystResult` + token
    /// usage. Uses the Messages API structured outputs so the candidate list
    /// parses cleanly.
    public func analyze(_ request: AnalystRequest) async throws -> AnalystReply {
        let result = try await complete(
            systemField: Self.systemField(blocks: request.systemBlocks),
            messages: request.messages.map { ["role": $0.role.rawValue, "content": $0.content] },
            maxTokens: request.maxTokens,
            outputSchema: Analyst.resultSchema
        )
        guard let data = result.text.data(using: .utf8) else {
            throw ClaudeClientError.decoding("analyst result was not UTF-8")
        }
        do {
            let parsed = try JSONDecoder().decode(AnalystResult.self, from: data)
            return AnalystReply(result: parsed, usage: result.usage)
        } catch {
            throw ClaudeClientError.decoding("analyst result did not match schema: \(error)")
        }
    }

    // ── raw Messages API call ──

    private struct CompletionResult { let text: String; let usage: Usage? }

    /// `systemField` is the already-serialized Messages API `system` value —
    /// a plain string or a block array, built by one of the `systemField`
    /// helpers below.
    private func complete(
        systemField: Any,
        messages: [[String: String]],
        maxTokens: Int,
        outputSchema: [String: Any]? = nil,
        allowEmpty: Bool = false
    ) async throws -> CompletionResult {
        guard !config.apiKey.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw ClaudeClientError.missingAPIKey
        }

        var body: [String: Any] = [
            "model": config.model,
            "max_tokens": maxTokens,
            "system": systemField,
            "messages": messages,
        ]
        if let outputSchema {
            body["output_config"] = [
                "format": ["type": "json_schema", "schema": outputSchema]
            ]
        }

        var urlRequest = URLRequest(url: config.endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(config.apiKey, forHTTPHeaderField: "x-api-key")
        urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        urlRequest.timeoutInterval = 60

        let (data, response) = try await session.data(for: urlRequest)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = Self.errorMessage(from: data) ?? String(data: data, encoding: .utf8) ?? ""
            throw ClaudeClientError.http(status: status, message: message)
        }

        let decoded: MessagesResponse
        do {
            decoded = try JSONDecoder().decode(MessagesResponse.self, from: data)
        } catch {
            throw ClaudeClientError.decoding(String(describing: error))
        }
        // Check stop_reason before reading content: a refusal can arrive as a
        // successful HTTP 200 with empty content.
        if decoded.stopReason == "refusal" {
            throw ClaudeClientError.refusal
        }
        let usage = decoded.usage.map {
            Usage(
                inputTokens: $0.inputTokens ?? 0,
                outputTokens: $0.outputTokens ?? 0,
                cacheCreationInputTokens: $0.cacheCreationInputTokens ?? 0,
                cacheReadInputTokens: $0.cacheReadInputTokens ?? 0
            )
        }
        guard let text = decoded.content.first(where: { $0.type == "text" })?.text else {
            // No text block: the model returned nothing. For the listener path
            // that is a valid "silence" reply; only callers that require content
            // (coverage) treat it as an error.
            if allowEmpty { return CompletionResult(text: "", usage: usage) }
            throw ClaudeClientError.emptyResponse
        }
        return CompletionResult(text: text, usage: usage)
    }

    private static func errorMessage(from data: Data) -> String? {
        struct ErrorEnvelope: Decodable {
            struct Inner: Decodable { let message: String }
            let error: Inner
        }
        return (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.error.message
    }

    /// Build the Messages API `system` field. Plain string when there is no
    /// cache prefix; otherwise a two-block array — the stable prefix carrying a
    /// cache_control breakpoint, then the volatile remainder. `cachedPrefix`
    /// is expected to be a leading substring of `system`.
    private static func systemField(_ system: String, cachedPrefix: String?) -> Any {
        guard let cachedPrefix, !cachedPrefix.isEmpty, system.hasPrefix(cachedPrefix) else {
            return system
        }
        let suffix = String(system.dropFirst(cachedPrefix.count))
        var blocks: [[String: Any]] = [[
            "type": "text",
            "text": cachedPrefix,
            "cache_control": ["type": "ephemeral"],
        ]]
        if !suffix.isEmpty {
            blocks.append(["type": "text", "text": suffix])
        }
        return blocks
    }

    /// Build the Messages API `system` field from an explicit block list (the
    /// analyst path): one `{"type":"text","text":…}` per block, with the
    /// cache_control breakpoint on the flagged one. Empty blocks are dropped —
    /// the API rejects empty text blocks — though `Analyst.buildRequest` never
    /// emits one.
    private static func systemField(blocks: [SystemBlock]) -> Any {
        blocks.filter { !$0.text.isEmpty }.map { block -> [String: Any] in
            var out: [String: Any] = ["type": "text", "text": block.text]
            if block.cached { out["cache_control"] = ["type": "ephemeral"] }
            return out
        }
    }

    private struct MessagesResponse: Decodable {
        struct ContentBlock: Decodable {
            let type: String
            let text: String?
        }
        struct UsageBlock: Decodable {
            let inputTokens: Int?
            let outputTokens: Int?
            let cacheCreationInputTokens: Int?
            let cacheReadInputTokens: Int?

            enum CodingKeys: String, CodingKey {
                case inputTokens = "input_tokens"
                case outputTokens = "output_tokens"
                case cacheCreationInputTokens = "cache_creation_input_tokens"
                case cacheReadInputTokens = "cache_read_input_tokens"
            }
        }

        let content: [ContentBlock]
        let stopReason: String?
        let usage: UsageBlock?

        enum CodingKeys: String, CodingKey {
            case content
            case stopReason = "stop_reason"
            case usage
        }
    }
}
