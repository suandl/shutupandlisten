// Coverage mode — the first "broader deviation" beyond pure idea-dictation:
// evaluating the recording so far for completeness against a set of criteria
// (e.g. "make sure I covered pricing, the team, and the ask" before a pitch).
//
// Pure prompt construction only; the network call lives in ClaudeClient and the
// JSON schema enforcement uses the Messages API's structured outputs, so the
// result is machine-parseable without brittle text scraping.

import Foundation

public struct CoverageCriterion: Identifiable, Equatable, Codable, Sendable {
    public var id: String { topic }
    public let topic: String

    public init(topic: String) {
        self.topic = topic
    }
}

public struct CoverageResult: Codable, Equatable, Sendable {
    public struct TopicResult: Codable, Equatable, Sendable {
        public let topic: String
        public let covered: Bool
        /// A short quote or paraphrase of where it was covered; empty if not.
        public let evidence: String

        public init(topic: String, covered: Bool, evidence: String) {
            self.topic = topic
            self.covered = covered
            self.evidence = evidence
        }
    }

    public let topics: [TopicResult]
    /// One brief sentence pointing at the most important gap, phrased as a
    /// nudge to keep talking — or empty when everything is covered.
    public let nudge: String

    /// Public so callers outside this module can BUILD a result, not just
    /// decode one — the CI capture stub replays a canned coverage check.
    public init(topics: [TopicResult], nudge: String) {
        self.topics = topics
        self.nudge = nudge
    }
}

public enum Coverage {
    public static let systemPrompt = """
    You are a completeness checker for a live voice recording. The speaker is \
    dictating and has a checklist of topics they intend to cover. You are given \
    the transcript so far and the checklist. For each topic, decide whether the \
    transcript has substantively covered it — a passing mention does not count \
    unless it actually conveys the substance. Quote or closely paraphrase the \
    covering passage as evidence. Then, if anything is missing, write ONE brief \
    nudge (a single sentence) pointing at the most important gap, phrased so the \
    speaker can pick it up and keep talking — not a summary, not praise, not \
    more than one question. If everything is covered, the nudge is an empty string.
    """

    /// The JSON schema handed to the Messages API's structured outputs
    /// (`output_config.format`), guaranteeing `CoverageResult` parses.
    public static let resultSchema: [String: Any] = [
        "type": "object",
        "properties": [
            "topics": [
                "type": "array",
                "items": [
                    "type": "object",
                    "properties": [
                        "topic": ["type": "string"],
                        "covered": ["type": "boolean"],
                        "evidence": ["type": "string"],
                    ],
                    "required": ["topic", "covered", "evidence"],
                    "additionalProperties": false,
                ],
            ],
            "nudge": ["type": "string"],
        ],
        "required": ["topics", "nudge"],
        "additionalProperties": false,
    ]

    /// Parse a newline-separated checklist — the shape the Settings field
    /// stores and `CoveragePreset.criteriaText` produces — into criteria: one
    /// topic per line, whitespace-trimmed, blank lines dropped. Same logic the
    /// app applies to its stored checklist text, so presets and hand-typed
    /// checklists flow through one path.
    public static func parseCriteria(_ text: String) -> [CoverageCriterion] {
        text
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map(CoverageCriterion.init(topic:))
    }

    public static func userMessage(transcript: String, criteria: [CoverageCriterion]) -> String {
        let list = criteria.map { "- \($0.topic)" }.joined(separator: "\n")
        return """
        CHECKLIST:
        \(list)

        TRANSCRIPT SO FAR:
        \(transcript.isEmpty ? "(nothing transcribed yet)" : transcript)
        """
    }
}
