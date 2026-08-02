// The CI-only network stub. Registered by CaptureSeam (only under
// -uiTestCapture); intercepts exactly the Claude/proxy hosts and replays canned
// replies from the bundled fixture, so listener/analyst REPLIES are
// deterministic even though real speech transcription is not. Every other host
// (Apple speech) passes through untouched. All decision logic lives in the Kit
// (CaptureHosts / CaptureResponder); this class is thin glue.
//
// DEBUG-only: `#if DEBUG`-guarded and excluded from the app target's Release
// build phase, so this network-interception URLProtocol never ships in a
// Release (App Store) binary (su-uzy9.1, f4).
#if DEBUG

import ClaudeClient
import Foundation

final class CaptureURLProtocol: URLProtocol {
    /// The canned data, installed once by `CaptureSeam` before any request.
    nonisolated(unsafe) static var fixture = CaptureFixture(
        listenerReplies: [], analystCandidates: [], seedTranscript: []
    )

    // Listener replies are walked in order across the run. A fresh app process
    // per launch resets this; the lock guards the simulator's concurrent calls.
    nonisolated(unsafe) private static var listenerCallIndex = 0
    private static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool {
        CaptureSeam.isActive && CaptureHosts.shouldIntercept(request.url)
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // The loading system may have converted httpBody into a stream.
        let body = request.httpBody ?? Self.drain(request.httpBodyStream)
        // Analyst and coverage both send structured requests but decode
        // different shapes, so the stub answers each in its own (see
        // CaptureResponder.classify). Only listener turns walk the reply list.
        let kind = CaptureResponder.classify(body: body)

        let index: Int = {
            guard kind == .listener else { return 0 }
            Self.lock.lock(); defer { Self.lock.unlock() }
            let i = Self.listenerCallIndex
            Self.listenerCallIndex += 1
            return i
        }()

        let data = CaptureResponder.responseData(
            fixture: Self.fixture, kind: kind, callIndex: index
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

#endif
