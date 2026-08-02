// Named coverage presets — bundled checklists for the existing Coverage
// machinery, fixing coverage mode's cold-start problem (today the checklist is
// one blank text field in Settings).
//
// A preset is nothing but a named [CoverageCriterion] with a blurb: it plugs
// into `Coverage.userMessage` / the coverage endpoint unchanged, and
// `criteriaText` round-trips through `Coverage.parseCriteria` — the same path
// as a hand-typed checklist. Criteria phrasing is second person and concrete
// because the lines are BOTH user-facing (the picker, the coverage panel) and
// model-facing (the checklist sent to the coverage endpoint).
//
// PURE — data only; no I/O, no model.

import Foundation

public struct CoveragePreset: Identifiable, Equatable, Sendable {
    /// Stable identifier, safe to persist (e.g. in AppStorage).
    public let id: String
    /// Picker label.
    public let name: String
    /// One line for the picker.
    public let blurb: String
    public let criteria: [CoverageCriterion]
    /// The session mode this preset pairs naturally with — a SUGGESTION for
    /// the picker to offer, never applied silently (per the scenario report:
    /// never infer the voice).
    public let suggestedMode: SessionMode

    public init(
        id: String,
        name: String,
        blurb: String,
        criteria: [CoverageCriterion],
        suggestedMode: SessionMode = .open
    ) {
        self.id = id
        self.name = name
        self.blurb = blurb
        self.criteria = criteria
        self.suggestedMode = suggestedMode
    }

    /// The newline-joined checklist, in the exact shape the Settings field
    /// stores — `Coverage.parseCriteria(criteriaText)` gives back `criteria`.
    public var criteriaText: String {
        criteria.map(\.topic).joined(separator: "\n")
    }
}

/// One topic per line, in order.
private func topics(_ lines: String...) -> [CoverageCriterion] {
    lines.map(CoverageCriterion.init(topic:))
}

public enum CoveragePresets {
    public static let decision = CoveragePreset(
        id: "decision",
        name: "Decision",
        blurb: "Wrestle a decision to the ground before you make it.",
        criteria: topics(
            "the options on the table",
            "what you'd lose with each",
            "what would change your mind",
            "when you'll decide"
        )
    )

    public static let weeklyRetro = CoveragePreset(
        id: "weekly-retro",
        name: "Weekly retro",
        blurb: "Close out the week while it's still fresh.",
        criteria: topics(
            "what went well this week",
            "what didn't go well",
            "what you'll change next week",
            "the one thing you're carrying over unfinished"
        )
    )

    public static let standupPrep = CoveragePreset(
        id: "standup-prep",
        name: "Standup prep",
        blurb: "The ninety-second version, ready before the meeting.",
        criteria: topics(
            "what you finished yesterday",
            "what you're doing today",
            "what's blocking you"
        )
    )

    public static let feynmanStudy = CoveragePreset(
        id: "feynman-study",
        name: "Feynman study",
        blurb: "Explain it out loud until you find the step you can't.",
        criteria: topics(
            "explain it simply",
            "where the explanation breaks",
            "the example that proves it"
        )
    )

    public static let pitchRehearsal = CoveragePreset(
        id: "pitch-rehearsal",
        name: "Pitch rehearsal",
        blurb: "Every beat the pitch has to hit, out loud, end to end.",
        criteria: topics(
            "the problem you're solving",
            "why now",
            "how it works",
            "the traction you can point to",
            "the team",
            "the ask"
        ),
        suggestedMode: .rehearsal
    )

    public static let salesCallDebrief = CoveragePreset(
        id: "sales-call-debrief",
        name: "Sales-call debrief",
        blurb: "Capture the call before the details fade.",
        criteria: topics(
            "who was on the call",
            "their objections, in their words",
            "budget or price signals you heard",
            "the next step you agreed to",
            "what you promised to send"
        ),
        suggestedMode: .debrief
    )

    /// The bundled library, in display order.
    public static let all: [CoveragePreset] = [
        decision,
        weeklyRetro,
        standupPrep,
        feynmanStudy,
        pitchRehearsal,
        salesCallDebrief,
    ]

    /// Look a preset up by its stable id (e.g. from AppStorage).
    public static func preset(id: String) -> CoveragePreset? {
        all.first { $0.id == id }
    }
}
