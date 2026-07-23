// Settings: account (Sign in with Apple / sign out), the proxy server address
// (tucked under Advanced), listening behaviour, the coverage checklist, and
// developer mode (the original bring-your-own-key path).

import AuthenticationServices
import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @EnvironmentObject private var accountStore: AccountStore

    @State private var apiKey: String = KeychainStore.apiKey ?? ""
    @AppStorage("speakAcknowledgments") private var speakAcknowledgments = true
    @AppStorage("coverageCriteria") private var coverageCriteriaText = ""
    @AppStorage("proxyBaseURL") private var proxyBaseURL = "https://api.shutupandlisten.sh"

    @State private var signingIn = false
    @State private var signInError: String?
    @State private var showAdvanced = false
    @State private var showDeveloper = false

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                serverSection
                listeningSection
                coverageSection
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
                    + "server. Your audio and running transcript never leave the phone."
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

    // ── developer mode ──

    private var developerSection: some View {
        Section {
            DisclosureGroup("Developer mode", isExpanded: $showDeveloper) {
                SecureField("sk-ant-…", text: $apiKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        } footer: {
            Text(
                "A personal Claude API key, stored in the Keychain on this "
                + "device only. It bypasses the account backend — calls go "
                + "straight to Anthropic. Signing in takes precedence when "
                + "both are set."
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
