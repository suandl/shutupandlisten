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
