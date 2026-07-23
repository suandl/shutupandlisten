// AccountClient — the Sign in with Apple exchange against server/API.md:
// request shape (path, method, body), ProxySession parsing including the
// ISO 8601 expiresAt, and the 401 → unauthorized mapping.

import XCTest
import ClaudeClient
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class AccountClientTests: XCTestCase {
    private func makeClient() -> AccountClient {
        AccountClient(
            config: ProxyConfig(baseURL: URL(string: "https://proxy.test")!),
            session: MockURLProtocol.makeSession()
        )
    }

    func testExchangeSendsIdentityTokenToAuthApple() async throws {
        MockURLProtocol.stub(status: 200, body: """
        { "sessionToken": "sess-1", "userId": "apple-sub-9", "expiresAt": "2026-08-22T12:34:56Z" }
        """)

        _ = try await makeClient().exchangeAppleIdentityToken("apple-jwt-abc")

        let sent = try XCTUnwrap(MockURLProtocol.lastRequest)
        XCTAssertEqual(sent.request.url?.path, "/v1/auth/apple")
        XCTAssertEqual(sent.request.httpMethod, "POST")
        XCTAssertEqual(
            sent.request.value(forHTTPHeaderField: "Content-Type"),
            "application/json"
        )
        XCTAssertNil(sent.request.value(forHTTPHeaderField: "Authorization"))
        let body = try XCTUnwrap(sent.bodyJSON)
        XCTAssertEqual(body["identityToken"] as? String, "apple-jwt-abc")
        XCTAssertEqual(body.count, 1, "auth body should carry exactly the identity token")
    }

    func testExchangeParsesSessionWithISO8601Expiry() async throws {
        MockURLProtocol.stub(status: 200, body: """
        { "sessionToken": "sess-1", "userId": "apple-sub-9", "expiresAt": "2026-08-22T12:34:56Z" }
        """)

        let session = try await makeClient().exchangeAppleIdentityToken("t")

        XCTAssertEqual(session.sessionToken, "sess-1")
        XCTAssertEqual(session.userId, "apple-sub-9")
        let formatter = ISO8601DateFormatter()
        XCTAssertEqual(session.expiresAt, formatter.date(from: "2026-08-22T12:34:56Z"))
    }

    func testExchangeParsesFractionalSecondExpiry() async throws {
        MockURLProtocol.stub(status: 200, body: """
        { "sessionToken": "s", "userId": "u", "expiresAt": "2026-08-22T12:34:56.789Z" }
        """)

        let session = try await makeClient().exchangeAppleIdentityToken("t")

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertEqual(session.expiresAt, formatter.date(from: "2026-08-22T12:34:56.789Z"))
    }

    func testExchangeMissingExpiryDecodesAsNil() async throws {
        MockURLProtocol.stub(status: 200, body: """
        { "sessionToken": "s", "userId": "u" }
        """)

        let session = try await makeClient().exchangeAppleIdentityToken("t")

        XCTAssertNil(session.expiresAt)
        XCTAssertEqual(session.sessionToken, "s")
    }

    func testExchangeUnparseableExpiryDecodesAsNil() async throws {
        MockURLProtocol.stub(status: 200, body: """
        { "sessionToken": "s", "userId": "u", "expiresAt": "sometime next month" }
        """)

        let session = try await makeClient().exchangeAppleIdentityToken("t")

        XCTAssertNil(session.expiresAt)
    }

    func testExchangeBadIdentityTokenMapsToUnauthorized() async {
        MockURLProtocol.stub(status: 401, body: """
        { "error": { "type": "unauthorized", "message": "identity token expired" } }
        """)

        do {
            _ = try await makeClient().exchangeAppleIdentityToken("stale")
            XCTFail("expected ProxyError.unauthorized")
        } catch let error as ProxyError {
            XCTAssertEqual(error, .unauthorized)
            XCTAssertEqual(error.errorDescription, "Your session expired — sign in again.")
        } catch {
            XCTFail("expected ProxyError, got \(error)")
        }
    }

    func testExchangeMalformedSuccessBodyMapsToDecoding() async {
        MockURLProtocol.stub(status: 200, body: #"{ "unexpected": true }"#)

        do {
            _ = try await makeClient().exchangeAppleIdentityToken("t")
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
