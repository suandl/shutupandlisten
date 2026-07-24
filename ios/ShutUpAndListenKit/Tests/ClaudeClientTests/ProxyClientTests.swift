// ProxyClient — the customer-path ListenerService against server/API.md:
// listener request shape (bearer auth, body fields, tier string), the
// empty-text-is-valid contract, the coverage round-trip into CoverageResult,
// and every error-status → ProxyError mapping including envelope extraction.

import XCTest
import ClaudeClient
import TurnEngine
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class ProxyClientTests: XCTestCase {
    private func makeClient(token: String = "tok-123") -> ProxyClient {
        ProxyClient(
            config: ProxyConfig(baseURL: URL(string: "https://proxy.test")!),
            sessionToken: token,
            urlSession: MockURLProtocol.makeSession()
        )
    }

    private func makeListenerRequest() -> ListenerRequest {
        ListenerRequest(
            system: "be quiet mostly",
            messages: [
                ListenerChatMessage(role: .user, content: "so here is my idea"),
                ListenerChatMessage(role: .assistant, content: "mm"),
                ListenerChatMessage(role: .user, content: "and the second part"),
            ],
            tier: .reflection,
            maxTokens: 128
        )
    }

    // ── /v1/listener ──

    func testRespondSendsListenerRequestShape() async throws {
        MockURLProtocol.stub(status: 200, body: #"{ "text": "keep going" }"#)

        _ = try await makeClient().respond(to: makeListenerRequest())

        let sent = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(sent.request.url?.path, "/v1/listener")
        XCTAssertEqual(sent.request.httpMethod, "POST")
        XCTAssertEqual(
            sent.request.value(forHTTPHeaderField: "Authorization"),
            "Bearer tok-123"
        )
        let body = try XCTUnwrap(sent.bodyJSON)
        XCTAssertEqual(body["system"] as? String, "be quiet mostly")
        XCTAssertEqual(body["maxTokens"] as? Int, 128)
        XCTAssertEqual(body["tier"] as? String, "reflection")
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages, [
            ["role": "user", "content": "so here is my idea"],
            ["role": "assistant", "content": "mm"],
            ["role": "user", "content": "and the second part"],
        ])
    }

    func testRespondSendsQuestionTierString() async throws {
        MockURLProtocol.stub(status: 200, body: #"{ "text": "" }"#)
        let request = ListenerRequest(
            system: "s",
            messages: [ListenerChatMessage(role: .user, content: "hm?")],
            tier: .question,
            maxTokens: 64
        )

        _ = try await makeClient().respond(to: request)

        let body = try XCTUnwrap(MockURLProtocol.lastRequest?.bodyJSON)
        XCTAssertEqual(body["tier"] as? String, "question")
        XCTAssertEqual(body["maxTokens"] as? Int, 64)
    }

    func testRespondParsesTextAndTrims() async throws {
        MockURLProtocol.stub(status: 200, body: #"{ "text": "  what happened next?\n" }"#)

        let text = try await makeClient().respond(to: makeListenerRequest())

        XCTAssertEqual(text, "what happened next?")
    }

    func testRespondEmptyTextIsValidSilence() async throws {
        MockURLProtocol.stub(status: 200, body: #"{ "text": "" }"#)

        let text = try await makeClient().respond(to: makeListenerRequest())

        XCTAssertEqual(text, "")
    }

    // ── /v1/coverage ──

    func testCheckCoverageSendsTranscriptAndCriterionTopics() async throws {
        MockURLProtocol.stub(status: 200, body: """
        { "topics": [], "nudge": "" }
        """)

        _ = try await makeClient().checkCoverage(
            transcript: "we talked pricing at length",
            criteria: [CoverageCriterion(topic: "pricing"), CoverageCriterion(topic: "the ask")]
        )

        let sent = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(sent.request.url?.path, "/v1/coverage")
        XCTAssertEqual(sent.request.httpMethod, "POST")
        XCTAssertEqual(
            sent.request.value(forHTTPHeaderField: "Authorization"),
            "Bearer tok-123"
        )
        let body = try XCTUnwrap(sent.bodyJSON)
        XCTAssertEqual(body["transcript"] as? String, "we talked pricing at length")
        XCTAssertEqual(body["criteria"] as? [String], ["pricing", "the ask"])
        XCTAssertEqual(body.count, 2)
    }

    func testCheckCoverageDecodesCoverageResult() async throws {
        MockURLProtocol.stub(status: 200, body: """
        {
          "topics": [
            { "topic": "pricing", "covered": true, "evidence": "we talked pricing at length" },
            { "topic": "the ask", "covered": false, "evidence": "" }
          ],
          "nudge": "You haven't made the ask yet."
        }
        """)

        let result = try await makeClient().checkCoverage(
            transcript: "t",
            criteria: [CoverageCriterion(topic: "pricing"), CoverageCriterion(topic: "the ask")]
        )

        XCTAssertEqual(result.topics.count, 2)
        XCTAssertEqual(result.topics[0].topic, "pricing")
        XCTAssertTrue(result.topics[0].covered)
        XCTAssertEqual(result.topics[0].evidence, "we talked pricing at length")
        XCTAssertEqual(result.topics[1].topic, "the ask")
        XCTAssertFalse(result.topics[1].covered)
        XCTAssertEqual(result.topics[1].evidence, "")
        XCTAssertEqual(result.nudge, "You haven't made the ask yet.")
    }

    // ── error mapping ──

    private func respondError(status: Int, body: String) async -> ProxyError? {
        MockURLProtocol.stub(status: status, body: body)
        do {
            _ = try await makeClient().respond(to: makeListenerRequest())
            XCTFail("expected a ProxyError for status \(status)")
            return nil
        } catch let error as ProxyError {
            return error
        } catch {
            XCTFail("expected ProxyError, got \(error)")
            return nil
        }
    }

    func test401MapsToUnauthorized() async {
        let error = await respondError(status: 401, body: """
        { "error": { "type": "unauthorized", "message": "token expired" } }
        """)
        XCTAssertEqual(error, .unauthorized)
    }

    func test429MapsToQuotaExceededWithEnvelopeMessage() async {
        let error = await respondError(status: 429, body: """
        { "error": { "type": "quota_exceeded", "message": "daily model-call limit reached" } }
        """)
        XCTAssertEqual(error, .quotaExceeded("daily model-call limit reached"))
        XCTAssertEqual(error?.errorDescription, "daily model-call limit reached")
    }

    func test400MapsToInvalidRequestWithEnvelopeMessage() async {
        let error = await respondError(status: 400, body: """
        { "error": { "type": "invalid_request", "message": "maxTokens over cap" } }
        """)
        XCTAssertEqual(error, .invalidRequest("maxTokens over cap"))
    }

    func test502MapsToUpstreamWithEnvelopeMessage() async {
        let error = await respondError(status: 502, body: """
        { "error": { "type": "upstream_error", "message": "the model declined this request" } }
        """)
        XCTAssertEqual(error, .upstream("the model declined this request"))
    }

    func test500WithUnparseableBodyFallsBackToRawText() async {
        let error = await respondError(status: 500, body: "gateway exploded")
        XCTAssertEqual(error, .upstream("gateway exploded"))
    }

    func test503WithEmptyBodyMapsToUpstreamAndStaysActionable() async {
        let error = await respondError(status: 503, body: "")
        XCTAssertEqual(error, .upstream(""))
        XCTAssertEqual(
            error?.errorDescription,
            "The server could not reach the model — try again in a moment."
        )
    }

    func testTransportFailureMapsToTransport() async {
        MockURLProtocol.stub(error: URLError(.notConnectedToInternet))
        do {
            _ = try await makeClient().respond(to: makeListenerRequest())
            XCTFail("expected ProxyError.transport")
        } catch let error as ProxyError {
            guard case .transport = error else {
                return XCTFail("expected .transport, got \(error)")
            }
        } catch {
            XCTFail("expected ProxyError, got \(error)")
        }
    }

    func testMalformedListenerBodyMapsToDecoding() async {
        MockURLProtocol.stub(status: 200, body: "not json at all")
        do {
            _ = try await makeClient().respond(to: makeListenerRequest())
            XCTFail("expected ProxyError.decoding")
        } catch let error as ProxyError {
            guard case .decoding = error else {
                return XCTFail("expected .decoding, got \(error)")
            }
        } catch {
            XCTFail("expected ProxyError, got \(error)")
        }
    }

    func testMalformedCoverageBodyMapsToDecoding() async {
        MockURLProtocol.stub(status: 200, body: #"{ "topics": "wrong shape" }"#)
        do {
            _ = try await makeClient().checkCoverage(
                transcript: "t",
                criteria: [CoverageCriterion(topic: "pricing")]
            )
            XCTFail("expected ProxyError.decoding")
        } catch let error as ProxyError {
            guard case .decoding = error else {
                return XCTFail("expected .decoding, got \(error)")
            }
        } catch {
            XCTFail("expected ProxyError, got \(error)")
        }
    }
}
