// A URLProtocol stub for the proxy-client tests: registered on an ephemeral
// URLSessionConfiguration, it captures every outgoing request (method, URL,
// headers, JSON body) and answers with a canned status + body — no network.

import Foundation
import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class MockURLProtocol: URLProtocol {
    struct CapturedRequest {
        let request: URLRequest
        let body: Data?

        var bodyJSON: [String: Any]? {
            body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
    }

    // Static because URLProtocol instances are created by the loading system.
    // Tests run serially, and every test calls `stub` first, so this is safe.
    static var responseStatus = 200
    static var responseBody = Data()
    static var responseError: Error?
    static var captured: [CapturedRequest] = []

    static func stub(status: Int, body: String) {
        responseStatus = status
        responseBody = Data(body.utf8)
        responseError = nil
        captured = []
    }

    static func stub(error: Error) {
        responseError = error
        captured = []
    }

    static var lastRequest: CapturedRequest? { captured.last }

    /// A URLSession routed entirely through this protocol.
    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // The loading system may have converted httpBody into a stream.
        let body = request.httpBody ?? Self.drain(request.httpBodyStream)
        Self.captured.append(CapturedRequest(request: request, body: body))

        if let error = Self.responseError {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.responseStatus,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
