// ClaudeClient — the developer-mode (BYOK) ListenerService against the raw
// Anthropic Messages API. The contract under test here is the one the host
// (SessionController) and the sibling ProxyClient both assume: a text-less
// reply is the model choosing silence and must come back as an EMPTY STRING,
// not an error — declining is free. The coverage path, which must decode JSON,
// keeps treating an empty body as an error.

import XCTest
import ClaudeClient
import TurnEngine
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class ClaudeClientTests: XCTestCase {
    private func makeClient() -> ClaudeClient {
        ClaudeClient(
            config: ClaudeConfig(apiKey: "sk-test"),
            session: MockURLProtocol.makeSession()
        )
    }

    private func makeListenerRequest(tier: Tier = .reflection) -> ListenerRequest {
        ListenerRequest(
            system: "be quiet mostly",
            messages: [ListenerChatMessage(role: .user, content: "so here is my idea")],
            tier: tier,
            maxTokens: 128
        )
    }

    // ── the empty-reply-is-silence contract (regression for the BYOK path) ──

    func testRespondReturnsEmptyStringWhenContentArrayIsEmpty() async throws {
        // A 200 with no content blocks — the model returned nothing.
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [], "stop_reason": "end_turn" }"#
        )

        let reply = try await makeClient().respond(to: makeListenerRequest())

        XCTAssertEqual(reply, "", "a text-less reply must be silence, not an error")
    }

    func testRespondReturnsEmptyStringWhenTextBlockIsEmpty() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [{ "type": "text", "text": "" }], "stop_reason": "end_turn" }"#
        )

        let reply = try await makeClient().respond(to: makeListenerRequest())

        XCTAssertEqual(reply, "")
    }

    func testRespondReturnsTrimmedTextWhenModelSpeaks() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [{ "type": "text", "text": "  keep going  " }], "stop_reason": "end_turn" }"#
        )

        let reply = try await makeClient().respond(to: makeListenerRequest())

        XCTAssertEqual(reply, "keep going")
    }

    // ── respondWithUsage surfaces token usage alongside the text ──

    func testRespondWithUsageDecodesUsageBlock() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"""
            { "content": [{ "type": "text", "text": "keep going" }],
              "stop_reason": "end_turn",
              "usage": { "input_tokens": 10, "output_tokens": 3,
                         "cache_creation_input_tokens": 4096,
                         "cache_read_input_tokens": 8192 } }
            """#
        )

        let reply = try await makeClient().respondWithUsage(to: makeListenerRequest())

        XCTAssertEqual(reply.text, "keep going")
        XCTAssertEqual(reply.usage?.inputTokens, 10)
        XCTAssertEqual(reply.usage?.outputTokens, 3)
        XCTAssertEqual(reply.usage?.cacheCreationInputTokens, 4096)
        XCTAssertEqual(reply.usage?.cacheReadInputTokens, 8192)
    }

    func testRespondWithUsageReturnsUsageEvenWhenSilent() async throws {
        // Empty text is silence, but the call still cost input tokens.
        MockURLProtocol.stub(
            status: 200,
            body: #"""
            { "content": [], "stop_reason": "end_turn",
              "usage": { "input_tokens": 7, "output_tokens": 0,
                         "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 } }
            """#
        )

        let reply = try await makeClient().respondWithUsage(to: makeListenerRequest())

        XCTAssertEqual(reply.text, "", "empty text is still silence")
        XCTAssertEqual(reply.usage?.inputTokens, 7)
    }

    func testRespondWithUsageToleratesMissingUsageBlock() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [{ "type": "text", "text": "hi" }], "stop_reason": "end_turn" }"#
        )

        let reply = try await makeClient().respondWithUsage(to: makeListenerRequest())

        XCTAssertEqual(reply.text, "hi")
        XCTAssertNil(reply.usage, "no usage block ⇒ nil, not zeros")
    }

    // ── cache_control on the system prompt (analyst prefix caching) ──

    func testSystemSentAsPlainStringWithoutCachePrefix() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [{ "type": "text", "text": "ok" }], "stop_reason": "end_turn" }"#
        )
        _ = try await makeClient().respondWithUsage(to: makeListenerRequest())

        let system = MockURLProtocol.lastRequest?.bodyJSON?["system"]
        XCTAssertTrue(system is String, "no cache prefix ⇒ plain string system, byte-for-byte as today")
    }

    func testCachePrefixSplitsSystemIntoCachedAndVolatileBlocks() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [{ "type": "text", "text": "ok" }], "stop_reason": "end_turn" }"#
        )
        let request = ListenerRequest(
            system: "STABLE PREFIX\n\nVOLATILE SUFFIX",
            messages: [ListenerChatMessage(role: .user, content: "hi")],
            tier: .reflection,
            maxTokens: 128,
            cachedSystemPrefix: "STABLE PREFIX"
        )
        _ = try await makeClient().respondWithUsage(to: request)

        let blocks = MockURLProtocol.lastRequest?.bodyJSON?["system"] as? [[String: Any]]
        XCTAssertEqual(blocks?.count, 2)
        XCTAssertEqual(blocks?[0]["text"] as? String, "STABLE PREFIX")
        XCTAssertEqual((blocks?[0]["cache_control"] as? [String: Any])?["type"] as? String, "ephemeral")
        XCTAssertEqual(blocks?[1]["text"] as? String, "\n\nVOLATILE SUFFIX")
        XCTAssertNil(blocks?[1]["cache_control"], "only the stable prefix is cached")
    }

    func testMismatchedCachePrefixFallsBackToPlainStringSystem() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [{ "type": "text", "text": "ok" }], "stop_reason": "end_turn" }"#
        )
        let request = ListenerRequest(
            system: "ACTUAL SYSTEM TEXT",
            messages: [ListenerChatMessage(role: .user, content: "hi")],
            tier: .reflection,
            maxTokens: 128,
            cachedSystemPrefix: "NOT A PREFIX OF SYSTEM"
        )
        _ = try await makeClient().respondWithUsage(to: request)

        let system = MockURLProtocol.lastRequest?.bodyJSON?["system"]
        XCTAssertTrue(system is String, "a prefix that isn't actually a prefix ⇒ plain string, caching silently skipped")
        XCTAssertEqual(system as? String, "ACTUAL SYSTEM TEXT")
    }

    func testCachePrefixEqualToWholeSystemSendsSingleCachedBlock() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [{ "type": "text", "text": "ok" }], "stop_reason": "end_turn" }"#
        )
        let request = ListenerRequest(
            system: "WHOLE THING",
            messages: [ListenerChatMessage(role: .user, content: "hi")],
            tier: .reflection,
            maxTokens: 128,
            cachedSystemPrefix: "WHOLE THING"
        )
        _ = try await makeClient().respondWithUsage(to: request)

        let blocks = MockURLProtocol.lastRequest?.bodyJSON?["system"] as? [[String: Any]]
        XCTAssertEqual(blocks?.count, 1, "no volatile suffix ⇒ single cached block, no empty second block")
        XCTAssertEqual(blocks?[0]["text"] as? String, "WHOLE THING")
        XCTAssertEqual((blocks?[0]["cache_control"] as? [String: Any])?["type"] as? String, "ephemeral")
    }

    // ── analyze: structured candidate list, cached transcript prefix, usage ──

    func testAnalyzeDecodesCandidatesAndUsage() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"""
            { "content": [{ "type": "text",
                "text": "{\"candidates\":[{\"text\":\"what decides the order for a brand-new user?\",\"register\":\"question\",\"anchor\":\"ranking per-user\"}]}" }],
              "stop_reason": "end_turn",
              "usage": { "input_tokens": 5000, "output_tokens": 40,
                         "cache_creation_input_tokens": 0, "cache_read_input_tokens": 4096 } }
            """#
        )

        let reply = try await makeClient().analyze(Analyst.buildRequest(transcript: "a long transcript"))

        XCTAssertEqual(reply.result.candidates.count, 1)
        XCTAssertEqual(reply.result.candidates[0].register, "question")
        XCTAssertEqual(reply.result.candidates[0].anchor, "ranking per-user")
        XCTAssertEqual(reply.usage?.cacheReadInputTokens, 4096)
    }

    func testAnalyzeSendsStructuredSchemaAndCachedPrefixBlocks() async throws {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [{ "type": "text", "text": "{\"candidates\":[]}" }], "stop_reason": "end_turn" }"#
        )

        _ = try await makeClient().analyze(Analyst.buildRequest(transcript: "some transcript text"))

        let body = MockURLProtocol.lastRequest?.bodyJSON
        XCTAssertNotNil(body?["output_config"], "analyst uses structured outputs")
        XCTAssertTrue(body?["system"] is [[String: Any]],
                      "the transcript prefix is cached ⇒ block-array system")
    }

    // ── errors that are NOT silence still surface ──

    func testRespondSurfacesRefusalStopReason() async {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [], "stop_reason": "refusal" }"#
        )

        do {
            _ = try await makeClient().respond(to: makeListenerRequest())
            XCTFail("a refusal must not be swallowed as silence")
        } catch let error as ClaudeClientError {
            guard case .refusal = error else {
                return XCTFail("expected .refusal, got \(error)")
            }
        } catch {
            XCTFail("expected ClaudeClientError.refusal, got \(error)")
        }
    }

    func testRespondSurfacesHTTPError() async {
        MockURLProtocol.stub(
            status: 401,
            body: #"{ "error": { "message": "invalid x-api-key" } }"#
        )

        do {
            _ = try await makeClient().respond(to: makeListenerRequest())
            XCTFail("an auth failure must surface, not read as silence")
        } catch let error as ClaudeClientError {
            guard case .http(let status, let message) = error else {
                return XCTFail("expected .http, got \(error)")
            }
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message, "invalid x-api-key")
        } catch {
            XCTFail("expected ClaudeClientError.http, got \(error)")
        }
    }

    // ── coverage keeps the strict contract: no content IS an error ──

    func testCheckCoverageStillRejectsEmptyContent() async {
        MockURLProtocol.stub(
            status: 200,
            body: #"{ "content": [], "stop_reason": "end_turn" }"#
        )

        do {
            _ = try await makeClient().checkCoverage(
                transcript: "a b c",
                criteria: [CoverageCriterion(topic: "pricing")]
            )
            XCTFail("coverage needs a structured body; empty must stay an error")
        } catch {
            // expected — emptyResponse (or a decode error); either is non-silent.
        }
    }
}
