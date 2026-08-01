// Settings: account (Sign in with Apple / sign out), the proxy server address
// (tucked under Advanced), listening behaviour, the coverage checklist, the
// opt-in transcript feed (plan R4.3 — off by default), and developer mode
// (the original bring-your-own-key path).

import AuthenticationServices
import SwiftUI
import TranscriptCore

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var accountStore: AccountStore
    @EnvironmentObject private var controller: SessionController

    @State private var apiKey: String = KeychainStore.apiKey ?? ""
    @AppStorage("speakAcknowledgments") private var speakAcknowledgments = true
    @AppStorage("coverageCriteria") private var coverageCriteriaText = ""
    @AppStorage("proxyBaseURL") private var proxyBaseURL = "https://api.shutupandlisten.sh"
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    // The transcript feed (same keys SessionController reads at session start).
    @AppStorage("transcriptFeedEnabled") private var transcriptFeedEnabled = false
    @AppStorage("transcriptFeedURL") private var transcriptFeedURL = ""
    @AppStorage("transcriptFeedCadenceSeconds") private var transcriptFeedCadenceSeconds = 5

    @State private var signingIn = false
    @State private var signInError: String?
    @State private var showAdvanced = false
    @State private var showDeveloper = false
    #if DEBUG
    @State private var showLiveFeed = false
    #endif

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                serverSection
                listeningSection
                coverageSection
                transcriptFeedSection
                developerSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        KeychainStore.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                    }
                }
            }
        }
    }

    // ── account ──

    private var accountSection: some View {
        Section {
            if accountStore.isSignedIn {
                LabeledContent("Signed in") {
                    Text(accountStore.userId ?? "")
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .foregroundStyle(.secondary)
                }
                Button("Sign out", role: .destructive) {
                    accountStore.signOut()
                }
            } else {
                SignInWithAppleButton(.signIn) { request in
                    request.requestedScopes = []
                } onCompletion: { result in
                    handleSignIn(result)
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 44)
                .disabled(signingIn)
                if signingIn {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
                if let signInError {
                    Text(signInError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        } header: {
            Text("Account")
        } footer: {
            Text(
                accountStore.isSignedIn
                    ? "The listener's rare questions go through the shutupandlisten "
                    + "server. Your audio and running transcript stay on this phone "
                    + "unless you turn on the transcript feed below."
                    : "Sign in so the listener's rare questions can reach the model — "
                    + "no API key to manage. The app works without it in developer mode."
            )
        }
    }

    // ── server ──

    private var serverSection: some View {
        Section {
            DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                TextField("https://api.shutupandlisten.sh", text: $proxyBaseURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        } header: {
            Text("Server")
        } footer: {
            Text("The base URL the account path talks to. Leave it alone unless "
                 + "you run your own proxy.")
        }
    }

    // ── listening ──

    private var listeningSection: some View {
        Section {
            Toggle("Speak brief acknowledgments", isOn: $speakAcknowledgments)
        } header: {
            Text("Listening")
        } footer: {
            Text(
                "A short finished aside gets a quiet “mm” / “right” with "
                + "no model call. Turn off for pure silence between "
                + "thread-pulls."
            )
        }
    }

    // ── coverage checklist ──

    private var coverageSection: some View {
        Section {
            TextEditor(text: $coverageCriteriaText)
                .frame(minHeight: 120)
                .font(.body.monospaced())
        } header: {
            Text("Coverage checklist")
        } footer: {
            Text(
                "Optional. One topic per line — e.g. the topics a pitch "
                + "or briefing must cover. The checklist button on the "
                + "session screen evaluates the recording so far against "
                + "these, and the thread-pull may steer toward an "
                + "untouched topic once an idea has landed."
            )
        }
    }

    // ── transcript feed (R4.3: the opt-in remote arm of the agent seam) ──

    private var transcriptFeedSection: some View {
        Section {
            Toggle("Share live transcript", isOn: $transcriptFeedEnabled)
            if transcriptFeedEnabled {
                TextField("https://example.com/transcript", text: $transcriptFeedURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Stepper(
                    "Send every \(transcriptFeedCadenceSeconds) s",
                    value: $transcriptFeedCadenceSeconds,
                    in: 2 ... 30
                )
            }
            #if DEBUG
            if controller.isRunning, let feed = controller.agentFeed {
                DisclosureGroup("Live feed", isExpanded: $showLiveFeed) {
                    LiveFeedDebugView(feed: feed)
                }
            }
            #endif
        } header: {
            Text("Transcript feed")
        } footer: {
            Text(
                "Off by default — nothing leaves the device when off. When on, "
                + "finalized transcript text (never the in-progress words) is "
                + "sent in small batches to the HTTPS address above, from the "
                + "next session on. Recognition itself always stays on-device."
            )
        }
    }

    // ── developer mode ──

    private var developerSection: some View {
        Section {
            DisclosureGroup("Developer mode", isExpanded: $showDeveloper) {
                SecureField("sk-ant-…", text: $apiKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Replay onboarding") {
                    KeychainStore.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                    hasOnboarded = false
                    dismiss()
                }
            }
        } footer: {
            Text(
                "A personal Claude API key, stored in the Keychain on this "
                + "device only. It bypasses the account backend — calls go "
                + "straight to Anthropic. Signing in takes precedence when "
                + "both are set.\n\nReplay onboarding shows the intro again on "
                + "the next return to the library. You stay signed in — only "
                + "the intro reappears."
            )
        }
    }

    private func handleSignIn(_ result: Result<ASAuthorization, Error>) {
        switch AppleSignIn.outcome(of: result) {
        case .cancelled:
            return
        case .failed(let message):
            signInError = message
        case .token(let identityToken):
            signingIn = true
            signInError = nil
            Task {
                do {
                    try await accountStore.completeSignIn(identityToken: identityToken)
                } catch {
                    signInError = error.localizedDescription
                }
                signingIn = false
            }
        }
    }
}

#if DEBUG
/// Phase 5's verification aid: a plain AgentFeed subscriber that lists the
/// last few transcript events with wall-clock stamps — the on-screen proof
/// that an in-process consumer sees deltas within ~1 s of speech. DEBUG-only;
/// it exists to prove the seam, not to ship.
private struct LiveFeedDebugView: View {
    let feed: AgentFeed

    private struct Row: Identifiable {
        let id: Int
        let stamp: Date
        let text: String
    }

    @State private var rows: [Row] = []
    @State private var nextID = 0

    var body: some View {
        Group {
            if rows.isEmpty {
                Text("Waiting for events…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(rows) { row in
                    HStack(alignment: .top, spacing: 8) {
                        Text(row.stamp, format: .dateTime.hour().minute().second())
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                        Text(row.text)
                            .font(.caption)
                            .lineLimit(2)
                    }
                }
            }
        }
        .task {
            // A fresh subscription per appearance: snapshot-then-deltas, like
            // any other late subscriber. The task dies with the view.
            for await event in await feed.subscribe() {
                nextID += 1
                rows.append(Row(id: nextID, stamp: Date(), text: describe(event)))
                if rows.count > 6 { rows.removeFirst(rows.count - 6) }
            }
        }
    }

    private func describe(_ event: TranscriptEvent) -> String {
        switch event {
        case .segmentAdded(let s): return "+ \(s.speaker.rawValue): \(s.text)"
        case .segmentRevised(let s): return "~ \(s.speaker.rawValue): \(s.text)"
        case .segmentFinalized(let s): return "✓ \(s.speaker.rawValue): \(s.text)"
        case .turnStarted(let turn, let t): return "turn \(turn) @ \(String(format: "%.1f", t)) s"
        }
    }
}
#endif
