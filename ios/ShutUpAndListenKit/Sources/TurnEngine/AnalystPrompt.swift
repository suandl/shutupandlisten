// The ambient analyst prompt (spec §2): one background understanding of the
// WHOLE conversation, from which a small ranked pool of candidate
// interjections is produced. Reprocessing the whole transcript each cycle is
// the simplest correct thing; it stays cheap because the transcript is a stable
// growing prefix, marked with a cache_control breakpoint (Plan A's
// `cachedSystemPrefix`). The volatile "produce candidates now" instruction sits
// AFTER the breakpoint so the cached prefix never shifts.
//
// PURE prompt construction only — the network call lives in ClaudeClient
// (`analyze`), which enforces the schema via the Messages API structured
// outputs, so the candidate list is machine-parseable without text scraping.

import Foundation

/// One analyst-proposed interjection. `register` is "reflection" | "question";
/// `anchor` is the specific phrase it is built on (for the analyst's own
/// grounding — the host keys freshness on transcript position, not this).
public struct AnalystCandidate: Codable, Equatable, Sendable {
    public let text: String
    public let register: String
    public let anchor: String

    public init(text: String, register: String, anchor: String) {
        self.text = text
        self.register = register
        self.anchor = anchor
    }
}

public struct AnalystResult: Codable, Equatable, Sendable {
    public let candidates: [AnalystCandidate]

    public init(candidates: [AnalystCandidate]) {
        self.candidates = candidates
    }
}

/// The model request for one analyst cycle. `cachedSystemPrefix` is a true
/// prefix of `system` (Plan A's `systemField` splits it into a cached block +
/// a volatile block). `messages` carries the single required user turn.
public struct AnalystRequest: Sendable {
    public let system: String
    public let cachedSystemPrefix: String?
    public let messages: [ListenerChatMessage]
    public let maxTokens: Int

    public init(
        system: String,
        cachedSystemPrefix: String?,
        messages: [ListenerChatMessage],
        maxTokens: Int
    ) {
        self.system = system
        self.cachedSystemPrefix = cachedSystemPrefix
        self.messages = messages
        self.maxTokens = maxTokens
    }
}

public enum Analyst {
    /// The stable analyst role. Kept register-consistent with the listener's own
    /// role (prompts/claude.md): anchored to specifics, development not therapy,
    /// at most one question, most turns nothing.
    public static let instructions = """
    You maintain a running understanding of a person dictating an idea out loud, \
    and you keep a short list of ready-to-speak interjections a quiet listener \
    could offer IF a natural pause arrives. You never decide when to speak — you \
    only keep the options fresh.

    From the whole transcript so far, propose up to three candidate interjections, \
    best first. Each must be:
    * short — a single sentence;
    * anchored to something specific the thinker actually said (a concrete claim, \
      mechanism, example, or tension) — never a generic prompt that could follow \
      any idea;
    * tagged by register: "reflection" (a brief, momentum-preserving observation \
      that nudges the thought a little further) or "question" (exactly one \
      specific, idea-developing follow-up).

    Do idea development, not emotional processing: no advice, coaching, summary, \
    or reframing. If nothing specific is worth offering yet, return an empty list \
    — a cold pool is a valid, correct state.
    """

    /// The volatile instruction — placed AFTER the cache breakpoint so the
    /// cached prefix stays byte-identical across cycles.
    public static let volatileInstruction =
        "Produce the candidate interjections for the conversation exactly as it stands right now."

    /// Structured-outputs schema (`output_config.format`) guaranteeing
    /// `AnalystResult` parses.
    public static let resultSchema: [String: Any] = [
        "type": "object",
        "properties": [
            "candidates": [
                "type": "array",
                "items": [
                    "type": "object",
                    "properties": [
                        "text": ["type": "string"],
                        "register": ["type": "string", "enum": ["reflection", "question"]],
                        "anchor": ["type": "string"],
                    ],
                    "required": ["text", "register", "anchor"],
                    "additionalProperties": false,
                ],
            ],
        ],
        "required": ["candidates"],
        "additionalProperties": false,
    ]

    /// The stable, cacheable prefix: instructions + the whole transcript.
    public static func systemPrefix(transcript: String) -> String {
        instructions + "\n\nTRANSCRIPT SO FAR:\n"
            + (transcript.isEmpty ? "(nothing transcribed yet)" : transcript)
    }

    /// Build one analyst cycle's request. `system` = the cacheable prefix, then
    /// the volatile instruction; `cachedSystemPrefix` marks the breakpoint.
    public static func buildRequest(transcript: String, maxTokens: Int = 512) -> AnalystRequest {
        let prefix = systemPrefix(transcript: transcript)
        return AnalystRequest(
            system: prefix + "\n\n" + volatileInstruction,
            cachedSystemPrefix: prefix,
            messages: [ListenerChatMessage(role: .user, content: volatileInstruction)],
            maxTokens: maxTokens
        )
    }
}
