// The V1 → V2 migration, against a real fixture store (plan Phase 4 test
// scenarios): a store written under SchemaV1 (whole-transcript
// `transcriptJSON` blobs), reopened the way the app reopens it, must come out
// with ordered SegmentRecord rows (index = array order), state `complete`, and
// the legacy blob kept. The lazy-materialize guard rail (a V2 record that
// somehow still has only a blob) must render on read.
//
// The app reaches V2 in TWO halves — inferred migration for the SHAPE, then
// `PersistenceWriter.materializeLegacyRecords` for the DATA — because a staged
// plan cannot open a shipped store at all (see the foot of this file). Cases
// that need rows therefore go through `migrateFixture()`, which runs both in
// the order the app runs them.
//
// This is THE DATA-SAFETY GATE of the transcript-core port (port plan §5.3,
// §5.5). TWO inbound shapes are real after the port, and both are covered here:
//
//   base-era  (pre-PR#37)  no timings in the blob → zeroed ranges, no replay.
//                          Asserted as a NEGATIVE, so the timing fix can never
//                          become "invent timings that were never recorded".
//   PR#37-era (current main) startMs/endMs in the blob → real ranges, replay.
//
// The PR#37 cases go through the REAL migration path, not through
// `TranscriptCore.segments(from:)` directly, and that is the entire point: the
// backfill runs `materializeLegacySegments(in:)`, which is where the timings
// were being dropped. A test that asserts on `segments(from:)` passes with the
// bug fully intact.
//
// Both inbound shapes above are written through a VERSIONED V1 schema, which
// no shipped store ever was — see `testShippedUnversionedStoreUpgradesToV2` at
// the foot of this file for the case that covers a store's provenance rather
// than its fields, and why every other case here can pass while the upgrade a
// real user performs fails.
//
// NOTE: this target is not yet wired into the Xcode project — see README.md.
// Until an operator does that (a Mac/Xcode GUI step), none of this runs.

import SwiftData
import TranscriptCore
import XCTest
@testable import ShutUpAndListen

final class MigrationTests: XCTestCase {
    private var storeURL: URL!

    override func setUpWithError() throws {
        storeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("migration-\(UUID().uuidString).store")
    }

    override func tearDownWithError() throws {
        // The store plus SQLite sidecar files.
        let base = storeURL.path
        for suffix in ["", "-shm", "-wal"] {
            try? FileManager.default.removeItem(atPath: base + suffix)
        }
    }

    /// A base-era (pre-PR#37) blob: the four original keys, no timings. This
    /// is what a device that never ran a PR#37 build has on disk.
    private func fixtureJSON() throws -> Data {
        try JSONEncoder().encode(baseEntries)
    }

    private var baseEntries: [StoredEntry] {
        [
            StoredEntry(speaker: "thinker", text: "So the idea is a reading app.", tier: nil, turn: 1),
            StoredEntry(speaker: "listener", text: "mm", tier: "acknowledge", turn: 1),
            StoredEntry(speaker: "thinker", text: "It hides every number.", tier: nil, turn: 2),
            StoredEntry(speaker: "listener", text: "What replaces them?", tier: "question", turn: 2),
        ]
    }

    /// The SAME transcript, in the shape PR#37 actually wrote: every entry
    /// carrying startMs/endMs.
    private var pr37Entries: [StoredEntry] {
        [
            StoredEntry(speaker: "thinker", text: "So the idea is a reading app.", tier: nil,
                        turn: 1, startMs: 1500, endMs: 4200),
            StoredEntry(speaker: "listener", text: "mm", tier: "acknowledge",
                        turn: 1, startMs: 4300, endMs: 4800),
            StoredEntry(speaker: "thinker", text: "It hides every number.", tier: nil,
                        turn: 2, startMs: 5000, endMs: 7250),
            StoredEntry(speaker: "listener", text: "What replaces them?", tier: "question",
                        turn: 2, startMs: 7400, endMs: 9100),
        ]
    }

    /// Write one record into a V1-schema store at `storeURL`, then release the
    /// container so V2 can reopen the file.
    ///
    /// Defaults to the base-era blob so the pre-existing cases keep asserting
    /// exactly what they always asserted; the PR#37 cases pass their own
    /// entries. The V1 MODEL is the PR#37 shape either way — that is §5.2's
    /// point, and `testV1FixtureIsPR37Shape` pins it.
    @discardableResult
    private func writeV1Fixture(
        entries: [StoredEntry]? = nil,
        costUSD: Double? = nil,
        transcriptIsReconciled: Bool = false
    ) throws -> Data {
        let blob = try JSONEncoder().encode(entries ?? baseEntries)
        let schema = Schema(versionedSchema: SessionSchemaV1.self)
        // SDK-CHECK: ModelConfiguration(schema:url:) — the url-pinned
        // configuration initializer.
        let config = ModelConfiguration(schema: schema, url: storeURL)
        let container = try ModelContainer(for: schema, configurations: [config])
        let context = ModelContext(container)
        let record = SessionSchemaV1.SessionRecord(
            startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            duration: 61,
            title: "So the idea is a reading app.",
            transcriptJSON: blob,
            criteriaText: "pricing",
            costUSD: costUSD,
            transcriptIsReconciled: transcriptIsReconciled
        )
        context.insert(record)
        try context.save()
        // `container` and `context` go out of scope here, releasing the file.
        return blob
    }

    /// Exactly how the app opens the library (`openContainer`), minus the
    /// pinned URL: inferred migration, no plan.
    private func openV2() throws -> ModelContainer {
        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        let config = ModelConfiguration(schema: schema, url: storeURL)
        return try ModelContainer(for: schema, configurations: [config])
    }

    /// The app's whole launch sequence over a legacy store: open, then backfill.
    /// The cases below go through this rather than `openV2` alone, because the
    /// row materialization that used to happen inside the migration stage is
    /// now the backfill's job.
    private func migrateFixture() throws -> ModelContainer {
        let container = try openV2()
        PersistenceWriter.materializeLegacyRecords(container: container)
        return container
    }

    // ── §5.5 items 1–5: the port's data-safety set ──

    /// V1 is declared at the PR#37 shape, not the base shape. The rewrite's own
    /// V1 was a snapshot of the base — it had never seen PR#37 — and landing
    /// that would point SwiftData's migration source at a shape matching no
    /// device that ran a current-main build. Both PR#37 fields are
    /// lightweight-inferrable from the true base (costUSD optional,
    /// transcriptIsReconciled defaulted), so ONE V1 covers both shipped stores.
    func testV1FixtureIsPR37Shape() throws {
        try writeV1Fixture(costUSD: 0.0042, transcriptIsReconciled: true)

        // Reopen as V1 and read the PR#37 fields back: if either were missing
        // from the declaration this would not compile, and if the store did not
        // round-trip them it would not pass.
        let schema = Schema(versionedSchema: SessionSchemaV1.self)
        let config = ModelConfiguration(schema: schema, url: storeURL)
        let container = try ModelContainer(for: schema, configurations: [config])
        let context = ModelContext(container)
        let record = try XCTUnwrap(
            context.fetch(FetchDescriptor<SessionSchemaV1.SessionRecord>()).first
        )
        XCTAssertEqual(try XCTUnwrap(record.costUSD), 0.0042, accuracy: 1e-9,
                       "V1 carries PR#37's costUSD")
        XCTAssertTrue(record.transcriptIsReconciled,
                      "V1 carries PR#37's transcriptIsReconciled")
    }

    /// `costUSD` must survive into V2. The rewrite's V2 omitted it; dropping it
    /// would silently void SessionDetailView's cost readout for every past
    /// session.
    func testCostUSDSurvivesV1ToV2() throws {
        try writeV1Fixture(costUSD: 0.0137)
        let context = ModelContext(try openV2())
        let record = try XCTUnwrap(context.fetch(FetchDescriptor<SessionRecord>()).first)

        XCTAssertEqual(try XCTUnwrap(record.costUSD), 0.0137, accuracy: 1e-9,
                       "the cost readout survives the shape transform")
    }

    /// THE most valuable case in this file (§5.3 part 2). A PR#37-era blob,
    /// seeded and taken through the REAL launch sequence, must materialize rows
    /// with real ranges. Going through that sequence is the whole point: it is
    /// the only thing that exercises `materializeLegacySegments(in:)`, which is
    /// where the drop actually happened. Asserting on
    /// `TranscriptCore.segments(from:)` instead would pass with the bug intact.
    func testMigrationCarriesPR37Timings() throws {
        try writeV1Fixture(entries: pr37Entries)
        let context = ModelContext(try migrateFixture())
        let record = try XCTUnwrap(context.fetch(FetchDescriptor<SessionRecord>()).first)

        let segments = record.orderedSegments
        XCTAssertEqual(segments.count, 4)
        XCTAssertEqual(segments.map(\.audioStart), [1.5, 4.3, 5.0, 7.4],
                       "startMs → audioStart, ÷1000")
        XCTAssertEqual(segments.map(\.audioEnd), [4.2, 4.8, 7.25, 9.1],
                       "endMs → audioEnd, ÷1000")
        XCTAssertTrue(record.hasTimings,
                      "a PR#37-era session GAINS working replay through the port")
        // Order is unchanged by the timings — real ranges sort to the same
        // sequence the index tiebreak was standing in for.
        XCTAssertEqual(segments.map(\.index), [0, 1, 2, 3])
        XCTAssertEqual(segments.map(\.text), pr37Entries.map(\.text))
    }

    /// The backfill and the lazy read-path fallback must agree: a record
    /// must not gain or lose replay depending on which one reached it. The
    /// stage goes through `materializeLegacySegments(in:)`; the fallback goes
    /// through `TranscriptCore.segments(from:)`. Two functions, one contract.
    @MainActor
    func testMaterializedRowsAgreeWithLazyFallback() throws {
        let blob = try writeV1Fixture(entries: pr37Entries)

        // (a) through the real launch sequence.
        let migrated = try XCTUnwrap(
            ModelContext(try migrateFixture()).fetch(FetchDescriptor<SessionRecord>()).first
        )
        XCTAssertFalse(migrated.segments.isEmpty, "precondition: the backfill materialized rows")
        let migratedSegments = migrated.transcriptSegments

        // (b) the same blob on a record the stage never touched.
        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        let memory = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        let untouched = SessionRecord(
            startedAt: .now, duration: 61, title: "t", state: .complete,
            transcriptJSON: blob, criteriaText: ""
        )
        memory.mainContext.insert(untouched)
        try memory.mainContext.save()
        XCTAssertTrue(untouched.segments.isEmpty, "precondition: no rows — the fallback path")
        let fallbackSegments = untouched.transcriptSegments

        XCTAssertEqual(migratedSegments.map(\.audioStart), fallbackSegments.map(\.audioStart),
                       "materializer and fallback must produce identical ranges")
        XCTAssertEqual(migratedSegments.map(\.audioEnd), fallbackSegments.map(\.audioEnd))
        XCTAssertEqual(migratedSegments.map(\.text), fallbackSegments.map(\.text))
        XCTAssertEqual(migrated.hasTimings, hasTimings(fallbackSegments),
                       "and must agree about whether replay is available at all")

        // The property, not just the segments. `record.hasTimings` is what
        // SessionDetailView gates tap-to-seek and highlighting on, so the two
        // paths agreeing about their SEGMENTS is not enough: a `hasTimings`
        // that reads only the stored rows returns false here, and this record
        // renders static while holding the timings to drive replay.
        XCTAssertTrue(untouched.hasTimings,
                      "the fallback path keeps replay — timed segments, timed record")
        XCTAssertEqual(untouched.hasTimings, migrated.hasTimings,
                       "the property must not depend on which path reached the record")
    }

    /// The negative that keeps the timing fix honest: a base-era blob carried
    /// no timings, so nothing may be invented for it. Zeroed ranges in,
    /// zeroed ranges out, `hasTimings == false`, static detail view — exactly
    /// as before the port.
    func testBaseShapeYieldsZeroedRangesAndNoTimings() throws {
        try writeV1Fixture(entries: baseEntries)
        let context = ModelContext(try migrateFixture())
        let record = try XCTUnwrap(context.fetch(FetchDescriptor<SessionRecord>()).first)

        let segments = record.orderedSegments
        XCTAssertEqual(segments.count, 4)
        XCTAssertTrue(
            segments.allSatisfy { $0.audioStart == 0 && $0.audioEnd == 0 },
            "no timings were ever recorded for these — none may be invented"
        )
        XCTAssertFalse(record.hasTimings, "degrades to the static view, as it always did")
        XCTAssertEqual(segments.map(\.index), [0, 1, 2, 3], "order still comes from the index")
    }

    // ── §5.5 item 6: the pre-existing three, kept as they were ──

    func testMigrationMaterializesOrderedSegmentRows() throws {
        try writeV1Fixture()
        let container = try migrateFixture()
        let context = ModelContext(container)

        let records = try context.fetch(FetchDescriptor<SessionRecord>())
        XCTAssertEqual(records.count, 1)
        let record = try XCTUnwrap(records.first)

        XCTAssertEqual(record.state, SessionState.complete.rawValue)
        XCTAssertNotNil(record.transcriptJSON, "legacy blob is kept, not dropped")

        let segments = record.orderedSegments
        XCTAssertEqual(segments.map(\.text), [
            "So the idea is a reading app.",
            "mm",
            "It hides every number.",
            "What replaces them?",
        ])
        XCTAssertEqual(segments.map(\.index), [0, 1, 2, 3], "index = array order")
        XCTAssertEqual(segments.map(\.speaker), ["thinker", "listener", "thinker", "listener"])
        XCTAssertEqual(segments.map(\.turn), [1, 1, 2, 2])
        XCTAssertEqual(segments.map(\.tier), [nil, "acknowledge", nil, "question"])
        XCTAssertTrue(
            segments.allSatisfy { $0.audioStart == 0 && $0.audioEnd == 0 },
            "old records carry no timings — ranges must be zeroed"
        )
        XCTAssertFalse(record.hasTimings, "zeroed ranges degrade to the static view")

        // Untouched V1 fields survive.
        XCTAssertEqual(record.duration, 61, accuracy: 0.001)
        XCTAssertEqual(record.criteriaText, "pricing")
        XCTAssertEqual(record.title, "So the idea is a reading app.")
    }

    func testMigratedRecordDerivedViewsComeFromSegments() throws {
        try writeV1Fixture()
        let container = try migrateFixture()
        let context = ModelContext(container)
        let record = try XCTUnwrap(context.fetch(FetchDescriptor<SessionRecord>()).first)

        XCTAssertTrue(record.hasThreadPull)
        XCTAssertTrue(record.searchableText.contains("hides every number"))
        XCTAssertTrue(record.markdown.contains("**Listener (thread-pull):** What replaces them?"))
    }

    /// SessionDetailView's open-question card reads `openQuestion` AND
    /// `openQuestionAnsweredByThinker` — the check mark under the question. The
    /// port dropped the second from the V2 extension while both call sites
    /// stayed, which broke the app target's compile. Pin both polarities so the
    /// pair cannot drift apart again.
    @MainActor
    func testOpenQuestionAnsweredByThinkerReadsEntriesAfterTheQuestion() throws {
        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        let container = try ModelContainer(
            for: schema,
            configurations: [ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)]
        )
        func makeRecord(_ entries: [StoredEntry]) throws -> SessionRecord {
            let record = SessionRecord(
                startedAt: .now, duration: 61, title: "t", state: .complete,
                transcriptJSON: try JSONEncoder().encode(entries), criteriaText: ""
            )
            container.mainContext.insert(record)
            try container.mainContext.save()
            return record
        }

        // The fixture ends ON the question: the thinker left with it open.
        let unanswered = try makeRecord(baseEntries)
        XCTAssertEqual(unanswered.openQuestion, "What replaces them?")
        XCTAssertFalse(unanswered.openQuestionAnsweredByThinker,
                       "nothing follows the last question — still open")

        // A thinker turn after that question is the attempt.
        let answered = try makeRecord(baseEntries + [
            StoredEntry(speaker: "thinker", text: "Maybe a shape.", tier: nil, turn: 3),
        ])
        XCTAssertEqual(answered.openQuestion, "What replaces them?",
                       "the card still shows the same question")
        XCTAssertTrue(answered.openQuestionAnsweredByThinker,
                      "picked it up before stopping")

        // Silence dressed as speech is not an attempt.
        let blank = try makeRecord(baseEntries + [
            StoredEntry(speaker: "thinker", text: "   ", tier: nil, turn: 3),
        ])
        XCTAssertFalse(blank.openQuestionAnsweredByThinker,
                       "a whitespace-only turn never answered anything")
    }

    /// The guard rail: a V2 record that still has ONLY the legacy blob (the
    /// stage never touched it) must decode on read — same order, zeroed
    /// ranges — without anyone inserting rows.
    @MainActor
    func testLazyMaterializerDecodesLegacyBlobOnRead() throws {
        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [config])
        let record = SessionRecord(
            startedAt: .now,
            duration: 61,
            title: "So the idea is a reading app.",
            state: .complete,
            transcriptJSON: try fixtureJSON(),
            criteriaText: ""
        )
        container.mainContext.insert(record)
        try container.mainContext.save()

        XCTAssertTrue(record.segments.isEmpty, "precondition: no rows materialized")
        let segments = record.transcriptSegments
        XCTAssertEqual(segments.map(\.text), [
            "So the idea is a reading app.",
            "mm",
            "It hides every number.",
            "What replaces them?",
        ])
        XCTAssertEqual(segments.map(\.index), [0, 1, 2, 3])
        XCTAssertTrue(segments.allSatisfy { $0.audioStart == 0 && $0.audioEnd == 0 })
        XCTAssertFalse(record.hasTimings)
        XCTAssertTrue(record.segments.isEmpty, "the read path must not insert rows")
        XCTAssertTrue(record.hasThreadPull)
    }

    // ── The shipped store's PROVENANCE, not just its shape ──

    /// Every case above writes its fixture through
    /// `Schema(versionedSchema: SessionSchemaV1.self)`, which stamps the store
    /// with V1's version identifier. NO SHIPPED STORE WAS EVER CREATED THAT
    /// WAY. The base-era app opened its library with the convenience modifier
    /// (`.modelContainer(for: SessionRecord.self)`, a3437ce) — an UNVERSIONED
    /// schema — so every device that ran a pre-port build has a store carrying
    /// no version identifier the migration manager can name.
    ///
    /// `testV1FixtureIsPR37Shape` pins the fixture's FIELDS to the shipped
    /// shape and is right to; this pins the thing it does not cover, which is
    /// how the store was created. The distinction is invisible to every other
    /// test here and is precisely why they can all pass while the real upgrade
    /// fails: SwiftData's `DefaultMigrationManager` must identify the store's
    /// model version among the plan's `schemas` before running any stage, and
    /// an unversioned store gives it nothing to match — NSCocoaErrorDomain
    /// 134504, "Cannot use staged migration with an unknown model version".
    ///
    /// So this is the only case in the file that exercises the upgrade a real
    /// user performs: a store created the way the app shipped, reopened the way
    /// the app reopens it.
    func testShippedUnversionedStoreUpgradesToV2() throws {
        try writeShippedUnversionedFixture()

        let container = try migrateFixture()
        let context = ModelContext(container)
        let record = try XCTUnwrap(
            context.fetch(FetchDescriptor<SessionRecord>()).first,
            "the shipped record must survive the upgrade"
        )

        XCTAssertEqual(
            record.state, SessionState.complete.rawValue,
            "every pre-port record is a finished session"
        )
        XCTAssertEqual(
            record.transcriptSegments.map(\.text),
            baseEntries.map(\.text),
            "no line of transcript may be lost upgrading a shipped store"
        )
    }

    /// The backfill is no longer a one-shot migration stage — it runs at EVERY
    /// launch — so a second pass over an already-migrated store must not
    /// duplicate rows.
    func testBackfillIsIdempotent() throws {
        try writeV1Fixture()
        let container = try migrateFixture()
        PersistenceWriter.materializeLegacyRecords(container: container)

        let context = ModelContext(container)
        XCTAssertEqual(try context.fetch(FetchDescriptor<SegmentRecord>()).count, 4)
        let record = try XCTUnwrap(context.fetch(FetchDescriptor<SessionRecord>()).first)
        XCTAssertEqual(record.segments.count, 4)
    }

    /// The SHAPE half alone. Inference must carry a V1 record across with its
    /// blob intact and pick up `state`'s declaration default — which is what
    /// keeps a migrated record out of launch recovery's `recording` fetch. No
    /// rows yet: those are the backfill's job, and until it runs the guard rail
    /// is what renders the transcript.
    func testInferredMigrationTransformsShapeWithoutTheBackfill() throws {
        try writeV1Fixture()
        let context = ModelContext(try openV2())
        let record = try XCTUnwrap(context.fetch(FetchDescriptor<SessionRecord>()).first)

        XCTAssertEqual(
            record.state, SessionState.complete.rawValue,
            "every V1 record is a finished session"
        )
        XCTAssertNotNil(record.transcriptJSON, "legacy blob is kept, not dropped")
        XCTAssertTrue(record.segments.isEmpty, "rows are the backfill's job")
        XCTAssertTrue(
            record.hasThreadPull,
            "the guard rail renders the blob before the backfill reaches it"
        )
    }

    /// Write one record the way the SHIPPED app did: an unversioned schema, via
    /// the model type alone. `ShippedBaseSchema.SessionRecord` is nested only to
    /// avoid colliding with the app's `SessionRecord` typealias in this file —
    /// SwiftData names the entity from the CLASS name, so the store this
    /// produces is byte-identical to a real base-era one.
    private func writeShippedUnversionedFixture() throws {
        // SDK-CHECK: ModelConfiguration(url:) — no `schema:`, matching the
        // convenience modifier's unversioned container.
        let config = ModelConfiguration(url: storeURL)
        let container = try ModelContainer(
            for: ShippedBaseSchema.SessionRecord.self,
            configurations: config
        )
        let context = ModelContext(container)
        context.insert(
            ShippedBaseSchema.SessionRecord(
                startedAt: Date(timeIntervalSince1970: 1_700_000_000),
                duration: 61,
                title: "So the idea is a reading app.",
                transcriptJSON: try fixtureJSON(),
                criteriaText: "pricing"
            )
        )
        try context.save()
        // Container and context go out of scope here, releasing the file.
    }
}

/// The base-era (pre-PR#37) `SessionRecord`, reproduced verbatim from a3437ce
/// so a test can create a store with the provenance a shipped one has. Nested
/// in an enum purely for name isolation; the entity name SwiftData records is
/// `SessionRecord`, exactly as on a real device.
enum ShippedBaseSchema {
    @Model
    final class SessionRecord {
        var id: UUID
        var startedAt: Date
        var duration: TimeInterval
        var title: String
        /// JSON-encoded `[StoredEntry]`. NON-optional at the base shape.
        var transcriptJSON: Data
        var criteriaText: String
        var coverageJSON: Data?
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
    }
}
