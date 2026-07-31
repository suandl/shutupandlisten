// CI visual-capture seam logic (design: 2026-07-27-ios-visual-capture-ci).
//
// PURE and platform-agnostic so it gets real `swift test` coverage in the
// devcontainer. The App layer (CaptureURLProtocol / CaptureSeam) is a thin
// glue over these three pieces; nothing here does I/O.

import Foundation
import TurnEngine

/// The capture launch flags and how they compose. Pure so the App's thin
/// `CaptureSeam` wrapper is `swift test`-covered here rather than only in the
/// Xcode target. `injectAudio` supersedes `seedTranscript` as the primary
/// driver but the two coexist as a fallback chain (design §Reliability).
public enum CaptureFlags {
    /// Arms the whole capture seam (auth bypass, network stub, permission skip).
    public static let capture = "-uiTestCapture"
    /// Drives the real pipeline from the bundled fixture `.wav`. Requires `capture`.
    public static let injectAudio = "-captureInjectAudio"
    /// Display-only fixture paint — the last-resort fallback.
    public static let seedTranscript = "-captureSeedTranscript"

    public static func isActive(_ args: [String]) -> Bool {
        args.contains(capture)
    }

    public static func shouldInjectAudio(_ args: [String]) -> Bool {
        args.contains(capture) && args.contains(injectAudio)
    }

    public static func shouldSeedTranscript(_ args: [String]) -> Bool {
        args.contains(capture) && args.contains(seedTranscript)
    }
}

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
    /// The canned answer to a coverage check. OPTIONAL — and last, so the
    /// bundled fixture JSON stays valid without it: a capture run that never
    /// opens coverage needs no fixture data, and the stub falls back to an
    /// empty-but-valid result rather than to the analyst's shape.
    public var coverageResult: CoverageResult?

    public init(
        listenerReplies: [String],
        analystCandidates: [AnalystCandidate],
        seedTranscript: [String],
        coverageResult: CoverageResult? = nil
    ) {
        self.listenerReplies = listenerReplies
        self.analystCandidates = analystCandidates
        self.seedTranscript = seedTranscript
        self.coverageResult = coverageResult
    }

    public static func decode(from data: Data) throws -> CaptureFixture {
        try JSONDecoder().decode(CaptureFixture.self, from: data)
    }
}

/// Which caller a captured request came from — and therefore which canned body
/// decodes cleanly on the other end.
public enum CaptureRequestKind: String, Equatable, Sendable {
    /// A plain listener turn: free text, no `output_config`.
    case listener
    /// One ambient analyst cycle — expects `AnalystResult` JSON.
    case analyst
    /// A coverage check — expects `CoverageResult` JSON.
    case coverage
}

/// Builds the canned Messages-API response the stub returns, and classifies
/// requests. Kept here (not in the URLProtocol) so it is `swift test`-covered.
public enum CaptureResponder {
    /// Which caller sent this request body.
    ///
    /// No `output_config` ⇒ a listener turn. Both structured callers set one,
    /// so they are told apart by the SCHEMA they asked the model to fill — the
    /// only part of the body that names the shape the caller will decode.
    /// Answering every structured request with analyst JSON (what this used to
    /// do) sent `AnalystResult` to `checkCoverage`, which then failed to decode.
    public static func classify(body: Data?) -> CaptureRequestKind {
        guard let body,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let outputConfig = json["output_config"] as? [String: Any]
        else { return .listener }

        let format = outputConfig["format"] as? [String: Any]
        let schema = format?["schema"] as? [String: Any]
        let properties = schema?["properties"] as? [String: Any]
        if properties?["candidates"] != nil { return .analyst }   // Analyst.resultSchema
        if properties?["topics"] != nil { return .coverage }      // Coverage.resultSchema
        // A structured schema neither of them owns. Falling back to the analyst
        // shape keeps the capture run moving; a genuinely new structured path
        // must add a case here (and its fixture data) or it will fail in its own
        // decoder — which is where such a miss belongs, and is loud.
        return .analyst
    }

    /// The response body for an intercepted request:
    /// - `.analyst` → the fixture's candidates as `AnalystResult` JSON;
    /// - `.coverage` → the fixture's coverage check as `CoverageResult` JSON,
    ///   or an empty but VALID result when the fixture scripted none;
    /// - `.listener` → the `callIndex`-th listener reply (empty string past the
    ///   end = the model choosing silence).
    public static func responseData(
        fixture: CaptureFixture,
        kind: CaptureRequestKind,
        callIndex: Int
    ) -> Data {
        let text: String
        switch kind {
        case .analyst:
            text = encodedJSON(AnalystResult(candidates: fixture.analystCandidates))
        case .coverage:
            text = encodedJSON(fixture.coverageResult ?? CoverageResult(topics: [], nudge: ""))
        case .listener:
            if callIndex >= 0, callIndex < fixture.listenerReplies.count {
                text = fixture.listenerReplies[callIndex]
            } else {
                text = ""
            }
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

    /// A structured result as the JSON text block the Messages API would carry.
    private static func encodedJSON(_ value: some Encodable) -> String {
        guard let encoded = try? JSONEncoder().encode(value) else { return "" }
        return String(data: encoded, encoding: .utf8) ?? ""
    }
}
