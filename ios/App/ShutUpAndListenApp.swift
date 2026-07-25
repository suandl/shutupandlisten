import SwiftData
import SwiftUI

@main
struct ShutUpAndListenApp: App {
    @StateObject private var controller = SessionController()
    @StateObject private var accountStore = AccountStore()
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @Environment(\.scenePhase) private var scenePhase

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
        .modelContainer(for: SessionRecord.self)
        // The controller owns the policy (checkpoint on background, idle-timer
        // handling); the App just reports the phase.
        .onChange(of: scenePhase) { _, phase in
            controller.scenePhaseChanged(phase)
        }
    }
}
