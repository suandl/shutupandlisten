// The Shortcuts surface — one hook, zero steps.
//
// StartListeningIntent is THE hook: no parameters, opens the app straight
// into a running session (permissions already granted → talking; not yet
// granted → the ready screen, which asks). Stop and pull-a-thread run
// WITHOUT opening the app: a running session keeps this process alive
// (background audio), so they act in place — usable from Siri and
// automations without yanking the app forward. When the app is not
// running they cold-launch it in the background, find no session, and say
// so — never a crash, never a phantom start.
//
// StartListeningWithModeIntent is the power-user variant for custom
// Shortcuts; the primary hook stays parameter-free (last-used voice).
//
// iOS 17 App Intents only. Control Center / Lock Screen controls (iOS 18
// ControlWidget) need a widget extension target — follow-up, not here.

import AppIntents
import TurnEngine

struct StartListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Listening"
    static let description = IntentDescription(
        "Opens the app and starts a listening session immediately, "
            + "in whatever mode you last used."
    )
    /// The mic and the live screen ARE the product — this is a launcher.
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        // Queued, not called: the controller may not be configured yet on a
        // cold launch. Firing mid-session is an idempotent no-op.
        IntentBridge.shared.requestStart()
        return .result()
    }
}

struct StopListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "Stop Listening"
    static let description = IntentDescription(
        "Ends the current session and saves it to the library. "
            + "Does nothing if no session is running."
    )
    // No openAppWhenRun: `stopSession` needs no UI, and an automation
    // ("when I leave the car, stop listening") should not foreground us.

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        if IntentBridge.shared.stopIfRunning() {
            return .result(dialog: "Saved to your library.")
        }
        return .result(dialog: "Nothing was listening.")
    }
}

struct PullThreadIntent: AppIntent {
    static let title: LocalizedStringResource = "Pull a Thread"
    static let description = IntentDescription(
        "Invites the listener's one question about what you've said so far. "
            + "Only works while a session is running."
    )
    // No openAppWhenRun: the reply is spoken; eyes stay off the screen.

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        if IntentBridge.shared.pullThread() {
            // The question itself arrives as speech from the session — the
            // dialog only acknowledges the invitation.
            return .result(dialog: "Asking.")
        }
        return .result(dialog: "Nothing is listening right now — start a session first.")
    }
}

// ── mode variant (custom Shortcuts only; not in the App Shortcuts list) ──

/// The session voice as one flat choice — `SessionMode` plus just-listen,
/// so a Shortcut picks the whole register in a single parameter.
enum ListeningModeOption: String, AppEnum {
    case open
    case rehearsal
    case debrief
    case justListen

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Mode")
    static let caseDisplayRepresentations: [ListeningModeOption: DisplayRepresentation] = [
        .open: "Open",
        .rehearsal: "Rehearsal",
        .debrief: "Debrief",
        .justListen: "Just Listen",
    ]
}

struct StartListeningWithModeIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Listening in Mode"
    static let description = IntentDescription(
        "Starts a listening session in a specific mode. The mode becomes "
            + "the default until changed — the same as picking it in the app."
    )
    static let openAppWhenRun = true

    @Parameter(title: "Mode")
    var mode: ListeningModeOption

    static var parameterSummary: some ParameterSummary {
        Summary("Start listening in \(\.$mode) mode")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        switch mode {
        case .open:
            IntentBridge.shared.requestStart(mode: .open, justListen: false)
        case .rehearsal:
            IntentBridge.shared.requestStart(mode: .rehearsal, justListen: false)
        case .debrief:
            IntentBridge.shared.requestStart(mode: .debrief, justListen: false)
        case .justListen:
            // Questions off; the underlying mode stays whatever it was.
            IntentBridge.shared.requestStart(mode: nil, justListen: true)
        }
        return .result()
    }
}
