// Shortcuts → controller bridge. App Intents are instantiated by the
// system and cannot reach the SwiftUI-owned SessionController, so the
// controller registers itself here on init. Stop and pull-a-thread act on
// the live controller directly — a running session means this process is
// alive (background audio) and the intent runs inside it. Start is
// QUEUED: a cold Siri launch can run `perform()` before the root view has
// handed the controller its ModelContext, and starting before
// `configure()` would run a session the library could never save. The
// controller drains the queue once configured, and again on scene-active
// for the paths where `perform()` raced registration.

import Foundation
import TurnEngine

@MainActor
final class IntentBridge {
    static let shared = IntentBridge()
    private init() {}

    enum PendingAction {
        /// nil fields = keep the persisted (last-used) value.
        case startListening(mode: SessionMode?, justListen: Bool?)
    }

    private var pendingAction: PendingAction?
    private weak var controller: SessionController?

    func register(_ controller: SessionController) {
        self.controller = controller
    }

    /// Queue a start and nudge the controller — if it is already configured
    /// the session starts now; otherwise the queue survives until it is.
    func requestStart(mode: SessionMode? = nil, justListen: Bool? = nil) {
        pendingAction = .startListening(mode: mode, justListen: justListen)
        controller?.consumePendingIntentAction()
    }

    /// Hand over (and clear) the queued action. Called by the controller
    /// only once it holds a ModelContext.
    func takePendingAction() -> PendingAction? {
        defer { pendingAction = nil }
        return pendingAction
    }

    /// True if a running session was stopped (and therefore saved).
    func stopIfRunning() -> Bool {
        guard let controller, controller.isRunning else { return false }
        controller.stopSession()
        return true
    }

    /// True if a running session accepted the invited question. Mirrors the
    /// UI's guard: one model call in flight at a time.
    func pullThread() -> Bool {
        guard let controller, controller.isRunning, !controller.isThinking else { return false }
        controller.askNow()
        return true
    }
}
