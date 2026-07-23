import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var apiKey: String = KeychainStore.apiKey ?? ""
    @AppStorage("speakAcknowledgments") private var speakAcknowledgments = true
    @AppStorage("coverageCriteria") private var coverageCriteriaText = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("sk-ant-…", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Claude API key")
                } footer: {
                    Text(
                        "Stored in the Keychain, on this device only. The key is "
                        + "used for the listener's rare substantive replies and "
                        + "for coverage checks — silence and acknowledgments "
                        + "never call the model."
                    )
                }

                Section {
                    Toggle("Speak brief acknowledgments", isOn: $speakAcknowledgments)
                } footer: {
                    Text(
                        "A short finished aside gets a quiet “mm” / “right” with "
                        + "no model call. Turn off for pure silence between "
                        + "thread-pulls."
                    )
                }

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
}
