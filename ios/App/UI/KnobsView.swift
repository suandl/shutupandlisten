// Tuning (developer) — the operator's feel-test harness, the same surface as
// web/src/knobs.ts, adjustable mid-session; a change applies to the next
// pause. Defaults bias to "keep listening".
//
// This is deliberately NOT a consumer surface: it is reachable only from the
// hidden Developer section in Settings. Consumers get the shipped defaults
// (the su-lou feel-test verdict); these sliders exist so the operator can keep
// running that experiment.

import SwiftUI
import TurnEngine

struct KnobsView: View {
    @EnvironmentObject private var controller: SessionController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    knobRow(
                        label: "Silence floor",
                        value: $controller.knobs.silenceFloorMs,
                        range: 200...6000, step: 50, unit: "ms"
                    )
                } header: {
                    Text("Developer surface")
                } footer: {
                    Text(
                        "The patience window: minimum silence before a pause may "
                        + "end the turn. The load-bearing tunable — raise it to "
                        + "wait through longer thinking-pauses. Consumer builds "
                        + "ship the defaults; nothing here is required."
                    )
                }

                Section {
                    knobRow(
                        label: "Incomplete extension",
                        value: $controller.knobs.incompleteExtensionMs,
                        range: 0...8000, step: 100, unit: "ms"
                    )
                    knobRow(
                        label: "Completion threshold",
                        value: $controller.knobs.completionThreshold,
                        range: 0...1, step: 0.05, unit: "P"
                    )
                    Toggle("End-of-thought heuristic", isOn: $controller.knobs.useSmartTurn)
                } footer: {
                    Text(
                        "When the pause reads as mid-thought (trailing “and…”, "
                        + "a comma), extra patience is added — the veto can only "
                        + "lengthen the wait, never cut you off. Toggling off is "
                        + "the patience-only baseline arm of the experiment; no "
                        + "user benefits from it."
                    )
                }
            }
            .navigationTitle("Tuning (developer)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func knobRow(
        label: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double,
        unit: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                Spacer()
                Text(unit == "P"
                     ? String(format: "%.2f", value.wrappedValue)
                     : "\(Int(value.wrappedValue)) \(unit)")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Slider(value: value, in: range, step: step)
        }
    }
}
