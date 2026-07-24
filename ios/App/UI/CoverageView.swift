// Coverage results: which checklist topics the recording has covered so far,
// with the evidence, and one nudge toward the most important gap.

import SwiftUI
import TurnEngine

struct CoverageView: View {
    @EnvironmentObject private var controller: SessionController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let result = controller.coverageResult {
                    List {
                        if !result.nudge.isEmpty {
                            Section {
                                Label(result.nudge, systemImage: "arrow.turn.down.right")
                                    .font(.body.weight(.medium))
                            }
                        }
                        Section("Topics") {
                            ForEach(result.topics, id: \.topic) { topic in
                                VStack(alignment: .leading, spacing: 4) {
                                    Label(
                                        topic.topic,
                                        systemImage: topic.covered
                                            ? "checkmark.circle.fill"
                                            : "circle"
                                    )
                                    .foregroundStyle(topic.covered ? .primary : .secondary)
                                    if topic.covered && !topic.evidence.isEmpty {
                                        Text("“\(topic.evidence)”")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .padding(.leading, 28)
                                    }
                                }
                            }
                        }
                    }
                } else {
                    ContentUnavailableView(
                        "No coverage check yet",
                        systemImage: "checklist",
                        description: Text("Run a check from the session screen.")
                    )
                }
            }
            .navigationTitle("Coverage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
