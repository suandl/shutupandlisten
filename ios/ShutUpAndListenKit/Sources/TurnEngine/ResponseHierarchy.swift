// The response-hierarchy gate — the pure escalate-slowly policy, ported from
// web/src/response-hierarchy.ts.
//
// The quiet-companion "response hierarchy" (CONCEPTS.md) is the listener's
// ordered default behaviour:
//
//     silence → minimal acknowledgment → short momentum-preserving reflection
//             → one brief follow-up question         ("escalate slowly")
//
// This implements the "reduced role" (CONCEPTS.md): the endpointing + RULES
// layer decides silence and acknowledgments with NO model call, and the model
// (Claude, via ClaudeClient) is invoked ONLY for the substantive tiers
// (reflection / question).
//
// PURE — no audio, no model, no I/O. `decideTier` is an (EvalContext) → decision
// reducer in the same discipline as TurnDetector, so the escalate-slowly policy
// is pinned by unit tests and only the *wording* of a substantive reply (never
// whether the listener over-steps) depends on the model.

import Foundation

// ── The four rungs of the response hierarchy, lowest → highest ──

/// A rung of the response hierarchy. `silence`/`acknowledge` are rules-only;
/// `reflection`/`question` call the model.
public enum Tier: String, Codable, CaseIterable, Sendable {
    case silence, acknowledge, reflection, question

    /// Rung height (0..3); higher = more involved / more escalated.
    public var rank: Int { Tier.allCases.firstIndex(of: self)! }

    /// True for the tiers that require the model (reflection / question).
    public var callsModel: Bool { rank >= Tier.reflection.rank }
}

// ── Gate configuration (defaults lifted from the web build) ──

/// Natural level-2 minimal acknowledgments, rotated per turn so a run of gated
/// turns never reads as one stuck token.
public let defaultAcks: [String] = ["mm", "yeah", "mhm", "right", "mm-hm"]

/// Word count at/above which a finished, non-question thinker turn counts as
/// "substantive" and escalates to the model.
public let defaultSubstantiveWords = 12

/// Minimum turns between two listener-initiated questions. Enforces "escalate
/// slowly; most pauses should not become questions" — a direct question FROM
/// the thinker bypasses it.
public let defaultQuestionCooldownTurns = 2

public struct GateConfig: Sendable {
    public var substantiveWords: Int
    public var acks: [String]
    public var questionCooldownTurns: Int
    public var completionThreshold: Double
    /// "Just listen" — questions off. Caps the hierarchy at the acknowledge
    /// rung for UNINVITED turns, so the model tiers (reflection/question) are
    /// unreachable no matter how substantive the turn or how long the cooldown
    /// has been elapsed. A direct question FROM the thinker still escalates
    /// (an invited question bypasses the cap), and the explicit pull-a-thread
    /// path never enters the gate at all — both invited routes survive.
    public var justListen: Bool

    public init(
        substantiveWords: Int = defaultSubstantiveWords,
        acks: [String] = defaultAcks,
        questionCooldownTurns: Int = defaultQuestionCooldownTurns,
        completionThreshold: Double = defaultCompletionThreshold,
        justListen: Bool = false
    ) {
        self.substantiveWords = substantiveWords
        self.acks = acks
        self.questionCooldownTurns = questionCooldownTurns
        self.completionThreshold = completionThreshold
        self.justListen = justListen
    }

    public static let defaults = GateConfig()

    /// The gate's runtime config, derived from the detector's LIVE turn knobs —
    /// one slider, both readers (mirrors web/src/knobs.ts gateConfigFromTurnKnobs).
    public static func derived(from knobs: TurnKnobs) -> GateConfig {
        var cfg = GateConfig()
        cfg.completionThreshold = knobs.completionThreshold
        return cfg
    }
}

// ── Gate I/O ──

/// A prior turn's decision — the history the escalate-slowly policy reads.
/// `turn` is the UTTERANCE the decision was made about, so the cooldown
/// measures spacing in thoughts.
public struct PriorDecision: Sendable {
    public let turn: Int
    public let tier: Tier

    public init(turn: Int, tier: Tier) {
        self.turn = turn
        self.tier = tier
    }
}

/// Everything the gate is allowed to look at when it evaluates a pause.
/// Deliberately wider than the stage-1 policy reads — `msSinceSpeechEnd` and
/// `msSinceWeLastSpoke` are carried but unread, so a future policy edit is a
/// change inside `decideTier` rather than a contract change.
public struct EvalContext: Sendable {
    /// Utterance identity (1-based) — which THOUGHT this is, not which
    /// evaluation tick fired. The ack rotation and the question cooldown are
    /// spacing rules about utterances (spec §4b).
    public let utteranceIndex: Int
    /// The WHOLE utterance transcribed so far — NOT the fragment since the last
    /// evaluation. Rules 4/5 ask "how big is this thought?", so a re-evaluation
    /// of a still-growing utterance has to see all of it.
    public let utteranceTextSoFar: String
    /// The EOU classifier's P(complete) for this pause. Below
    /// `GateConfig.completionThreshold` the classifier read the thinker as
    /// mid-thought. Non-finite (no usable verdict) is treated as incomplete.
    public let completionProb: Double
    /// How long this pause has run (ms since the last speech-end in the turn).
    /// NaN when there is no measurement. Carried; unread in stage 1.
    public let msSinceSpeechEnd: Double
    /// How long since the companion last RELEASED THE FLOOR (ms), `.infinity`
    /// if it never has. Carried; unread in stage 1.
    public let msSinceWeLastSpoke: Double
    /// The history the escalate-slowly policy reads.
    public let priorDecisions: [PriorDecision]

    public init(
        utteranceIndex: Int,
        utteranceTextSoFar: String,
        completionProb: Double,
        msSinceSpeechEnd: Double = .nan,
        msSinceWeLastSpoke: Double = .infinity,
        priorDecisions: [PriorDecision] = []
    ) {
        self.utteranceIndex = utteranceIndex
        self.utteranceTextSoFar = utteranceTextSoFar
        self.completionProb = completionProb
        self.msSinceSpeechEnd = msSinceSpeechEnd
        self.msSinceWeLastSpoke = msSinceWeLastSpoke
        self.priorDecisions = priorDecisions
    }
}

/// `completionProb` for a caller that only has the detector's two-valued
/// turn-end reason: `extended` ⇒ certainly incomplete, `floor` ⇒ certainly complete.
public func completionProb(fromTurnEnd reason: PatienceReason) -> Double {
    reason == .extended ? 0 : 1
}

public struct GateDecision: Sendable {
    public let tier: Tier
    /// True iff this tier needs the model (reflection/question).
    public let callModel: Bool
    /// The rules-produced backchannel for `acknowledge`; nil for every other tier.
    public let ackText: String?
    /// Why the gate landed here — shown in the UI/log and asserted by tests.
    public let reason: String
}

/// Words in a turn, whitespace-split.
public func wordCount(_ text: String) -> Int {
    text.split(whereSeparator: { $0.isWhitespace }).count
}

/// A finished thought that trails off on a discourse marker (ellipsis, em/en
/// dash, comma) reads as "still going" — the thinker paused, they are not done.
private let trailingOffMarkers: Set<Character> = ["…", ",", "-", "—"]

/// The rules-only acknowledge rung: rotate the ack by utterance number so a
/// run of gated turns never reads as one stuck token. An empty ack set (a
/// config choice, not the default) degrades to silence — the more restrained
/// rung, per §1's tie-breaking rule.
private func ackDecision(
    _ ctx: EvalContext, _ cfg: GateConfig, reason: String, silentReason: String
) -> GateDecision {
    guard !cfg.acks.isEmpty else {
        return GateDecision(tier: .silence, callModel: false, ackText: nil,
                            reason: silentReason)
    }
    let n = cfg.acks.count
    let ack = cfg.acks[((ctx.utteranceIndex % n) + n) % n]
    return GateDecision(tier: .acknowledge, callModel: false, ackText: ack, reason: reason)
}

/// Decide the response tier for an evaluated pause under the "escalate slowly"
/// policy. Pure: same inputs → same output.
///
/// Order matters — the restraint checks come FIRST so an unfinished thought can
/// never be escalated:
///  1. no words                          → silence   (nothing to respond to)
///  2. EOU says incomplete               → silence   (mid-thought; B1 — never interrupt)
///  3. text trails off (…, — ,)          → silence   (mid-thought)
///  4. short finished aside              → acknowledge (rules-only rotating backchannel)
///  4b. just-listen cap (questions off)  → acknowledge — an uninvited turn never
///      reaches the model tiers; a direct question FROM the thinker still does
///  5. substantive / a direct question   → reflection, or question when EARNED
public func decideTier(_ ctx: EvalContext, config: GateConfig = .defaults) -> GateDecision {
    let cfg = config
    let text = ctx.utteranceTextSoFar.trimmingCharacters(in: .whitespacesAndNewlines)
    let words = wordCount(text)
    let history = ctx.priorDecisions

    // 1. Nothing transcribed — there is nothing to respond to.
    if words == 0 {
        return GateDecision(tier: .silence, callModel: false, ackText: nil,
                            reason: "no transcript — holding silence")
    }

    // 2. The EOU classifier scored this pause below the completion threshold:
    //    the thinker is mid-thought. B1: interrupting an unfinished thought is
    //    the cardinal failure. Hold silence regardless of what the words say.
    //    Written as `!(prob >= threshold)` so a non-finite probability falls to
    //    silence rather than slipping through as "complete".
    if !(ctx.completionProb >= cfg.completionThreshold) {
        return GateDecision(tier: .silence, callModel: false, ackText: nil,
                            reason: "detector held turn open (incomplete) — holding silence")
    }

    // 3. The words trail off on a discourse marker — still going. Hold.
    if let last = text.last, trailingOffMarkers.contains(last) {
        return GateDecision(tier: .silence, callModel: false, ackText: nil,
                            reason: "trailing off mid-thought — holding silence")
    }

    // The turn is a finished thought. Decide the register.
    let invited = text.contains("?") // the thinker asked the companion something
    let substantive = words >= cfg.substantiveWords

    // 4. A short, finished, non-question aside → minimal acknowledgment.
    //    Rules only, no model.
    if !invited && !substantive {
        return ackDecision(
            ctx, cfg,
            reason: "brief turn (\(words)w) — minimal acknowledgment",
            silentReason: "brief turn (\(words)w), no acks configured — holding silence"
        )
    }

    // 4b. Just-listen: questions are off for this session. An UNINVITED turn —
    //     however substantive — is capped at the acknowledge rung, so the model
    //     tiers (reflection/question) are unreachable. A direct question FROM
    //     the thinker still escalates via rule 5 (an invited question bypasses
    //     the cap), and the explicit "pull a thread now" path never enters the
    //     gate at all — it builds its `.question` request directly.
    if cfg.justListen && !invited {
        return ackDecision(
            ctx, cfg,
            reason: "just listen — substantive turn (\(words)w) capped to acknowledgment",
            silentReason: "just listen (\(words)w), no acks configured — holding silence"
        )
    }

    // 5. Substantive (or a direct question) → escalate to the model. Default to
    //    a reflection; grant the rare `question` rung only when it is EARNED:
    //      - a direct question from the thinker is answered in kind, OR
    //      - a substantive turn, past the opening turn, with the question
    //        cooldown elapsed since the last listener question.
    let priorTurns = history.count
    let lastQuestionTurn = history.reduce(nil as Int?) { acc, d in
        guard d.tier == .question else { return acc }
        return acc.map { max($0, d.turn) } ?? d.turn
    }
    let sinceLastQuestion = lastQuestionTurn.map { Double(ctx.utteranceIndex - $0) } ?? .infinity
    let questionEarned = invited
        || (substantive && priorTurns >= 1 && sinceLastQuestion >= Double(cfg.questionCooldownTurns))

    if questionEarned {
        return GateDecision(
            tier: .question, callModel: true, ackText: nil,
            reason: invited
                ? "thinker asked a question — one brief reply"
                : "substantive turn (\(words)w), question cooldown elapsed"
        )
    }
    return GateDecision(tier: .reflection, callModel: true, ackText: nil,
                        reason: "substantive turn (\(words)w) — short reflection")
}

/// What the host should do with an `.acknowledge` gate decision, split so the
/// spoken side (suppressed when acknowledgments are off) never drags the
/// recorded side (the gate history that spaces questions) with it.
public struct ResolvedAck: Equatable, Sendable {
    /// What to store in the decision history — always `.acknowledge` here, so
    /// the question cooldown counts this turn correctly even when silent.
    public let recordedTier: Tier
    /// The backchannel to speak, or nil to stay silent (acks off, or no ack).
    public let spokenText: String?

    public init(recordedTier: Tier, spokenText: String?) {
        self.recordedTier = recordedTier
        self.spokenText = spokenText
    }
}

/// Resolve an `.acknowledge` decision into (what to record, what to speak).
/// Precondition: `decision.tier == .acknowledge`.
public func resolveAcknowledge(
    _ decision: GateDecision,
    speakAcknowledgments: Bool
) -> ResolvedAck {
    let spoken = (speakAcknowledgments ? decision.ackText : nil)
        .flatMap { $0.isEmpty ? nil : $0 }
    return ResolvedAck(recordedTier: .acknowledge, spokenText: spoken)
}

// ── Prompt construction for the substantive tiers ──
//
// Only reflection/question turns reach the model. `buildListenerRequest`
// assembles what the Claude Messages API needs: the system prompt (the
// prompts/claude.md text plus a compact tier instruction that constrains the
// register) and the running conversation with roles strictly alternating and
// no message empty (thinker → user, listener → assistant).

public struct ListenerChatMessage: Equatable, Sendable {
    public enum Role: String, Codable, Sendable { case user, assistant }
    public let role: Role
    public let content: String

    public init(role: Role, content: String) {
        self.role = role
        self.content = content
    }
}

/// One prior exchange, in the order it happened. `text` empty ⇒ a silent
/// listener turn (dropped).
public struct ConversationTurn: Sendable {
    public enum Speaker: Sendable { case thinker, listener }
    public let speaker: Speaker
    public let text: String

    public init(speaker: Speaker, text: String) {
        self.speaker = speaker
        self.text = text
    }
}

public struct ListenerRequest: Sendable {
    public let system: String
    public let messages: [ListenerChatMessage]
    public let tier: Tier
    /// Generation cap — reflections/questions are brief (a sentence or two).
    public let maxTokens: Int
    /// When set, the leading `cachedSystemPrefix` of `system` is sent as a
    /// cache_control breakpoint block and the remainder follows as a volatile
    /// block — Opus reads the stable prefix from cache (~0.1× input). MUST be a
    /// prefix of `system`; nil ⇒ `system` is sent as one plain block (today's
    /// behavior). Ignored by ProxyClient, which caches server-side.
    public let cachedSystemPrefix: String?

    public init(
        system: String,
        messages: [ListenerChatMessage],
        tier: Tier,
        maxTokens: Int,
        cachedSystemPrefix: String? = nil
    ) {
        self.system = system
        self.messages = messages
        self.tier = tier
        self.maxTokens = maxTokens
        self.cachedSystemPrefix = cachedSystemPrefix
    }
}

/// Default generation budget: a reflection/question is at most a sentence or two.
public let defaultMaxListenerTokens = 128

/// The register instruction appended to the system prompt for a substantive tier.
public func tierInstruction(_ tier: Tier) -> String {
    switch tier {
    case .reflection:
        return "For THIS reply: offer at most a short, momentum-preserving reflection — a "
            + "sentence or two that nudges the thought a little further. Do NOT ask a "
            + "question. Often the best reply is still nothing."
    case .question:
        return "For THIS reply: you may offer exactly ONE brief follow-up question, "
            + "anchored to something specific they just said — never a generic stem. Keep "
            + "it to a single sentence, or stay silent if nothing specific is worth pulling on."
    case .silence, .acknowledge:
        return "" // never call the model
    }
}

/// Normalise conversation turns into an alternating chat array: drop empty
/// turns, merge consecutive same-role turns with a blank line. If the first
/// surviving turn is a listener turn it is dropped — the Messages API requires
/// the first message to be from the user, and a session always opens with the
/// thinker anyway.
public func toChatMessages(_ turns: [ConversationTurn]) -> [ListenerChatMessage] {
    var out: [ListenerChatMessage] = []
    for t in turns {
        let content = t.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if content.isEmpty { continue } // drop silent listener turns
        let role: ListenerChatMessage.Role = t.speaker == .thinker ? .user : .assistant
        if out.isEmpty && role == .assistant { continue } // API: first message must be user
        if let last = out.last, last.role == role {
            out[out.count - 1] = ListenerChatMessage(role: role, content: last.content + "\n\n" + content)
        } else {
            out.append(ListenerChatMessage(role: role, content: content))
        }
    }
    return out
}

/// Shared message construction for the listener builders: append the current
/// thinker turn onto `history`, normalize to an alternating chat array, and
/// wrap it with the already-assembled system prompt + tier. Both public
/// builders differ only in which instruction they append to the system prompt.
private func makeRequest(
    system: String,
    tier: Tier,
    currentTurnText: String,
    history: [ConversationTurn],
    maxTokens: Int
) -> ListenerRequest {
    var turns = history
    turns.append(ConversationTurn(speaker: .thinker, text: currentTurnText))
    return ListenerRequest(
        system: system,
        messages: toChatMessages(turns),
        tier: tier,
        maxTokens: maxTokens
    )
}

/// Build the model request for a substantive turn. `history` is the prior
/// conversation (not including the current turn); `currentTurnText` is appended
/// as the final thinker (user) message.
public func buildListenerRequest(
    systemPrompt: String,
    tier: Tier,
    currentTurnText: String,
    history: [ConversationTurn] = [],
    maxTokens: Int = defaultMaxListenerTokens
) -> ListenerRequest {
    let system = (systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        + "\n\n" + tierInstruction(tier)).trimmingCharacters(in: .whitespacesAndNewlines)
    return makeRequest(
        system: system, tier: tier, currentTurnText: currentTurnText,
        history: history, maxTokens: maxTokens
    )
}

/// The forcing instruction for the explicit "pull a thread now" path. Unlike
/// the gate's `tierInstruction(.question)`, it never offers silence and never
/// permits a deferral — the user asked, so the listener asks.
public let pullThreadInstruction =
    "You were explicitly asked to pull a thread; ask ONE specific question "
    + "anchored to what they've said. If genuinely too little has been said, "
    + "say that plainly — never tell them to take their time."

/// Build the model request for the invited "pull a thread now" path. Mirrors
/// `buildListenerRequest`'s message construction (append the current turn onto
/// `history`, then normalise with `toChatMessages` so consecutive same-speaker
/// turns merge and roles strictly alternate, per the Messages API) but swaps in
/// `pullThreadInstruction` (NOT the gate's optional-silence question
/// instruction) so the reply is always a question or an honest "not yet".
public func buildPullThreadRequest(
    systemPrompt: String,
    currentTurnText: String,
    history: [ConversationTurn] = [],
    maxTokens: Int = defaultMaxListenerTokens
) -> ListenerRequest {
    let system = (systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        + "\n\n" + pullThreadInstruction).trimmingCharacters(in: .whitespacesAndNewlines)
    return makeRequest(
        system: system, tier: .question, currentTurnText: currentTurnText,
        history: history, maxTokens: maxTokens
    )
}
