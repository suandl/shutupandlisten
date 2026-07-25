// The eval-fixture export — a saved session serialized into the promptfoo
// replay-fixture contract, so a real dictation becomes a deterministic
// regression input for promptfoo/providers/replay.js.
//
// The contract lives in promptfoo/fixtures/README.md; the executable version
// is promptfoo/lib/fixture-schema.js (`npm run validate`). This encoder is the
// iOS side of that handshake: thinker turns only (replay generates fresh
// listener responses — recorded ones would only contaminate the history), text
// EXACTLY as the STT produced it (the disfluency is the data), and optionals
// omitted rather than invented — a fixture never claims timings or knobs the
// capture didn't keep.
//
// PURE — no SwiftData, no UI, no I/O. It maps plain values to JSON `Data`, so
// the contract is pinned by unit tests headlessly (including on Linux CI,
// where FixtureExportTests cross-checks the output against the Node validator
// itself). Output is deterministic: sorted keys, ISO-8601 UTC dates.

import Foundation

public enum FixtureExport {
    /// Mirrors SCHEMA_VERSION in promptfoo/lib/fixture-schema.js — bump both
    /// sides together on a breaking change.
    public static let schemaVersion = 1

    /// `session.source` for a real device capture. The contract reserves this
    /// label for text that actually came off SFSpeechRecognizer, which is why
    /// `source` has no default — the caller states provenance explicitly.
    public static let iosSFSpeechRecognizerSource = "ios-sfspeechrecognizer"

    /// One transcript line as the capture stored it. The encoder keeps only
    /// `speaker == "thinker"` lines with non-blank text; listener lines are
    /// dropped per the contract. Timings are optional — pass them only when
    /// the capture really has them.
    public struct Entry: Equatable, Sendable {
        public var speaker: String
        public var text: String
        public var startSeconds: Double?
        public var endSeconds: Double?

        public init(
            speaker: String,
            text: String,
            startSeconds: Double? = nil,
            endSeconds: Double? = nil
        ) {
            self.speaker = speaker
            self.text = text
            self.startSeconds = startSeconds
            self.endSeconds = endSeconds
        }
    }

    public enum ExportError: Error, Equatable {
        /// No non-blank thinker line survived filtering — the schema requires
        /// a non-empty `utterances`, so there is nothing to replay.
        case noThinkerUtterances
        /// `landingIndex` fell outside the FILTERED thinker utterances
        /// (0-based, like the schema).
        case landingIndexOutOfRange(index: Int, utteranceCount: Int)
    }

    /// Suggested export file name: `sul-fixture-<first 8 of the session id>.json`.
    public static func fileName(sessionID: String) -> String {
        "sul-fixture-\(sessionID.prefix(8).lowercased()).json"
    }

    /// Encode a fixture. `landingIndex`, when given, indexes the thinker
    /// utterances AFTER filtering; nil omits the field (replay defaults the
    /// landing to the last utterance). `knobs`, when given, exports the four
    /// contract-documented fields; nil omits the object.
    public static func jsonData(
        sessionID: String,
        date: Date,
        source: String,
        knobs: TurnKnobs? = nil,
        entries: [Entry],
        landingIndex: Int? = nil
    ) throws -> Data {
        let utterances = entries
            .filter {
                $0.speaker == "thinker"
                    && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty
            }
            .map {
                Utterance(text: $0.text, startSeconds: $0.startSeconds,
                          endSeconds: $0.endSeconds)
            }
        guard !utterances.isEmpty else { throw ExportError.noThinkerUtterances }
        if let landingIndex, !(0..<utterances.count).contains(landingIndex) {
            throw ExportError.landingIndexOutOfRange(
                index: landingIndex, utteranceCount: utterances.count)
        }

        let fixture = Fixture(
            schemaVersion: schemaVersion,
            session: Session(
                id: sessionID,
                date: Self.iso8601.string(from: date),
                source: source,
                knobs: knobs.map(Knobs.init)
            ),
            utterances: utterances,
            landingIndex: landingIndex
        )

        let encoder = JSONEncoder()
        // Sorted + pretty ⇒ byte-stable output for the same inputs, and a
        // diffable file once it lands in promptfoo/fixtures/.
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(fixture)
    }

    /// String-typed convenience over `jsonData` — what the share sheet writes.
    public static func json(
        sessionID: String,
        date: Date,
        source: String,
        knobs: TurnKnobs? = nil,
        entries: [Entry],
        landingIndex: Int? = nil
    ) throws -> String {
        String(decoding: try jsonData(
            sessionID: sessionID, date: date, source: source, knobs: knobs,
            entries: entries, landingIndex: landingIndex
        ), as: UTF8.self)
    }

    // ── the wire shape (synthesized Encodable omits nil optionals) ──

    private struct Fixture: Encodable {
        let schemaVersion: Int
        let session: Session
        let utterances: [Utterance]
        let landingIndex: Int?
    }

    private struct Session: Encodable {
        let id: String
        let date: String
        let source: String
        let knobs: Knobs?
    }

    /// The TurnKnobs fields the contract documents; responseDurationMs stays
    /// out — it is sized per response by the host, not a session setting.
    private struct Knobs: Encodable {
        let silenceFloorMs: Double
        let incompleteExtensionMs: Double
        let completionThreshold: Double
        let useSmartTurn: Bool

        init(_ knobs: TurnKnobs) {
            silenceFloorMs = knobs.silenceFloorMs
            incompleteExtensionMs = knobs.incompleteExtensionMs
            completionThreshold = knobs.completionThreshold
            useSmartTurn = knobs.useSmartTurn
        }
    }

    private struct Utterance: Encodable {
        let text: String
        let startSeconds: Double?
        let endSeconds: Double?
    }

    /// `2026-07-25T09:30:00Z` — the shape the schema and the hand-authored
    /// fixtures use.
    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()
}
