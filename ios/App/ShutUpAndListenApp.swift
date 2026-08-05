// Talk-first root: the app opens INTO the session screen — mic ready, one
// tap to talk. The library and settings live behind toolbar icons on that
// screen. When a session ends and a record was saved, the root navigates to
// the saved record's detail — the artifact is the second act, not a toast.
//
// Two further responsibilities live here after the transcript-core port
// (docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, R3):
//
// 1. The ModelContainer is built EXPLICITLY at SchemaV2, with INFERRED
//    migration and deliberately no `migrationPlan:` — see `openContainer` for
//    why the staged plan cannot open a shipped store, and what carries the
//    V1 → V2 data work instead.
// 2. Launch recovery: records a crash left in `recording` state are closed as
//    `recovered` (CAF remuxed and adopted; zero-speech deleted). It runs on a
//    background task at init — the library's query filters `recording`-state
//    rows, so nothing half-open is visible while recovery works; recovered
//    sessions appear when it saves. The legacy backfill runs FIRST on that
//    same task: it is the data half of the V1 → V2 migration.

import SwiftData
import SwiftUI

@main
struct ShutUpAndListenApp: App {
    @StateObject private var controller = SessionController()
    @StateObject private var accountStore = AccountStore()
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @Environment(\.scenePhase) private var scenePhase

    private let container: ModelContainer

    init() {
        #if DEBUG
        // Arm the CI capture seams before any view renders or request is made.
        // Inert unless launched with -uiTestCapture. The seam is compiled out
        // of Release (su-uzy9.1, f4), so this whole block is absent there.
        // This is the DEBUG half of the seam's two mechanisms — the Release
        // half is EXCLUDED_SOURCE_FILE_NAMES, checked by Gate A3 and B5.
        CaptureSeam.installIfNeeded()
        #endif

        container = Self.openContainer()
        let container = self.container
        Task.detached(priority: .utility) {
            // Ordered before recovery so a legacy record is whole — segment
            // rows materialized — by the time anything reads one.
            PersistenceWriter.materializeLegacyRecords(container: container)
            PersistenceWriter.recoverIncompleteSessions(container: container)
            // Session starts only AFTER recovery: it closes every
            // `recording`-state record, so a session that raced it would have
            // its just-created record eaten as a "crashed" one. Dropping this
            // `markDone()` does not fail loudly — `SessionController.startSession`
            // awaits the gate, so it would hang EVERY session start forever.
            // The orphan sweep waits on the same latch, for a different reason
            // (see SessionRecovery).
            await RecoveryGate.shared.markDone()
        }
    }

    /// Open the session library at SchemaV2 with INFERRED (lightweight)
    /// migration — deliberately without a `migrationPlan:`.
    ///
    /// A staged plan cannot open the store this app actually shipped. The
    /// base-era app used `.modelContainer(for: SessionRecord.self)` (a3437ce),
    /// an UNVERSIONED schema, so no device carries a version identifier that
    /// SwiftData's `DefaultMigrationManager` can name among the plan's
    /// `schemas` — and it must name one before any stage runs, failing the open
    /// outright with NSCocoaErrorDomain 134504, "Cannot use staged migration
    /// with an unknown model version". Since the catch below is `fatalError`,
    /// that is a launch crash for every upgrading user, and invisible to a
    /// fresh install (a new store is created at V2, migrating nothing).
    /// `MigrationTests.testShippedUnversionedStoreUpgradesToV2` is the case
    /// that reproduces it; every older case there writes a VERSIONED fixture
    /// and so passes either way.
    ///
    /// Inference has no such requirement — it maps what is on disk onto V2
    /// without naming it — and every V1 → V2 change is within lightweight
    /// migration's reach: a new entity (`SegmentRecord`), a new relationship,
    /// `transcriptJSON` widened to optional, `transcriptIsReconciled` removed,
    /// and `state` added with the declaration default "complete" (which is what
    /// keeps a migrated record out of launch recovery's `recording` fetch).
    ///
    /// That leaves only the DATA work the custom stage used to do, which
    /// `PersistenceWriter.materializeLegacyRecords` now does at launch:
    /// idempotent, testable without a store fixture, and reaching records a
    /// stage would have missed. It calls the same `materializeLegacySegments`,
    /// so PR#37 blob timings are carried across exactly as before.
    private static func openContainer() -> ModelContainer {
        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        do {
            return try ModelContainer(
                for: schema,
                configurations: [ModelConfiguration(schema: schema)]
            )
        } catch {
            // Crash rather than move the store aside: a library that cannot be
            // read is still the user's, and a silent wipe is the one
            // unrecoverable outcome.
            fatalError("Could not open the session library: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(controller)
                .environmentObject(accountStore)
                .fullScreenCover(
                    isPresented: Binding(
                        get: { !hasOnboarded },
                        set: { hasOnboarded = !$0 }
                    )
                ) {
                    OnboardingView()
                        .environmentObject(accountStore)
                }
        }
        .modelContainer(container)
        // The controller owns the policy (idle-timer handling, intent drain);
        // the App just reports the phase.
        .onChange(of: scenePhase) { _, phase in
            controller.scenePhaseChanged(phase)
        }
    }
}

/// The navigation shell around the live session screen. Owns the root
/// NavigationStack and the post-stop landing: when the controller finishes a
/// session that saved a record, push its SessionDetailView.
private struct RootView: View {
    @EnvironmentObject private var controller: SessionController
    @Environment(\.modelContext) private var modelContext
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            SessionView()
                .navigationDestination(for: SessionRecord.self) { record in
                    SessionDetailView(record: record)
                }
        }
        .onChange(of: controller.lastSavedRecordID) { _, id in
            guard let id else { return }
            let descriptor = FetchDescriptor<SessionRecord>(
                predicate: #Predicate { $0.id == id }
            )
            if let record = try? modelContext.fetch(descriptor).first {
                path.append(record)
            }
        }
        // A session can start while a record's detail is showing (a Shortcut
        // or Siri start) — surface the live screen rather than listening
        // invisibly behind the stack.
        .onChange(of: controller.isRunning) { _, running in
            if running { path = NavigationPath() }
        }
    }
}
