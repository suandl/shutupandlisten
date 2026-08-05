// The orphan sweep (`SessionRecovery.adoptOrphanedRecordings`) — the half of
// launch recovery the transcript-core port KEEPS, and the two things the port
// plan requires of it (§1b, §1f).
//
// It covers a failure the writer's own recovery path cannot: an audio file on
// disk with NO owning record. Record-at-start makes that impossible going
// forward, but a device that ran a pre-port build can already be in it, since
// those builds only referenced the recording once the first checkpoint ran.
//
// NOTE: this target is not yet wired into the Xcode project — see README.md.

import AVFoundation
import SwiftData
import TranscriptCore
import TurnEngine
import XCTest
@testable import ShutUpAndListen

final class RecoveryTests: XCTestCase {
    private var written: [String] = []

    override func tearDownWithError() throws {
        for name in written { RecordingStorage.delete(fileName: name) }
        written = []
    }

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: [config])
    }

    /// Write a real, readable .m4a of `seconds` into RecordingStorage — the
    /// sweep opens the container to read its duration, so a stub file would be
    /// deleted as unrecoverable rather than adopted.
    @discardableResult
    private func writeRecording(seconds: Double) throws -> String {
        let name = UUID().uuidString + ".m4a"
        let url = RecordingStorage.url(for: name)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100.0,
            AVNumberOfChannelsKey: 1,
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings)
        let format = file.processingFormat
        let frames = AVAudioFrameCount(format.sampleRate * seconds)
        let buffer = try XCTUnwrap(
            AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
        )
        buffer.frameLength = frames
        if let channel = buffer.floatChannelData?[0] {
            // Quiet but non-silent, so nothing downstream treats it as empty.
            for i in 0 ..< Int(frames) {
                channel[i] = 0.01 * sin(Float(i) * 0.01)
            }
        }
        try file.write(from: buffer)
        written.append(name)
        return name
    }

    /// §1b — the adopted row must be VISIBLE.
    ///
    /// Under V2 the `SessionRecord` initializer defaults `state` to
    /// `.recording`, and LibraryView's query is
    /// `#Predicate<SessionRecord> { $0.state != "recording" }`. Every argument
    /// the pre-port insert passed still type-checks against V2, so an insert
    /// that forgot to name its state would compile, run, adopt the file, and
    /// produce a row no user could ever see — the exact failure the sweep
    /// exists to prevent. No compiler error, no runtime error.
    @MainActor
    func testAdoptedOrphanRowIsRecoveredAndVisible() throws {
        let container = try makeContainer()
        let context = container.mainContext
        let orphan = try writeRecording(seconds: 2)

        SessionRecovery.adoptOrphanedRecordings(in: context)

        let records = try context.fetch(FetchDescriptor<SessionRecord>())
        let adopted = try XCTUnwrap(
            records.first { $0.audioFileName == orphan },
            "the orphan was not adopted at all"
        )
        XCTAssertEqual(adopted.state, SessionState.recovered.rawValue,
                       "the adopted row must name .recovered, not default to .recording")
        XCTAssertEqual(adopted.sessionState, .recovered)

        // …and it must survive the library's own predicate, which is the thing
        // that actually decides whether the user ever sees it.
        let visible = try context.fetch(
            FetchDescriptor<SessionRecord>(
                predicate: #Predicate<SessionRecord> { $0.state != "recording" }
            )
        )
        XCTAssertTrue(
            visible.contains { $0.audioFileName == orphan },
            "the adopted row is filtered out of the library — invisible recovery"
        )
    }

    /// A file that already has an owning record is not an orphan, whatever
    /// state that record is in. This is the other half of "no duplicates".
    @MainActor
    func testOwnedRecordingIsNotAdoptedTwice() throws {
        let container = try makeContainer()
        let context = container.mainContext
        let owned = try writeRecording(seconds: 2)

        let existing = SessionRecord(
            startedAt: .now, duration: 2, title: "already mine",
            state: .complete, criteriaText: "", audioFileName: owned
        )
        context.insert(existing)
        try context.save()

        SessionRecovery.adoptOrphanedRecordings(in: context)

        let matching = try context.fetch(FetchDescriptor<SessionRecord>())
            .filter { $0.audioFileName == owned }
        XCTAssertEqual(matching.count, 1, "an owned file must never gain a second record")
        XCTAssertEqual(matching.first?.title, "already mine")
    }

    /// §1f — THE TWO LAUNCH SWEEPS ARE NOT COMMUTATIVE.
    ///
    /// `PersistenceWriter.recoverIncompleteSessions` remuxes a crashed CAF to
    /// .m4a and then adopts it into its record. Between the remux and the save
    /// there is a window where a finished-looking .m4a exists whose record does
    /// not yet point at it — an orphan sweep running inside that window adopts
    /// a DUPLICATE "Recovered recording" for audio that already has a home.
    ///
    /// The fix is ordering: the sweep runs behind `RecoveryGate`, the same
    /// latch `startSession` waits on. This asserts the observable consequence —
    /// the sweep does not begin until the gate is marked done, and by then the
    /// writer's path has already claimed its file.
    ///
    /// PRECONDITION: `RecoveryGate.shared` is a process-wide singleton and its
    /// latch is one-way, so this must be the only test that marks it done — a
    /// gate already open would let the sweep run immediately and fail this for
    /// the wrong reason. It is, and alphabetical method ordering puts it ahead
    /// of nothing else that touches the gate.
    func testOrphanSweepRunsAfterRecoveryGate() async throws {
        let container = try makeContainer()
        let claimed = try writeRecording(seconds: 2)

        let sweepRan = expectation(description: "orphan sweep ran")
        // The sweep, wired exactly as `SessionController.configure` wires it.
        let sweep = Task { @MainActor in
            await RecoveryGate.shared.waitUntilDone()
            SessionRecovery.adoptOrphanedRecordings(in: container.mainContext)
            sweepRan.fulfill()
        }

        // Stand in for the writer's recovery path: it claims the file BEFORE
        // marking the gate done. If the sweep did not wait, it would run here,
        // see a record-less .m4a, and adopt a duplicate.
        await MainActor.run {
            let recovered = SessionRecord(
                startedAt: .now, duration: 2, title: "Recovered recording",
                state: .recovered, criteriaText: "", audioFileName: claimed
            )
            container.mainContext.insert(recovered)
            try? container.mainContext.save()
        }
        await RecoveryGate.shared.markDone()

        await fulfillment(of: [sweepRan], timeout: 5)
        _ = await sweep.value

        // Count inside the hop, not outside it: `MainActor.run` returns its
        // value across an actor boundary, so returning the rows themselves asks
        // for `[SessionRecord]: Sendable` — a conformance SwiftData marks
        // unavailable, exactly to stop model objects escaping their context.
        // The assertion only ever wanted the count.
        let matching = try await MainActor.run {
            try container.mainContext.fetch(FetchDescriptor<SessionRecord>())
                .filter { $0.audioFileName == claimed }
                .count
        }
        XCTAssertEqual(
            matching, 1,
            "the sweep ran before the gate and adopted a duplicate for already-claimed audio"
        )
    }
}
