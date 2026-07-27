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
}
