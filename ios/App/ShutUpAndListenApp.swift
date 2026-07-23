import SwiftUI

@main
struct ShutUpAndListenApp: App {
    @StateObject private var controller = SessionController()

    var body: some Scene {
        WindowGroup {
            SessionView()
                .environmentObject(controller)
        }
    }
}
