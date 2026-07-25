// "Did you cover it?" — which checklist topics the recording has touched so
// far, with the line that proves it, and one quiet nudge toward the biggest
// gap. Plain language throughout; no internal vocabulary, no raw dumps.

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
                                Text(result.nudge)
                                    .font(.body.weight(.medium))
                            } header: {
                                Text("Still open")
                            }
                        }
                        Section {
                            ForEach(result.topics, id: \.topic) { topic in
                                VStack(alignment: .leading, spacing: 4) {
                                    Label {
                                        Text(topic.topic)
                                    } icon: {
                                        Image(systemName: topic.covered
                                            ? "checkmark.circle.fill"
                                            : "circle")
                                            .foregroundStyle(topic.covered
                                                ? AnyShapeStyle(.tint)
                                                : AnyShapeStyle(.quaternary))
                                    }
                                    .foregroundStyle(topic.covered ? .primary : .secondary)
                                    if topic.covered && !topic.evidence.isEmpty {
                                        Text("“\(topic.evidence)”")
                                            .font(.footnote.italic())
                                            .foregroundStyle(.secondary)
                                            .padding(.leading, 28)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        } header: {
                            Text("Your checklist")
                        }
                    }
                } else {
                    ContentUnavailableView(
                        "Nothing checked yet",
                        systemImage: "checklist",
                        description: Text(
                            "Run a check from the session screen to see "
                            + "which topics you've gotten to."
                        )
                    )
                }
            }
            .navigationTitle("Did you cover it?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
