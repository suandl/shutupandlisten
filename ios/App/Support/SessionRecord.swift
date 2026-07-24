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

    init(
        id: UUID = UUID(),
        startedAt: Date,
        duration: TimeInterval,
        title: String,
        transcriptJSON: Data,
        criteriaText: String,
        coverageJSON: Data? = nil,
        audioFileName: String? = nil
    ) {
        self.id = id
        self.startedAt = startedAt
        self.duration = duration
        self.title = title
        self.transcriptJSON = transcriptJSON
        self.criteriaText = criteriaText
        self.coverageJSON = coverageJSON
        self.audioFileName = audioFileName
    }

    // ── decoded views ──

    var entries: [StoredEntry] {
        (try? JSONDecoder().decode([StoredEntry].self, from: transcriptJSON)) ?? []
    }

    var coverage: CoverageResult? {
        guard let coverageJSON else { return nil }
        return try? JSONDecoder().decode(CoverageResult.self, from: coverageJSON)
    }

    /// True when the listener asked at least one question in this session.
    var hasThreadPull: Bool {
        entries.contains { $0.tier == Tier.question.rawValue }
    }

    /// Everything said, joined — for library search.
    var searchableText: String {
        entries.map(\.text).joined(separator: " ")
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

    /// Markdown export: title, date, transcript, coverage when present.
    var markdown: String {
        var lines: [String] = ["# \(title)", ""]
        lines.append(startedAt.formatted(date: .abbreviated, time: .shortened))
        lines.append("")
        for entry in entries where !entry.text.isEmpty {
            lines.append("\(Self.markdownLabel(for: entry)) \(entry.text)")
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
        return lines.joined(separator: "\n")
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
