// Talk-first root: the app opens INTO the session screen — mic ready, one
// tap to talk. The library and settings live behind toolbar icons on that
// screen. When a session ends and a record was saved, the root navigates to
// the saved record's detail — the artifact is the second act, not a toast.
//
// Two further responsibilities live here after the transcript-core port
// (docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, R3):
//
// 1. The ModelContainer is built EXPLICITLY with the versioned-schema
//    migration plan (SchemaV1 → SchemaV2, custom stage). The convenience
//    `.modelContainer(for:)` modifier cannot carry a migration plan, and the
//    failure mode of keeping it here is silent: SwiftData would attempt a
//    lightweight migration into V2 on its own, the custom stage would never
//    run, `materializeLegacySegments` would never be called, no SegmentRecord
//    rows would exist, and every migrated record would limp along on the lazy
//    read-path fallback. Nothing errors. This is the single
//    highest-consequence line in the file.
// 2. Launch recovery: records a crash left in `recording` state are closed as
//    `recovered` (CAF remuxed and adopted; zero-speech deleted). It runs on a
//    background task at init — the library's query filters `recording`-state
//    rows, so nothing half-open is visible while recovery works; recovered
//    sessions appear when it saves.

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

        let schema = Schema(versionedSchema: SessionSchemaV2.self)
        do {
            container = try ModelContainer(
                for: schema,
                migrationPlan: SessionMigrationPlan.self,
                configurations: [ModelConfiguration(schema: schema)]
            )
        } catch {
            // Same behavior as the old `.modelContainer(for:)` modifier when
            // the store cannot open: there is no app without the library.
            fatalError("Could not open the session library: \(error)")
        }
        let container = self.container
        Task.detached(priority: .utility) {
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
