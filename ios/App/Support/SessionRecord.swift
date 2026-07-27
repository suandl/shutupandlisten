// A finished session, persisted with SwiftData: the transcript, the coverage
// snapshot (when a check ran), and the name of the audio file under
// Application Support/Recordings.

import Foundation
import SwiftData
import TurnEngine

/// One transcript line, flattened for storage. `speaker` is "thinker" or
/// "listener"; `tier` is the listener tier's raw value ("acknowledge" /
/// "reflection" / "question"), nil for thinker turns.
struct StoredEntry: Codable {
    let speaker: String
    let text: String
    let tier: String?
    let turn: Int
    /// Utterance timing in ms since session start. The recording shares the
    /// same clock origin, so these double as offsets into the session audio
    /// (transcript↔audio seek). Optional on purpose: records saved before
    /// timing shipped carry no keys and decode as nil.
    let startMs: Int?
    let endMs: Int?

    init(
        speaker: String,
        text: String,
        tier: String?,
        turn: Int,
        startMs: Int? = nil,
        endMs: Int? = nil
    ) {
        self.speaker = speaker
        self.text = text
        self.tier = tier
        self.turn = turn
        self.startMs = startMs
        self.endMs = endMs
    }
}

@Model
final class SessionRecord {
    var id: UUID
    var startedAt: Date
    var duration: TimeInterval
    var title: String
    /// JSON-encoded `[StoredEntry]`.
    var transcriptJSON: Data
    /// The coverage checklist in effect (one topic per line; may be empty).
    var criteriaText: String
    /// JSON-encoded `CoverageResult`, when a coverage check ran.
    var coverageJSON: Data?
    /// File name under Application Support/Recordings, when audio was captured.
    var audioFileName: String?
    /// Total model spend for the session, USD. Optional: records saved before
    /// cost tracking (and sessions on the usage-less proxy path) carry nil.
    var costUSD: Double?
    /// Whether `transcriptJSON` is the authoritative file-derived transcript
    /// (true) or the best-effort live transcript still awaiting reconciliation
    /// (false). Defaulting to false means every existing record — and every
    /// freshly checkpointed one — is treated as "live, reconcile when possible".
    var transcriptIsReconciled: Bool = false

    init(
        id: UUID = UUID(),
        startedAt: Date,
        duration: TimeInterval,
        title: String,
        transcriptJSON: Data,
        criteriaText: String,
        coverageJSON: Data? = nil,
        audioFileName: String? = nil,
        costUSD: Double? = nil,
        transcriptIsReconciled: Bool = false
    ) {
        self.id = id
        self.startedAt = startedAt
        self.duration = duration
        self.title = title
        self.transcriptJSON = transcriptJSON
        self.criteriaText = criteriaText
        self.coverageJSON = coverageJSON
        self.audioFileName = audioFileName
        self.costUSD = costUSD
        self.transcriptIsReconciled = transcriptIsReconciled
    }

    // ── decoded views ──

    var entries: [StoredEntry] {
        (try? JSONDecoder().decode([StoredEntry].self, from: transcriptJSON)) ?? []
    }

    // ── reconciliation inputs (rebuilt from the stored live transcript) ──
    //
    // Reconciliation is resumable: a record saved with the live transcript can
    // be upgraded to the file-derived one at any later launch, because the turn
    // windows and the synthesized listener lines are recoverable from what was
    // already saved. Only the file-derived thinker segments come fresh (from
    // FileTranscriber); these two provide the rest.

    /// The thinker turn windows the machine recorded — grouping + tap-to-seek
    /// anchors for `TranscriptReconciler`.
    var turnWindows: [TurnWindow] {
        entries
            .filter { $0.speaker == "thinker" }
            .compactMap { e in
                guard let start = e.startMs else { return nil }
                return TurnWindow(turn: e.turn, startMs: start, endMs: e.endMs)
            }
    }

    /// The synthesized listener lines — not in the mic .m4a, re-inserted as-is.
    var listenerLines: [ListenerLine] {
        entries.compactMap { e in
            guard e.speaker == "listener",
                  let start = e.startMs,
                  let tier = e.tier.flatMap(Tier.init(rawValue:))
            else { return nil }
            return ListenerLine(text: e.text, tier: tier, turn: e.turn, startMs: start)
        }
    }

    /// True only if every stored listener line has the timing reconciliation
    /// needs. Listener lines are NOT in the mic .m4a, so reconciliation (which
    /// overwrites the transcript) must not run when it would drop an untimed
    /// listener line — that content is unrecoverable. Legacy records saved
    /// before per-utterance timing shipped fail this and keep their live
    /// transcript. Thinker text is unaffected (it is regenerated from the file).
    var canReconcileWithoutListenerLoss: Bool {
        entries.allSatisfy { $0.speaker != "listener" || $0.startMs != nil }
    }

    var coverage: CoverageResult? {
        guard let coverageJSON else { return nil }
        return try? JSONDecoder().decode(CoverageResult.self, from: coverageJSON)
    }

    /// The thread-pull the thinker left with: the LAST question the listener
    /// asked. The listener's whole job was this one sentence — post-session it
    /// becomes the record's durable hook and natural resume point.
    var openQuestion: String? {
        entries.last {
            $0.speaker == "listener" && $0.tier == Tier.question.rawValue
        }?.text
    }

    /// Whether the thinker said anything after the open question — i.e. the
    /// question got at least an attempt, rather than ending the session cold.
    var openQuestionAnsweredByThinker: Bool {
        let all = entries
        guard let idx = all.lastIndex(where: {
            $0.speaker == "listener" && $0.tier == Tier.question.rawValue
        }) else { return false }
        return all[(idx + 1)...].contains {
            $0.speaker == "thinker" && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    /// Title from the first ~8 words of the first thinker turn.
    static func deriveTitle(from entries: [StoredEntry]) -> String {
        guard let first = entries.first(where: {
            $0.speaker == "thinker" && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty
        }) else { return "Untitled session" }
        let words = first.text.split(whereSeparator: { $0.isWhitespace })
        let head = words.prefix(8).joined(separator: " ")
        return words.count > 8 ? head + "…" : head
    }

    // ── export ──

    /// Markdown export, shaped for a PKM vault (Obsidian-style): YAML
    /// frontmatter for the machine-readable facts, `[mm:ss]` stamps on entries
    /// when timing was captured, coverage when a check ran, and the open
    /// question called out at the end — the line worth coming back for.
    var markdown: String {
        var lines: [String] = []

        // Frontmatter — properties, not prose.
        lines.append("---")
        lines.append("title: \"\(Self.yamlEscaped(title))\"")
        lines.append("date: \(startedAt.formatted(.iso8601))")
        lines.append("duration: \"\(Self.clock(ms: Int(duration * 1000)))\"")
        let criteria = criteriaText
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if !criteria.isEmpty {
            lines.append("criteria:")
            for topic in criteria {
                lines.append("  - \"\(Self.yamlEscaped(topic))\"")
            }
        }
        if let openQuestion {
            lines.append("open_question: \"\(Self.yamlEscaped(openQuestion))\"")
        }
        lines.append("---")
        lines.append("")

        lines.append("# \(title)")
        lines.append("")
        for entry in entries where !entry.text.isEmpty {
            let stamp = entry.startMs.map { "[\(Self.clock(ms: $0))] " } ?? ""
            lines.append("\(stamp)\(Self.markdownLabel(for: entry)) \(entry.text)")
            lines.append("")
        }
        if let coverage {
            lines.append("## Coverage")
            lines.append("")
            for topic in coverage.topics {
                let mark = topic.covered ? "x" : " "
                let evidence = topic.covered && !topic.evidence.isEmpty
                    ? " — “\(topic.evidence)”" : ""
                lines.append("- [\(mark)] \(topic.topic)\(evidence)")
            }
            if !coverage.nudge.isEmpty {
                lines.append("")
                lines.append("> \(coverage.nudge)")
            }
            lines.append("")
        }
        if let openQuestion {
            lines.append("## The question you left with")
            lines.append("")
            lines.append("> \(openQuestion)")
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    /// `mm:ss` from ms; minutes are not capped, so a long session reads
    /// naturally as e.g. `[75:12]`.
    private static func clock(ms: Int) -> String {
        String(format: "%02d:%02d", ms / 60_000, (ms / 1000) % 60)
    }

    /// Minimal escaping for double-quoted YAML scalars.
    private static func yamlEscaped(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func markdownLabel(for entry: StoredEntry) -> String {
        guard entry.speaker == "listener" else { return "**You:**" }
        switch entry.tier {
        case Tier.question.rawValue: return "**Listener (thread-pull):**"
        case Tier.reflection.rawValue: return "**Listener (reflection):**"
        default: return "**Listener:**"
        }
    }
}
