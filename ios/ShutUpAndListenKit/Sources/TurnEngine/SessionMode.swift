// Session modes — the two first-class prompt tints (rehearsal, debrief) plus
// the modeless default, and the assembly entry point that composes the final
// system prompt from (mode, justListen).
//
// Per the scenario evaluation, a mode is NOT a fork of the listener: the base
// prompt (prompts/claude.md, embedded verbatim in ListenerPrompt) stays
// byte-identical, and a mode contributes only a short addendum appended after
// it — the same mechanism as `tierInstruction`. The silence rules, anchoring
// rules, and cadence carry over untouched; only the AIM of the one earned
// question shifts. `.open` adds nothing, so the no-argument
// `ListenerPrompt.systemPrompt` path is unchanged.
//
// PURE — string composition only; no I/O, no model.

import Foundation

public enum SessionMode: String, Codable, CaseIterable, Sendable {
    /// The modeless default — today's listener, byte-identical.
    case open
    /// The thinker is practicing something they will deliver to a real
    /// audience: a pitch, an interview answer, a hard conversation.
    case rehearsal
    /// The thinker is unloading something that just happened — a meeting, a
    /// sales call, an incident — before the memory fades.
    case debrief

    /// Picker label.
    public var displayName: String {
        switch self {
        case .open: return "Open"
        case .rehearsal: return "Rehearsal"
        case .debrief: return "Debrief"
        }
    }

    /// One line for a mode picker.
    public var blurb: String {
        switch self {
        case .open:
            return "Think out loud. It stays out of the way."
        case .rehearsal:
            return "Practice a pitch, an answer, a hard conversation — the one "
                + "question is the one your real audience would ask."
        case .debrief:
            return "Unload what just happened before it fades — the one "
                + "question finds what you glossed over."
        }
    }

    /// The prompt addendum appended after the base listener prompt. Nil for
    /// `.open` — the base prompt IS the open mode.
    public var promptTint: String? {
        switch self {
        case .open:
            return nil

        case .rehearsal:
            return """
            ## This session is a rehearsal

            The thinker is not dictating an idea — they are practicing something they will deliver to a real audience: a pitch, an interview answer, a hard conversation. Getting the words out, end to end, is the exercise. Everything above still holds: silence while they deliver, and interrupting a run-through is still the cardinal failure. A restart, a stumble, a "wait, let me take that again" is part of rehearsing — stay silent through it.

            What changes is the aim of your one question. You are a stand-in for their audience, not a coach. Once the run-through lands, ask the one question that real audience would most likely ask — the objection a skeptical listener raises, the follow-up an interviewer reaches for, the "wait — why?" the other person will not let pass. Anchor it, as always, to something specific they actually said: a claim asserted without support, a number left unexplained, a step in the story they skipped.

            Never critique the delivery. No notes on pacing, confidence, structure, or word choice; no praise, no "that landed well." And one question per run-through — you are their audience for a beat, not a mock interviewer.
            """

        case .debrief:
            return """
            ## This session is a debrief

            The thinker is unloading something that just happened — a meeting, a sales call, an incident — before the memory fades. Recall is the whole game, and every interruption costs them detail. Everything above still holds: silence while they get it out, one question only once the account lands.

            What changes is the aim of your one question. Pull toward the thing they glossed over: a decision that got made but never examined, a commitment mentioned in passing, a number or a name they skated past — the thing they will wish they had captured once it is gone. Anchor it, as always, to something specific they actually said.

            Never summarize what happened. No recaps, no "so the meeting was…", no tidying the account into order. What they said is the record; your question only helps more of it come out.
            """
        }
    }
}

// ── Prompt assembly ──

extension ListenerPrompt {
    /// The one-line addendum for a just-listen session (questions off). The
    /// binding cap is deterministic and lives in the gate
    /// (`GateConfig.justListen`) — this line only keeps the model's
    /// expectations aligned on the invited path, where a question is still
    /// allowed because the thinker asked for it.
    public static let justListenTint =
        "For this session the thinker has turned questions off: stay silent even "
        + "when an idea fully lands, and offer your one question only if the "
        + "thinker turns to you and asks for it directly."

    /// Assemble the final system prompt for a session: the base prompt
    /// (byte-identical to `systemPrompt`), then the mode's tint, then the
    /// just-listen tint — each separated by a blank line. `(.open, false)`
    /// returns exactly `systemPrompt`, so today's behavior is unchanged.
    public static func systemPrompt(mode: SessionMode, justListen: Bool = false) -> String {
        var parts = [systemPrompt]
        if let tint = mode.promptTint { parts.append(tint) }
        if justListen { parts.append(justListenTint) }
        return parts.joined(separator: "\n\n")
    }
}
