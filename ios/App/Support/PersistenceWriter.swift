// The incremental persistence arm of the transcript spine (docs/plans/
// 2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, "PersistenceWriter"
// + R3): a ModelActor with its own ModelContext off the shared ModelContainer,
// subscribed to the TranscriptStore's multicast log, saving on EVERY finalized
// segment and every turn start — no debounce (plan Key Decisions: that is what
// makes "a crash costs at most the current volatile segment" literally true).
//
// The SessionRecord is created on the MAIN context at session start (state
// `recording`, placeholder title, the CAF file name already referenced so the
// audio can never be orphaned); this actor receives the record's
// `persistentModelID`, never the model object — ModelContext is not Sendable
// and the main context belongs to the UI.
//
// Lifecycle, in order:
//   run(updates:)   consumes `store.updates(replayingSnapshot: false)`:
//                   .segmentFinalized → insert a SegmentRecord + save (title
//                   recomputed when the first thinker final lands);
//                   .turnStarted → save (durability heartbeat); volatile
//                   events ignored.
//   closeOut(...)   after the engine's stop sequence drains: reconciles
//                   against the host's post-drain snapshot (the writer's pull
//                   loop may still be catching up — the snapshot is ground
//                   truth, `persistedIndexes` dedupes), then either deletes a
//                   zero-speech session together with its audio, or stamps
//                   state `complete` + duration + the remuxed audio name +
//                   final title/coverage. Returns whether the record was kept.
//   recoverIncompleteSessions(container:)
//                   at launch (R3.2): every record still in `recording` state
//                   is closed as `recovered` — its crash-safe CAF remuxed and
//                   adopted, or the audio reference dropped when unreadable
//                   (never the transcript); duration derived from
//                   max(last segment audioEnd, audio length); zero-speech
//                   records deleted with their audio, same rule as stop.
//
// Written as a manual `ModelActor` conformance rather than the @ModelActor
// macro: the macro generates the only initializer, which leaves nowhere to
// hand in `recordID`. The body below is exactly the macro's expansion plus
// that one stored property.

import AVFoundation
import Foundation
import SwiftData
import TranscriptCore
import TurnEngine

actor PersistenceWriter: ModelActor {
    nonisolated let modelExecutor: any ModelExecutor
    nonisolated let modelContainer: ModelContainer

    /// The session's record, by identity — resolved in THIS actor's context.
    private let recordID: PersistentIdentifier
    /// Segment log positions already written, so close-out reconciliation and
    /// a still-draining run loop can never double-insert. `index` is unique
    /// per segment within a session (the store's append-order stamp).
    private var persistedIndexes: Set<Int> = []
    /// Set by closeOut; a straggling event that was already queued when the
    /// session closed must not touch (or resurrect) the record.
    private var isClosed = false

    init(modelContainer: ModelContainer, recordID: PersistentIdentifier) {
        let modelContext = ModelContext(modelContainer)
        modelContext.autosaveEnabled = false // this actor saves explicitly, per event
        self.modelExecutor = DefaultSerialModelExecutor(modelContext: modelContext)
        self.modelContainer = modelContainer
        self.recordID = recordID
    }

    // ── the subscription loop ──

    /// Consume the store's event stream until it ends (host cancellation) or
    /// the session closes. Volatile revisions are not persisted (plan R3.1 —
    /// the crash bound is the current volatile segment).
    func run(updates: AsyncStream<TranscriptEvent>) async {
        for await event in updates {
            guard !isClosed else { return }
            switch event {
            case .segmentFinalized(let segment):
                persist(segment)
                save()
            case .turnStarted:
                // Nothing new to write — the tag lives on each segment — but
                // the plan says save on every turn start: a cheap durability
                // heartbeat that also flushes any pending context state.
                save()
            case .segmentAdded, .segmentRevised:
                break
            }
        }
    }

    // ── close-out (graceful stop) ──

    /// Final save after the engine drain. `finalSegments` is the host's
    /// post-drain store snapshot — ground truth reconciled against what the
    /// run loop already wrote. Returns false when the zero-speech rule deleted
    /// the record (no finalized thinker segment → record + audio gone).
    func closeOut(
        duration: TimeInterval,
        audioFileName: String?,
        coverage: CoverageResult?,
        criteria: String,
        finalSegments: [TranscriptSegment]
    ) -> Bool {
        isClosed = true
        guard let record = record() else { return false }

        for segment in finalSegments {
            persist(segment, into: record)
        }

        let spoke = record.segments.contains { $0.speaker == Speaker.thinker.rawValue }
        guard spoke else {
            deleteRecordAndAudio(record, alsoStemOf: audioFileName)
            save()
            return false
        }

        record.state = SessionState.complete.rawValue
        record.duration = duration
        record.audioFileName = audioFileName
        record.criteriaText = criteria
        record.coverageJSON = coverage.flatMap { try? JSONEncoder().encode($0) }
        record.title = SessionRecord.deriveTitle(from: record.entries)
        save()
        return true
    }

    // ── launch recovery ──

    /// Close every record a crash left in `recording` state (R3.2). Runs on
    /// its own throwaway context — call it from a background task at app
    /// startup, before the user opens any recovered session (the library
    /// filters `recording`-state rows, so nothing half-open ever shows).
    static func recoverIncompleteSessions(container: ModelContainer) {
        let context = ModelContext(container)
        let recordingRaw = SessionState.recording.rawValue
        let descriptor = FetchDescriptor<SessionRecord>(
            predicate: #Predicate<SessionRecord> { $0.state == recordingRaw }
        )
        guard let records = try? context.fetch(descriptor) else { return }
        for record in records {
            recover(record, in: context)
        }
        try? context.save()
    }

    private static func recover(_ record: SessionRecord, in context: ModelContext) {
        // The zero-speech rule, same as stop: no finalized thinker segment →
        // the session never happened. Delete record + audio.
        let spoke = record.segments.contains { $0.speaker == Speaker.thinker.rawValue }
        guard spoke else {
            if let name = record.audioFileName {
                RecordingStorage.deleteBoth(stem: RecordingStorage.stem(of: name))
            }
            context.delete(record)
            return
        }

        // Adopt the crash-safe CAF: remux to the .m4a the library plays.
        // Unreadable audio drops the reference — NEVER the transcript.
        var adoptedName: String?
        if let name = record.audioFileName {
            let stem = RecordingStorage.stem(of: name)
            let cafURL = RecordingStorage.url(for: RecordingStorage.cafFileName(stem: stem))
            let m4aName = RecordingStorage.m4aFileName(stem: stem)
            let m4aURL = RecordingStorage.url(for: m4aName)
            if FileManager.default.fileExists(atPath: cafURL.path) {
                do {
                    try CaptureController.remux(caf: cafURL, to: m4aURL)
                    adoptedName = m4aName
                } catch {
                    try? FileManager.default.removeItem(at: m4aURL) // partial output
                }
                try? FileManager.default.removeItem(at: cafURL)
            } else if FileManager.default.fileExists(atPath: m4aURL.path) {
                adoptedName = m4aName // crash landed between remux and close-out
            }
        }
        record.audioFileName = adoptedName

        // Duration: max(last segment audioEnd, audio length) — the transcript
        // may outlast a truncated file, and vice versa.
        var audioSeconds: TimeInterval = 0
        if let adoptedName,
           let file = try? AVAudioFile(forReading: RecordingStorage.url(for: adoptedName)) {
            // SDK-CHECK: AVAudioFile.length is sample frames at the FILE's
            // sample rate (fileFormat); both formats are 48 kHz here, but
            // fileFormat is the one the frame count is defined against.
            let rate = file.fileFormat.sampleRate
            if rate > 0 { audioSeconds = Double(file.length) / rate }
        }
        let lastSegmentEnd = record.segments.map(\.audioEnd).max() ?? 0
        record.duration = max(lastSegmentEnd, audioSeconds)
        record.title = SessionRecord.deriveTitle(from: record.entries)
        record.state = SessionState.recovered.rawValue
    }

    // ── internals ──

    private func record() -> SessionRecord? {
        modelContext.model(for: recordID) as? SessionRecord
    }

    /// Insert one finalized segment as a row (skipping blanks and positions
    /// already written), recomputing the placeholder title when the first
    /// thinker final makes a real one derivable.
    private func persist(_ segment: TranscriptSegment) {
        guard let record = record() else { return }
        persist(segment, into: record)
    }

    private func persist(_ segment: TranscriptSegment, into record: SessionRecord) {
        guard !segment.text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        guard !persistedIndexes.contains(segment.index) else { return }
        persistedIndexes.insert(segment.index)
        let row = SegmentRecord(
            speaker: segment.speaker.rawValue,
            text: segment.text,
            tier: segment.tier?.rawValue,
            turn: segment.turn,
            audioStart: segment.audioStart,
            audioEnd: segment.audioEnd,
            bargedIn: segment.bargedIn,
            index: segment.index
        )
        modelContext.insert(row)
        row.session = record
        if record.title == SessionRecord.placeholderTitle, segment.speaker == .thinker {
            record.title = SessionRecord.deriveTitle(from: record.entries)
        }
    }

    private func deleteRecordAndAudio(_ record: SessionRecord, alsoStemOf extra: String?) {
        if let name = record.audioFileName {
            RecordingStorage.deleteBoth(stem: RecordingStorage.stem(of: name))
        }
        if let extra {
            RecordingStorage.deleteBoth(stem: RecordingStorage.stem(of: extra))
        }
        modelContext.delete(record)
    }

    private func save() {
        try? modelContext.save()
    }
}

/// The launch-recovery ordering latch: `recoverIncompleteSessions` closes
/// every `recording`-state record it finds, so it MUST run before any new
/// session creates one — or it would adopt (and close as `recovered`) the
/// record of the session that just started. The app marks the gate done when
/// recovery finishes; `SessionController.startSession` awaits it before
/// creating a record. Same small-async-flag shape as AssetEnsure: one actor,
/// no polling.
actor RecoveryGate {
    static let shared = RecoveryGate()

    private var isDone = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    /// Recovery finished (successfully or not — the latch is about ordering,
    /// not outcome). Idempotent; releases every waiter.
    func markDone() {
        isDone = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }

    /// Suspend until recovery has run. Returns immediately once marked done.
    func waitUntilDone() async {
        guard !isDone else { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}
