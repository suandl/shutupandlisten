// Zero-setup Shortcuts: everything listed here appears in Spotlight, the
// Shortcuts app, and Siri the moment the app is installed — no user
// assembly required. That single registration is the fan-out: Siri, the
// Action button, Lock Screen widgets, and Back Tap all reach these
// without any further wiring.
//
// Siri requires every phrase to embed `.applicationName` — the bare-token
// phrase IS the app's display name spoken alone. Today that name is
// "ShutUpAndListen"; setting INFOPLIST_KEY_CFBundleDisplayName to
// "Shut Up and Listen" would make the owner's exact phrase ("shut up and
// listen") the trigger. Follow-up alongside the ControlWidget extension.

import AppIntents

struct SulAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartListeningIntent(),
            phrases: [
                "Start listening with \(.applicationName)",
                "Start \(.applicationName)",
                "Start a session in \(.applicationName)",
                "\(.applicationName)",
            ],
            shortTitle: "Start Listening",
            systemImageName: "mic.fill"
        )
        AppShortcut(
            intent: StopListeningIntent(),
            phrases: [
                "Stop listening with \(.applicationName)",
                "Stop \(.applicationName)",
                "End my \(.applicationName) session",
            ],
            shortTitle: "Stop Listening",
            systemImageName: "stop.fill"
        )
        AppShortcut(
            intent: PullThreadIntent(),
            phrases: [
                "Pull a thread in \(.applicationName)",
                "Ask me a question in \(.applicationName)",
            ],
            shortTitle: "Pull a Thread",
            systemImageName: "questionmark.bubble"
        )
    }
}
