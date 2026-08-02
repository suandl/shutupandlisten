// Talk-first root: the app opens INTO the session screen — mic ready, one
// tap to talk. The library and settings live behind toolbar icons on that
// screen. When a session ends and a record was saved, the root navigates to
// the saved record's detail — the artifact is the second act, not a toast.

import SwiftData
import SwiftUI

@main
struct ShutUpAndListenApp: App {
    @StateObject private var controller = SessionController()
    @StateObject private var accountStore = AccountStore()
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @Environment(\.scenePhase) private var scenePhase

    init() {
        #if DEBUG
        // Arm the CI capture seams before any view renders or request is made.
        // Inert unless launched with -uiTestCapture. The seam is compiled out
        // of Release (su-uzy9.1, f4), leaving init() empty in that build.
        CaptureSeam.installIfNeeded()
        #endif
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
        .modelContainer(for: SessionRecord.self)
        // The controller owns the policy (checkpoint on background, idle-timer
        // handling); the App just reports the phase.
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
