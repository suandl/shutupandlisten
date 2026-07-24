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
