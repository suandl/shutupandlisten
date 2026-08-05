// The ambient analyst prompt (spec §2): one background understanding of the
// WHOLE conversation, from which a small ranked pool of candidate
// interjections is produced. Reprocessing the whole transcript each cycle is
// the simplest correct thing; it stays cheap because the transcript is sent as
// an APPEND-ONLY SEQUENCE of system blocks with the cache_control breakpoint on
// the last frozen chunk.
//
// Why chunks and not one big cached block: a prompt-cache hit requires the
// block sequence to be byte-identical up to the breakpoint, and the analyst
// cadence only fires once NEW transcript has arrived — so a single block
// holding the whole transcript differs every cycle. It would pay cache-WRITE
// pricing (1.25× input) on the entire transcript forever and never earn a read,
// which is strictly worse than sending it uncached. Splitting the transcript at
// FIXED 4000-character boundaries freezes everything before the last boundary:
// those blocks stay byte-identical across cycles, so each cycle reads them back
// at ~0.1× and writes at most one newly-completed chunk. Most cycles complete
// no chunk at all and are a pure read.
//
// The boundary is fixed-size and counted in characters — not sentence- or
// turn-aligned — precisely because it must not move when the transcript grows.
// 4000 characters is roughly 1000 tokens, so the first breakpoint (instructions
// + one chunk) clears Opus 4.8's ~1024-token minimum cacheable prefix. Below
// that minimum the breakpoint is silently a no-op — no write, no read — which
// is fine: a transcript that short is cheap either way.
//
// Caveat — tail revision: live speech partials mean the last few characters of
// the transcript can still be rewritten between cycles. That normally touches
// only the remainder block, which sits AFTER the breakpoint and is never
// cached. A revision that reaches back across an already-completed 4000-char
// boundary costs one re-write of that chunk and everything after it — a one-off
// cost, not a permanent loss of caching.
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

/// One block of the analyst's `system` field. `cached: true` means "this block
/// ENDS the cacheable prefix" — it is where the cache_control breakpoint goes,
/// not a claim that the block alone is cached. Exactly one block in a request
/// carries it.
public struct SystemBlock: Sendable, Equatable {
    public let text: String
    public let cached: Bool

    public init(text: String, cached: Bool = false) {
        self.text = text
        self.cached = cached
    }
}

/// The model request for one analyst cycle. `systemBlocks` is the ordered
/// system field — instructions, then the frozen transcript chunks, then the
/// live remainder plus the volatile instruction — with the cache breakpoint
/// flagged on one block. `messages` carries the single required user turn.
public struct AnalystRequest: Sendable {
    public let systemBlocks: [SystemBlock]
    public let messages: [ListenerChatMessage]
    public let maxTokens: Int
    /// The raw transcript this request was built from. The BYOK path ignores it
    /// (it sends the pre-built `systemBlocks`); the proxy path forwards it so the
    /// server rebuilds the identical cache-friendly block layout on its side —
    /// see server/API.md `POST /v1/analyst`. Defaulted so existing constructions
    /// keep compiling.
    public let transcript: String

    public init(
        systemBlocks: [SystemBlock],
        messages: [ListenerChatMessage],
        maxTokens: Int,
        transcript: String = ""
    ) {
        self.systemBlocks = systemBlocks
        self.messages = messages
        self.maxTokens = maxTokens
        self.transcript = transcript
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

    /// The volatile instruction — placed in the final block, AFTER the cache
    /// breakpoint, so it never disturbs the frozen chunks ahead of it.
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

    /// Characters per frozen transcript chunk. Fixed and character-counted so a
    /// boundary, once crossed, never moves again — that is what makes earlier
    /// chunks byte-identical from one cycle to the next.
    public static let transcriptChunkSize = 4000

    /// The leading block: the stable role, then the transcript header. Carries
    /// the breakpoint itself only while the transcript is shorter than one chunk.
    public static let transcriptHeader = Analyst.instructions + "\n\nTRANSCRIPT SO FAR:\n"

    /// Build one analyst cycle's request as an append-only block sequence:
    /// `[instructions] + [one block per full chunk] + [remainder + volatile]`,
    /// with the breakpoint on the last full chunk (or on the instructions block
    /// when the transcript is shorter than one chunk).
    public static func buildRequest(transcript: String, maxTokens: Int = 512) -> AnalystRequest {
        let body = transcript.isEmpty ? "(nothing transcribed yet)" : transcript

        // Split at fixed character offsets: full chunks first, whatever is left
        // over stays in the trailing volatile block.
        var chunks: [String] = []
        var cursor = body.startIndex
        var remaining = body.count
        while remaining >= transcriptChunkSize {
            let end = body.index(cursor, offsetBy: transcriptChunkSize)
            chunks.append(String(body[cursor..<end]))
            cursor = end
            remaining -= transcriptChunkSize
        }
        let remainder = String(body[cursor...])

        var blocks = [SystemBlock(text: transcriptHeader, cached: chunks.isEmpty)]
        for (i, chunk) in chunks.enumerated() {
            blocks.append(SystemBlock(text: chunk, cached: i == chunks.count - 1))
        }
        blocks.append(SystemBlock(text: remainder + "\n\n" + volatileInstruction))

        return AnalystRequest(
            systemBlocks: blocks,
            messages: [ListenerChatMessage(role: .user, content: volatileInstruction)],
            maxTokens: maxTokens,
            transcript: transcript
        )
    }
}
