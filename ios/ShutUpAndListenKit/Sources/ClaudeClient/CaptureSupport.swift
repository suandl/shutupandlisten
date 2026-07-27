// CI visual-capture seam logic (design: 2026-07-27-ios-visual-capture-ci).
//
// PURE and platform-agnostic so it gets real `swift test` coverage in the
// devcontainer. The App layer (CaptureURLProtocol / CaptureSeam) is a thin
// glue over these three pieces; nothing here does I/O.

import Foundation
import TurnEngine

/// Which hosts the capture stub replaces with canned replies. Everything else
/// — notably Apple's speech-recognition endpoints — passes through untouched so
/// the real SpeechTranscriber still works.
public enum CaptureHosts {
    /// Hosts (and their subdomains) intercepted during a capture run.
    public static let intercepted: Set<String> = [
        "api.anthropic.com",
        "api.shutupandlisten.sh",
    ]

    /// True when `url`'s host equals — or is a subdomain of — an intercepted host.
    public static func shouldIntercept(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased() else { return false }
        return intercepted.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

/// The canned data the capture stub replays. `analystCandidates` reuses
/// TurnEngine's wire type so the analyst JSON round-trips through the real
/// `AnalystResult` decoder. `seedTranscript` drives the optional in-app replay
/// fallback (design §reliability) — display only, never the network.
public struct CaptureFixture: Codable, Equatable, Sendable {
    public var listenerReplies: [String]
    public var analystCandidates: [AnalystCandidate]
    public var seedTranscript: [String]

    public init(
        listenerReplies: [String],
        analystCandidates: [AnalystCandidate],
        seedTranscript: [String]
    ) {
        self.listenerReplies = listenerReplies
        self.analystCandidates = analystCandidates
        self.seedTranscript = seedTranscript
    }

    public static func decode(from data: Data) throws -> CaptureFixture {
        try JSONDecoder().decode(CaptureFixture.self, from: data)
    }
}

/// Builds the canned Messages-API response the stub returns, and classifies
/// requests. Kept here (not in the URLProtocol) so it is `swift test`-covered.
public enum CaptureResponder {
    /// A request is "structured" (analyst/coverage) when its JSON body carries
    /// an `output_config`. The capture flow only ever fires the analyst, so the
    /// stub treats every structured request as an analyst request.
    public static func isStructuredRequest(body: Data?) -> Bool {
        guard let body,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return false }
        return json["output_config"] != nil
    }

    /// The response body for an intercepted request. `isAnalyst` → a JSON
    /// `AnalystResult` as the text block; otherwise the `callIndex`-th listener
    /// reply (empty string past the end = the model choosing silence).
    public static func responseData(fixture: CaptureFixture, isAnalyst: Bool, callIndex: Int) -> Data {
        let text: String
        if isAnalyst {
            let result = AnalystResult(candidates: fixture.analystCandidates)
            let encoded = (try? JSONEncoder().encode(result)) ?? Data()
            text = String(data: encoded, encoding: .utf8) ?? ""
        } else if callIndex >= 0, callIndex < fixture.listenerReplies.count {
            text = fixture.listenerReplies[callIndex]
        } else {
            text = ""
        }

        let envelope: [String: Any] = [
            "id": "msg_capture",
            "type": "message",
            "role": "assistant",
            "stop_reason": "end_turn",
            "content": [["type": "text", "text": text]],
            "usage": [
                "input_tokens": 120,
                "output_tokens": 24,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            ],
        ]
        // The keys above are static and JSON-safe, so serialization cannot fail;
        // fall back to an empty object rather than force-unwrap.
        return (try? JSONSerialization.data(withJSONObject: envelope)) ?? Data("{}".utf8)
    }
}
