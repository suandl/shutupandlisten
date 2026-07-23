import SwiftData
import SwiftUI

@main
struct ShutUpAndListenApp: App {
    @StateObject private var controller = SessionController()
    @StateObject private var accountStore = AccountStore()
    @AppStorage("hasOnboarded") private var hasOnboarded = false

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
    }
}
