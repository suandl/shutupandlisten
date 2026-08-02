// Settings, consumer edition: account, listening (the coverage checklist as a
// preset picker), a short privacy panel, and About. Everything operator-facing
// — BYOK key, proxy URL, tuning knobs, the acknowledgments toggle — lives in a
// Developer section that stays hidden until the version row is tapped five
// times. Nothing was deleted; it is all still here, just gated.
//
// Storage contract (do not break): the checklist is stored in
// @AppStorage("coverageCriteria") as newline-separated topics — the exact
// string SessionController reads. Presets only FILL that field; the
// controller's plumbing is untouched. "sessionMode" / "justListen" are the
// Wave-1b keys the session screen owns; this sheet only OFFERS a mode when a
// preset suggests one, never sets it silently.

#if APPLE_SIGN_IN
import AuthenticationServices
#endif
import SwiftUI
import TurnEngine

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var accountStore: AccountStore

    @State private var apiKey: String = KeychainStore.apiKey ?? ""
    @AppStorage("speakAcknowledgments") private var speakAcknowledgments = false
    @AppStorage("coverageCriteria") private var coverageCriteriaText = ""
    @AppStorage("coveragePresetId") private var coveragePresetId = ""
    @AppStorage("sessionMode") private var sessionModeRaw = SessionMode.open.rawValue
    @AppStorage("proxyBaseURL") private var proxyBaseURL = "https://api.shutupandlisten.sh"
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @AppStorage("developerUnlocked") private var developerUnlocked = false
    @AppStorage("showCostReadout") private var showCostReadout = false

    #if APPLE_SIGN_IN
    @State private var signingIn = false
    @State private var signInError: String?
    #endif
    @State private var showKnobs = false
    @State private var versionTaps = 0
    /// A preset whose suggested mode differs from the current one — the
    /// pairing is OFFERED via an alert, never applied silently.
    @State private var suggestedModeOffer: CoveragePreset?

    private static let customPresetID = "custom"

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                listeningSection
                privacySection
                aboutSection
                if developerUnlocked {
                    developerSection
                }
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
            .sheet(isPresented: $showKnobs) { KnobsView() }
            .alert(
                "Switch the listener?",
                isPresented: Binding(
                    get: { suggestedModeOffer != nil },
                    set: { if !$0 { suggestedModeOffer = nil } }
                ),
                presenting: suggestedModeOffer
            ) { preset in
                Button("Use \(preset.suggestedMode.displayName)") {
                    sessionModeRaw = preset.suggestedMode.rawValue
                }
                Button("Keep current", role: .cancel) {}
            } message: { preset in
                Text(
                    "\(preset.name) pairs naturally with the "
                    + "\(preset.suggestedMode.displayName.lowercased()) listener. "
                    + "Switch it for your next session?"
                )
            }
            .onAppear(perform: reconcilePresetSelection)
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
                #if APPLE_SIGN_IN
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
                #else
                Text(
                    "Sign in with Apple isn't available in this build. Unlock "
                    + "Developer mode (tap the version row five times) to connect "
                    + "a personal API key."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                #endif
            }
        } header: {
            Text("Account")
        } footer: {
            Text(
                accountStore.isSignedIn
                    ? "The listener's rare question travels through the "
                    + "shutupandlisten server. Your audio and recordings stay "
                    + "on this phone."
                    : "Sign in so the listener's rare question can reach the "
                    + "model — nothing else to set up."
            )
        }
    }

    // ── listening: the coverage checklist as presets ──

    /// The topics currently active, parsed exactly the way the controller
    /// parses them — this view only ever writes the same string it reads.
    private var activeTopics: [String] {
        coverageCriteriaText
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// Picker binding that applies the preset on USER selection only —
    /// `reconcilePresetSelection` writes the raw key directly, so reopening
    /// the sheet never re-fires the apply path (or the mode offer).
    private var presetSelection: Binding<String> {
        Binding(
            get: { coveragePresetId },
            set: { newValue in
                coveragePresetId = newValue
                applyPreset(id: newValue)
            }
        )
    }

    private var listeningSection: some View {
        Section {
            Picker("Checklist", selection: presetSelection) {
                Text("None").tag("")
                ForEach(CoveragePresets.all) { preset in
                    Text(preset.name).tag(preset.id)
                }
                Text("Custom").tag(Self.customPresetID)
            }
            if let preset = CoveragePresets.preset(id: coveragePresetId) {
                Text(preset.blurb)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if coveragePresetId == Self.customPresetID {
                TextEditor(text: $coverageCriteriaText)
                    .frame(minHeight: 100)
            } else if !activeTopics.isEmpty {
                Text(activeTopics.map { "•  \($0)" }.joined(separator: "\n"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Listening")
        } footer: {
            Text(
                coveragePresetId == Self.customPresetID
                    ? "One topic per line. The listener quietly makes sure the "
                    + "session gets to each of them.\n\nPrefer no questions at "
                    + "all? “Just listen” lives on the session screen."
                    : "Optional. Pick what a session should cover and the "
                    + "listener quietly makes sure you get to it.\n\nPrefer no "
                    + "questions at all? “Just listen” lives on the session "
                    + "screen."
            )
        }
    }

    /// A USER picked something in the checklist picker.
    private func applyPreset(id: String) {
        switch id {
        case "":
            coverageCriteriaText = ""
        case Self.customPresetID:
            break // keep whatever text is there; the editor takes over
        default:
            guard let preset = CoveragePresets.preset(id: id) else { return }
            coverageCriteriaText = preset.criteriaText
            if preset.suggestedMode != .open,
               sessionModeRaw != preset.suggestedMode.rawValue {
                suggestedModeOffer = preset
            }
        }
    }

    /// The stored text is the source of truth (the controller reads it, and
    /// older builds wrote it without a preset id) — on appear, point the
    /// picker at whatever the text actually is.
    private func reconcilePresetSelection() {
        let text = coverageCriteriaText
        if text.isEmpty {
            coveragePresetId = ""
        } else if let match = CoveragePresets.all.first(where: { $0.criteriaText == text }) {
            coveragePresetId = match.id
        } else {
            coveragePresetId = Self.customPresetID
        }
    }

    // ── privacy ──

    private var privacySection: some View {
        Section {
            privacyRow(
                "mic",
                "Recordings stay on this phone. Audio is never uploaded to "
                + "the shutupandlisten server."
            )
            privacyRow(
                "waveform",
                "Words are written down on-device when your device supports "
                + "it; otherwise Apple's speech service handles dictation."
            )
            privacyRow(
                "arrow.up.circle",
                "Transcript text is sent only when the listener speaks up or "
                + "you ask for a coverage check — never as a running stream."
            )
            privacyRow(
                "externaldrive",
                "The server keeps no audio and no transcripts — only your "
                + "sign-in and a daily usage count."
            )
        } header: {
            Text("Privacy")
        }
    }

    private func privacyRow(_ symbol: String, _ text: String) -> some View {
        Label {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(.tint)
        }
    }

    // ── about (the version row is the developer latch) ──

    private var versionString: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String
        return build.map { "\(version) (\($0))" } ?? version
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("Version") {
                Text(versionString)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: versionTapped)
        } header: {
            Text("About")
        } footer: {
            Text(
                developerUnlocked
                    ? "Developer settings are on."
                    : "Think out loud. It won't interrupt you."
            )
        }
    }

    private func versionTapped() {
        guard !developerUnlocked else { return }
        versionTaps += 1
        if versionTaps >= 5 {
            versionTaps = 0
            developerUnlocked = true
        }
    }

    // ── developer (hidden until the version row is tapped five times) ──

    private var developerSection: some View {
        Section {
            SecureField("sk-ant-…", text: $apiKey)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("https://api.shutupandlisten.sh", text: $proxyBaseURL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Toggle("Speak brief acknowledgments", isOn: $speakAcknowledgments)
            Toggle("Show model cost readout", isOn: $showCostReadout)
            Button("Tuning (developer)") { showKnobs = true }
            Button("Replay onboarding") {
                KeychainStore.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                hasOnboarded = false
                dismiss()
            }
            Button("Hide developer settings") {
                developerUnlocked = false
            }
        } header: {
            Text("Developer")
        } footer: {
            Text(
                "Operator surface. The key is a personal Claude API key, "
                + "Keychain-only, bypassing the account backend — calls go "
                + "straight to Anthropic; signing in takes precedence when "
                + "both are set. The URL is the proxy the account path talks "
                + "to. Acknowledgments are the rules-only “mm” / “right” on "
                + "short finished asides — no model call either way. Tuning "
                + "holds the patience sliders and the patience-only baseline "
                + "arm."
            )
        }
    }

    #if APPLE_SIGN_IN
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
    #endif
}
