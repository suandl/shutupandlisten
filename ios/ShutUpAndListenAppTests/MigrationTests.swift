// The V1 → V2 migration stage, against a real fixture store (plan Phase 4
// test scenarios): a store written under SchemaV1 (whole-transcript
// `transcriptJSON` blobs) reopened through SessionMigrationPlan must come out
// with ordered SegmentRecord rows (index = array order, zeroed time ranges),
// state `complete`, and the legacy blob kept. The lazy-materialize guard rail
// (a V2 record that somehow still has only a blob) must render on read.
//
// NOTE: this target is not yet wired into the Xcode project — see README.md.

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

    private func fixtureJSON() throws -> Data {
        try JSONEncoder().encode([
            StoredEntry(speaker: "thinker", text: "So the idea is a reading app.", tier: nil, turn: 1),
            StoredEntry(speaker: "listener", text: "mm", tier: "acknowledge", turn: 1),
            StoredEntry(speaker: "thinker", text: "It hides every number.", tier: nil, turn: 2),
            StoredEntry(speaker: "listener", text: "What replaces them?", tier: "question", turn: 2),
        ])
    }

    /// Write one record into a V1-schema store at `storeURL`, then release the
    /// container so V2 can reopen the file.
    private func writeV1Fixture() throws {
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
            transcriptJSON: try fixtureJSON(),
            criteriaText: "pricing"
        )
        context.insert(record)
        try context.save()
        // `container` and `context` go out of scope here, releasing the file.
    }

    private func openV2() throws -> ModelContainer {
        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        let config = ModelConfiguration(schema: schema, url: storeURL)
        return try ModelContainer(
            for: schema,
            migrationPlan: SessionMigrationPlan.self,
            configurations: [config]
        )
    }

    func testMigrationMaterializesOrderedSegmentRows() throws {
        try writeV1Fixture()
        let container = try openV2()
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
        let container = try openV2()
        let context = ModelContext(container)
        let record = try XCTUnwrap(context.fetch(FetchDescriptor<SessionRecord>()).first)

        XCTAssertTrue(record.hasThreadPull)
        XCTAssertTrue(record.searchableText.contains("hides every number"))
        XCTAssertTrue(record.markdown.contains("**Listener (thread-pull):** What replaces them?"))
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
}
