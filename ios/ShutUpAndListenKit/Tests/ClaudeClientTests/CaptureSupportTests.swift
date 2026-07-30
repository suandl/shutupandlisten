// Unit tests for the CI visual-capture seam logic that lives in the Kit:
// which hosts the stub intercepts, the canned-fixture shape, and the
// Messages-API response envelope the stub replays. Pure — no network.

import XCTest
import ClaudeClient
import TurnEngine

final class CaptureSupportTests: XCTestCase {
    // ── CaptureHosts ──

    func testInterceptsClaudeAndProxyHosts() {
        XCTAssertTrue(CaptureHosts.shouldIntercept(URL(string: "https://api.anthropic.com/v1/messages")))
        XCTAssertTrue(CaptureHosts.shouldIntercept(URL(string: "https://api.shutupandlisten.sh/v1/listener")))
    }

    func testInterceptsSubdomainsOfInterceptedHosts() {
        XCTAssertTrue(CaptureHosts.shouldIntercept(URL(string: "https://edge.api.anthropic.com/v1/messages")))
    }

    func testPassesThroughAppleSpeechAndNilHosts() {
        XCTAssertFalse(CaptureHosts.shouldIntercept(URL(string: "https://guzzoni.apple.com/recognize")))
        XCTAssertFalse(CaptureHosts.shouldIntercept(nil))
    }

    func testDoesNotInterceptLookalikeHosts() {
        // The dot-boundary check must reject hosts that merely end with the
        // intercepted string but are not it or a subdomain of it.
        XCTAssertFalse(CaptureHosts.shouldIntercept(URL(string: "https://evilapi.anthropic.com/v1/messages")))
        XCTAssertFalse(CaptureHosts.shouldIntercept(URL(string: "https://api.anthropic.com.evil.com/v1/messages")))
    }

    func testInterceptIsCaseInsensitive() {
        XCTAssertTrue(CaptureHosts.shouldIntercept(URL(string: "https://API.ANTHROPIC.COM/v1/messages")))
    }

    // ── CaptureFlags ──

    func testInjectAudioRequiresBothFlags() {
        // -captureInjectAudio alone does nothing without the master capture flag.
        XCTAssertFalse(CaptureFlags.shouldInjectAudio(["-captureInjectAudio"]))
        XCTAssertTrue(CaptureFlags.shouldInjectAudio(["-uiTestCapture", "-captureInjectAudio"]))
    }

    func testCaptureActiveNeedsMasterFlag() {
        XCTAssertTrue(CaptureFlags.isActive(["-uiTestCapture"]))
        XCTAssertFalse(CaptureFlags.isActive(["-captureInjectAudio"]))
        XCTAssertFalse(CaptureFlags.isActive([]))
    }

    func testSeedTranscriptRequiresBothFlags() {
        // The seed paint is a display-only fallback WITHIN a capture run, not a
        // standalone mode — matching -captureInjectAudio. -captureSeedTranscript
        // alone is inert: it would otherwise paint from an empty fixture (the
        // seam's installIfNeeded, which loads the fixture, never runs without
        // the master flag), and in Release the whole seam is compiled out.
        XCTAssertFalse(CaptureFlags.shouldSeedTranscript(["-captureSeedTranscript"]))
        XCTAssertTrue(CaptureFlags.shouldSeedTranscript(["-uiTestCapture", "-captureSeedTranscript"]))
        XCTAssertFalse(CaptureFlags.shouldSeedTranscript(["-uiTestCapture"]))
    }

    // ── CaptureFixture ──

    func testDecodesFixtureShape() throws {
        let json = """
        {
          "listenerReplies": ["hi there"],
          "analystCandidates": [
            { "text": "Which step could you defer?", "register": "question", "anchor": "config" }
          ],
          "seedTranscript": ["one", "two"]
        }
        """
        let fixture = try CaptureFixture.decode(from: Data(json.utf8))
        XCTAssertEqual(fixture.listenerReplies, ["hi there"])
        XCTAssertEqual(fixture.seedTranscript, ["one", "two"])
        XCTAssertEqual(fixture.analystCandidates.first?.register, "question")
        XCTAssertEqual(fixture.analystCandidates.first?.text, "Which step could you defer?")
    }

    // ── CaptureResponder ──

    func testDetectsStructuredRequestByOutputConfig() {
        let analyst = Data(#"{"model":"m","output_config":{"format":{}}}"#.utf8)
        let listener = Data(#"{"model":"m","messages":[]}"#.utf8)
        XCTAssertTrue(CaptureResponder.isStructuredRequest(body: analyst))
        XCTAssertFalse(CaptureResponder.isStructuredRequest(body: listener))
        XCTAssertFalse(CaptureResponder.isStructuredRequest(body: nil))
    }

    func testListenerResponseCarriesNthReply() throws {
        let fixture = CaptureFixture(
            listenerReplies: ["first", "second"], analystCandidates: [], seedTranscript: []
        )
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: false, callIndex: 1)
        XCTAssertEqual(try Self.text(in: data), "second")
    }

    func testListenerResponsePastEndIsSilence() throws {
        let fixture = CaptureFixture(
            listenerReplies: ["only"], analystCandidates: [], seedTranscript: []
        )
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: false, callIndex: 5)
        XCTAssertEqual(try Self.text(in: data), "")
    }

    func testAnalystResponseDecodesToAnalystResult() throws {
        let fixture = CaptureFixture(
            listenerReplies: [],
            analystCandidates: [AnalystCandidate(text: "q?", register: "question", anchor: "a")],
            seedTranscript: []
        )
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: true, callIndex: 0)
        let text = try Self.text(in: data)
        let result = try JSONDecoder().decode(AnalystResult.self, from: Data(text.utf8))
        XCTAssertEqual(result.candidates.first?.text, "q?")
    }

    func testListenerEnvelopeDecodesInClaudeClient() async throws {
        // Round-trip through the REAL ClaudeClient decode path (not just
        // JSONSerialization key checks) so a future rename of
        // MessagesResponse.CodingKeys fails this test.
        let fixture = CaptureFixture(listenerReplies: ["ok"], analystCandidates: [], seedTranscript: [])
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: false, callIndex: 0)
        MockURLProtocol.stub(status: 200, body: try XCTUnwrap(String(data: data, encoding: .utf8)))

        let client = ClaudeClient(config: ClaudeConfig(apiKey: "sk-test"), session: MockURLProtocol.makeSession())
        let request = ListenerRequest(
            system: "be quiet mostly",
            messages: [ListenerChatMessage(role: .user, content: "so here is my idea")],
            tier: .reflection,
            maxTokens: 128
        )
        let reply = try await client.respondWithUsage(to: request)

        XCTAssertEqual(reply.text, "ok")
        XCTAssertEqual(reply.usage?.inputTokens, 120)
    }

    func testAnalystEnvelopeDecodesInClaudeClient() async throws {
        let fixture = CaptureFixture(
            listenerReplies: [],
            analystCandidates: [AnalystCandidate(text: "q?", register: "question", anchor: "a")],
            seedTranscript: []
        )
        let data = CaptureResponder.responseData(fixture: fixture, isAnalyst: true, callIndex: 0)
        MockURLProtocol.stub(status: 200, body: try XCTUnwrap(String(data: data, encoding: .utf8)))

        let client = ClaudeClient(config: ClaudeConfig(apiKey: "sk-test"), session: MockURLProtocol.makeSession())
        let reply = try await client.analyze(Analyst.buildRequest(transcript: "a transcript"))

        XCTAssertEqual(reply.result.candidates.first?.text, "q?")
    }

    /// Pull the first content block's text out of a Messages-API envelope.
    private static func text(in data: Data) throws -> String {
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let content = try XCTUnwrap(json["content"] as? [[String: Any]])
        return try XCTUnwrap(content.first?["text"] as? String)
    }
}
