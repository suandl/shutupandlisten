// Live knobs — the same tuning surface as web/src/knobs.ts, adjustable
// mid-session; a change applies to the next pause. Defaults bias to
// "keep listening".

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
                } footer: {
                    Text(
                        "The patience window: minimum silence before a pause may "
                        + "end the turn. The load-bearing tunable — raise it to "
                        + "wait through longer thinking-pauses."
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
                        + "lengthen the wait, never cut you off. Toggle off for "
                        + "the patience-only baseline."
                    )
                }
            }
            .navigationTitle("Patience")
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
