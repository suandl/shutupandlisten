// App entry point. Two Phase 4 responsibilities live here (docs/plans/
// 2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, R3):
//
// 1. The ModelContainer is built explicitly with the versioned-schema
//    migration plan (SchemaV1 → SchemaV2, custom stage) — the convenience
//    `.modelContainer(for:)` modifier cannot carry a migration plan.
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

    private let container: ModelContainer

    init() {
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
            // Release session starts only AFTER recovery: it closes every
            // `recording`-state record, so a session that raced it would have
            // its just-created record eaten as a "crashed" one.
            await RecoveryGate.shared.markDone()
        }
    }

    var body: some Scene {
        WindowGroup {
            LibraryView()
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
    }
}
