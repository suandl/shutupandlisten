// PersistenceWriter against an in-memory container and a scripted event
// stream (plan Phase 4 test scenarios): every finalized segment is persisted
// as it arrives (no debounce — fetch after each event sees it), volatile
// events change nothing, close-out stamps the record complete, the zero-speech
// rule deletes record + audio, and launch recovery closes a `recording` record
// as `recovered` — dropping an unreadable audio reference but never the
// transcript.
//
// Runs in the ShutUpAndListenAppTests unit-test bundle (simulator or device).

import SwiftData
import TranscriptCore
import TurnEngine
import XCTest
@testable import ShutUpAndListen

final class WriterTests: XCTestCase {
    // ── fixtures ──

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: [config])
    }

    @MainActor
    private func makeRecordingRecord(
        in container: ModelContainer, audioFileName: String? = nil
    ) throws -> SessionRecord {
        let record = SessionRecord(
            startedAt: .now,
            title: SessionRecord.placeholderTitle,
            state: .recording,
            criteriaText: "",
            audioFileName: audioFileName
        )
        container.mainContext.insert(record)
        try container.mainContext.save()
        return record
    }

    private func thinkerFinal(
        index: Int, text: String, start: TimeInterval, end: TimeInterval, turn: Int = 1
    ) -> TranscriptSegment {
        TranscriptSegment(
            id: SegmentID(), speaker: .thinker, text: text, state: .final,
            audioStart: start, audioEnd: end, turn: turn, index: index
        )
    }

    private func listenerFinal(
        index: Int, text: String, start: TimeInterval, end: TimeInterval,
        tier: Tier = .question, turn: Int = 1
    ) -> TranscriptSegment {
        TranscriptSegment(
            id: SegmentID(), speaker: .listener, text: text, state: .final,
            audioStart: start, audioEnd: end, turn: turn, tier: tier, index: index
        )
    }

    /// Poll until the store holds `expected` segment rows — the writer runs on
    /// its own actor, so persistence is observed, not awaited.
    private func waitForSegmentCount(
        _ expected: Int, in container: ModelContainer, timeout: TimeInterval = 2
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let context = ModelContext(container)
            if try context.fetchCount(FetchDescriptor<SegmentRecord>()) == expected { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for \(expected) persisted segment(s)")
    }

    // ── per-final persistence ──

    @MainActor
    func testEachFinalizedSegmentPersistsImmediatelyAndVolatilesDoNot() async throws {
        let container = try makeContainer()
        let record = try makeRecordingRecord(in: container)
        let writer = PersistenceWriter(
            modelContainer: container, recordID: record.persistentModelID
        )
        let (stream, continuation) = AsyncStream.makeStream(of: TranscriptEvent.self)
        let runTask = Task { await writer.run(updates: stream) }

        // Volatile lifecycle events are ignored (only finals persist).
        var volatileSeg = thinkerFinal(index: 0, text: "So the", start: 0.4, end: 1.0)
        volatileSeg.state = .volatile
        continuation.yield(.segmentAdded(volatileSeg))
        continuation.yield(.segmentRevised(volatileSeg))
        continuation.yield(.turnStarted(turn: 1, atAudioTime: 0.4))

        // First final: persisted on arrival, and the placeholder title is
        // replaced by one derived from the first thinker segment.
        continuation.yield(.segmentFinalized(
            thinkerFinal(index: 0, text: "So the idea is a reading app.", start: 0.4, end: 2.1)
        ))
        try await waitForSegmentCount(1, in: container)

        var context = ModelContext(container)
        var records = try context.fetch(FetchDescriptor<SessionRecord>())
        XCTAssertEqual(records.first?.orderedSegments.map(\.text), ["So the idea is a reading app."])
        XCTAssertEqual(records.first?.title, "So the idea is a reading app.")
        XCTAssertEqual(records.first?.state, SessionState.recording.rawValue)

        // Second final: also persisted on arrival — per-final saves, no batch.
        continuation.yield(.segmentFinalized(
            listenerFinal(index: 1, text: "What would replace them?", start: 2.5, end: 4.0)
        ))
        try await waitForSegmentCount(2, in: container)

        context = ModelContext(container)
        records = try context.fetch(FetchDescriptor<SessionRecord>())
        let segments = try XCTUnwrap(records.first?.orderedSegments)
        XCTAssertEqual(segments.map(\.index), [0, 1])
        XCTAssertEqual(segments.map(\.speaker), ["thinker", "listener"])
        XCTAssertEqual(segments.last?.tier, Tier.question.rawValue)
        XCTAssertEqual(segments.first?.audioStart ?? 0, 0.4, accuracy: 0.001)
        XCTAssertEqual(segments.first?.audioEnd ?? 0, 2.1, accuracy: 0.001)
        XCTAssertTrue(records.first?.hasTimings ?? false)

        continuation.finish()
        await runTask.value
    }

    // ── close-out ──

    @MainActor
    func testCloseOutStampsCompleteAndReconcilesUnseenFinals() async throws {
        let container = try makeContainer()
        let record = try makeRecordingRecord(in: container)
        let recordID = record.id
        let writer = PersistenceWriter(
            modelContainer: container, recordID: record.persistentModelID
        )
        let (stream, continuation) = AsyncStream.makeStream(of: TranscriptEvent.self)
        let runTask = Task { await writer.run(updates: stream) }

        let first = thinkerFinal(index: 0, text: "It hides every number.", start: 1.0, end: 3.0)
        continuation.yield(.segmentFinalized(first))
        try await waitForSegmentCount(1, in: container)

        // The second final never went through the stream — closeOut must pick
        // it up from the snapshot (the drain-race reconciliation), and must
        // not duplicate the first.
        let second = thinkerFinal(index: 1, text: "Everything becomes a feeling.", start: 3.5, end: 5.0)
        // CoverageResult exposes no public memberwise init; go through Codable.
        let coverage = try JSONDecoder().decode(
            CoverageResult.self, from: Data(#"{"topics":[],"nudge":""}"#.utf8)
        )
        let kept = await writer.closeOut(
            duration: 61.5,
            audioFileName: "stem.m4a",
            coverage: coverage,
            criteria: "pricing",
            costUSD: 0.0231,
            finalSegments: [first, second]
        )
        XCTAssertTrue(kept)
        continuation.finish()
        await runTask.value

        let context = ModelContext(container)
        let records = try context.fetch(FetchDescriptor<SessionRecord>())
        XCTAssertEqual(records.count, 1)
        let closed = try XCTUnwrap(records.first)
        XCTAssertEqual(closed.id, recordID)
        XCTAssertEqual(closed.state, SessionState.complete.rawValue)
        XCTAssertEqual(closed.duration, 61.5, accuracy: 0.001)
        XCTAssertEqual(closed.audioFileName, "stem.m4a")
        XCTAssertEqual(closed.criteriaText, "pricing")
        XCTAssertNotNil(closed.coverageJSON)
        // The metered figure is written through to the record — this is what
        // SessionDetailView's cost readout reads, and the only close-out
        // coverage of the field the V2 migration goes to such lengths to carry.
        XCTAssertEqual(try XCTUnwrap(closed.costUSD), 0.0231, accuracy: 1e-9)
        XCTAssertEqual(closed.orderedSegments.map(\.text), [
            "It hides every number.",
            "Everything becomes a feeling.",
        ])
        XCTAssertEqual(closed.title, "It hides every number.")
    }

    @MainActor
    func testZeroSpeechCloseOutDeletesRecordAndAudio() async throws {
        let container = try makeContainer()
        // Plant both audio incarnations so the deletion can be observed.
        let stem = "writer-test-\(UUID().uuidString)"
        let cafName = RecordingStorage.cafFileName(stem: stem)
        let m4aName = RecordingStorage.m4aFileName(stem: stem)
        try Data("caf".utf8).write(to: RecordingStorage.url(for: cafName))
        try Data("m4a".utf8).write(to: RecordingStorage.url(for: m4aName))

        let record = try makeRecordingRecord(in: container, audioFileName: cafName)
        let writer = PersistenceWriter(
            modelContainer: container, recordID: record.persistentModelID
        )

        // Only a listener segment — no finalized thinker speech.
        // costUSD nil is the unmetered path (cost unknown, not zero); the
        // zero-speech rule deletes the record before it could be written.
        let kept = await writer.closeOut(
            duration: 10,
            audioFileName: m4aName,
            coverage: nil,
            criteria: "",
            costUSD: nil,
            finalSegments: [listenerFinal(index: 0, text: "mm", start: 1, end: 2, tier: .acknowledge)]
        )
        XCTAssertFalse(kept)

        let context = ModelContext(container)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<SessionRecord>()), 0)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<SegmentRecord>()), 0)
        XCTAssertFalse(RecordingStorage.exists(fileName: cafName))
        XCTAssertFalse(RecordingStorage.exists(fileName: m4aName))
    }

    // ── launch recovery ──

    @MainActor
    func testRecoveryKeepsTranscriptDropsUnreadableAudio() async throws {
        let container = try makeContainer()
        // A CAF path that does not exist on disk: the audio is unreadable, so
        // recovery must drop the reference and keep the transcript.
        let record = try makeRecordingRecord(
            in: container, audioFileName: "missing-\(UUID().uuidString).caf"
        )
        let row = SegmentRecord(
            speaker: "thinker", text: "Words that survived the crash.", tier: nil,
            turn: 1, audioStart: 0.5, audioEnd: 3.25, bargedIn: false, index: 0
        )
        container.mainContext.insert(row)
        row.session = record
        try container.mainContext.save()

        PersistenceWriter.recoverIncompleteSessions(container: container)

        let context = ModelContext(container)
        let records = try context.fetch(FetchDescriptor<SessionRecord>())
        XCTAssertEqual(records.count, 1)
        let recovered = try XCTUnwrap(records.first)
        XCTAssertEqual(recovered.state, SessionState.recovered.rawValue)
        XCTAssertNil(recovered.audioFileName, "unreadable audio → reference dropped")
        XCTAssertEqual(recovered.orderedSegments.map(\.text), ["Words that survived the crash."])
        XCTAssertEqual(
            recovered.duration, 3.25, accuracy: 0.001,
            "duration falls back to the last segment's audioEnd"
        )
        XCTAssertEqual(recovered.title, "Words that survived the crash.")
    }

    @MainActor
    func testRecoveryDeletesZeroSpeechRecordAndAudio() async throws {
        let container = try makeContainer()
        let stem = "recovery-test-\(UUID().uuidString)"
        let cafName = RecordingStorage.cafFileName(stem: stem)
        try Data("caf".utf8).write(to: RecordingStorage.url(for: cafName))
        _ = try makeRecordingRecord(in: container, audioFileName: cafName)

        PersistenceWriter.recoverIncompleteSessions(container: container)

        let context = ModelContext(container)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<SessionRecord>()), 0)
        XCTAssertFalse(RecordingStorage.exists(fileName: cafName))
    }

    @MainActor
    func testRecoveryLeavesFinishedRecordsAlone() async throws {
        let container = try makeContainer()
        let record = try makeRecordingRecord(in: container)
        record.state = SessionState.complete.rawValue
        try container.mainContext.save()

        PersistenceWriter.recoverIncompleteSessions(container: container)

        let context = ModelContext(container)
        let records = try context.fetch(FetchDescriptor<SessionRecord>())
        XCTAssertEqual(records.first?.state, SessionState.complete.rawValue)
    }
}
