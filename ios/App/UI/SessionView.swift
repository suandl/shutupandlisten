// The live session UI: a live transcript, a state strip that shows the
// patience window filling, and three actions — listen/stop, "pull a thread
// now" (the upon-prompting path), and the coverage check.
//
// Pushed from LibraryView, which owns the NavigationStack.

import SwiftData
import SwiftUI
import TurnEngine

struct SessionView: View {
    @EnvironmentObject private var controller: SessionController
    @EnvironmentObject private var accountStore: AccountStore
    @Environment(\.modelContext) private var modelContext
    @State private var showSettings = false
    @State private var showKnobs = false
    @State private var showCoverage = false

    // First-session coaching: shown the first time the machine visibly waits.
    @AppStorage("seenPatienceTip") private var seenPatienceTip = false
    @State private var showPatienceTip = false

    // "Saved to library" confirmation after a stop that persisted a record.
    @State private var showSavedToast = false

    var body: some View {
        VStack(spacing: 0) {
            stateStrip
            if controller.isRunning,
               controller.captureState == .paused || controller.captureState == .resuming {
                captureStateBanner
            }
            if showPatienceTip {
                patienceTip
            }
            transcriptList
            controls
        }
        .navigationTitle("shutupandlisten")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showKnobs = true } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .accessibilityLabel("Patience knobs")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showKnobs) { KnobsView() }
        .sheet(isPresented: $showCoverage) { CoverageView() }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { controller.lastError != nil },
                set: { if !$0 { controller.lastError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(controller.lastError ?? "")
        }
        .overlay(alignment: .bottom) {
            if showSavedToast {
                savedToast
            }
        }
        .onAppear {
            controller.configure(modelContext: modelContext, accountStore: accountStore)
        }
        .onChange(of: controller.machineState) { _, state in
            if state == .pending && !seenPatienceTip {
                seenPatienceTip = true
                withAnimation { showPatienceTip = true }
            }
        }
        .onChange(of: controller.lastSavedRecordID) { _, id in
            guard id != nil else { return }
            withAnimation { showSavedToast = true }
            Task {
                try? await Task.sleep(nanoseconds: 2_200_000_000)
                withAnimation { showSavedToast = false }
            }
        }
    }

    // ── state strip ──

    private var stateStrip: some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                Circle()
                    .fill(stateColor)
                    .frame(width: 10, height: 10)
                Text(stateLabel)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                if controller.isThinking {
                    ProgressView().controlSize(.small)
                }
                if controller.isRunning {
                    LevelMeter(db: controller.inputLevelDb)
                }
            }
            // The patience window filling — silence being *counted*, visibly.
            ProgressView(value: controller.patienceProgress ?? 0)
                .tint(.orange)
                .opacity(controller.patienceProgress == nil ? 0 : 1)
                .animation(.linear(duration: 0.1), value: controller.patienceProgress)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var stateLabel: String {
        guard controller.isRunning else { return "Tap the mic to start a session" }
        switch controller.machineState {
        case .listening: return "Listening"
        case .speaking: return "You're talking — staying out of the way"
        case .pending: return "Pause — waiting it out"
        case .deciding: return "Thought may have landed — deciding"
        case .responding: return "Speaking"
        }
    }

    private var stateColor: Color {
        guard controller.isRunning else { return .gray }
        switch controller.machineState {
        case .listening: return .green
        case .speaking: return .blue
        case .pending: return .orange
        case .deciding: return .purple
        case .responding: return .pink
        }
    }

    // ── truthful capture state (R1.2: paused is shown, not papered over) ──

    private var captureStateBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: controller.captureState == .paused
                ? "pause.circle" : "arrow.clockwise.circle")
                .foregroundStyle(.orange)
            Text(controller.captureState == .paused
                ? "Listening is paused — another app has the microphone. "
                    + "It resumes on its own when the audio frees up."
                : "Resuming the microphone…")
                .font(.footnote)
            Spacer()
        }
        .padding(12)
        .background(Color.orange.opacity(0.1))
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // ── first-session coaching ──

    private var patienceTip: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "hourglass")
                .foregroundStyle(.orange)
            Text(
                "It's waiting on purpose — the bar is the patience window. "
                + "Keep thinking; it won't jump in."
            )
            .font(.footnote)
            Spacer()
            Button {
                withAnimation { showPatienceTip = false }
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Dismiss tip")
        }
        .padding(12)
        .background(Color.orange.opacity(0.1))
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // ── saved confirmation ──

    private var savedToast: some View {
        Label("Saved to library", systemImage: "checkmark.circle.fill")
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
            .padding(.bottom, 108)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // ── transcript ──

    private var transcriptList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if controller.transcript.isEmpty {
                        emptyState
                    }
                    ForEach(controller.transcript) { entry in
                        TranscriptBubble(entry: entry)
                            .id(entry.id)
                    }
                }
                .padding()
            }
            .onChange(of: controller.transcript) { _, entries in
                if let last = entries.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("A quiet thought companion.")
                .font(.title3.weight(.semibold))
            Text(
                """
                Start a session and think out loud. It stays silent while you \
                talk — a pause is not its cue. When an idea has fully landed, \
                it pulls on one thread to help you take it further. Or tap \
                “Pull a thread” whenever you want the question now.
                """
            )
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 40)
    }

    // ── controls ──

    private var controls: some View {
        HStack(spacing: 16) {
            Button(action: controller.checkCoverage) {
                if controller.coverageChecking {
                    ProgressView()
                } else {
                    Image(systemName: "checklist")
                        .font(.title3)
                }
            }
            .buttonStyle(.bordered)
            .disabled(!controller.isRunning || controller.coverageCriteria.isEmpty)
            .accessibilityLabel("Check coverage")
            // Keyed off the completed-check COUNT, not the result value: a
            // repeat check returning the identical result would never change
            // `coverageResult`, and the sheet has to reopen anyway.
            .onChange(of: controller.coverageCheckCount) { _, _ in
                if controller.coverageResult != nil { showCoverage = true }
            }

            Button(action: controller.toggleSession) {
                Image(systemName: controller.isRunning ? "stop.fill" : "mic.fill")
                    .font(.title)
                    .frame(width: 64, height: 64)
            }
            .buttonStyle(.borderedProminent)
            .clipShape(Circle())
            .tint(controller.isRunning ? .red : .accentColor)
            .accessibilityLabel(controller.isRunning ? "Stop session" : "Start session")

            Button(action: controller.askNow) {
                Image(systemName: "questionmark.bubble")
                    .font(.title3)
            }
            .buttonStyle(.bordered)
            .disabled(!controller.isRunning)
            .accessibilityLabel("Pull a thread now")
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(.bar)
    }
}

// ── pieces ──

private struct TranscriptBubble: View {
    let entry: TranscriptEntry

    var body: some View {
        if entry.text.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.speaker == .thinker ? "You" : label(for: entry.tier))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(entry.text)
                    .font(entry.speaker == .thinker ? .body : .body.italic())
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                entry.speaker == .thinker
                    ? AnyShapeStyle(Color(.secondarySystemBackground))
                    : AnyShapeStyle(Color.accentColor.opacity(0.12)),
                in: RoundedRectangle(cornerRadius: 14)
            )
        }
    }

    private func label(for tier: Tier?) -> String {
        switch tier {
        case .acknowledge: return "Listener"
        case .reflection: return "Listener · reflection"
        case .question: return "Listener · thread-pull"
        default: return "Listener"
        }
    }
}

private struct LevelMeter: View {
    let db: Float

    var body: some View {
        let normalized = max(0, min(1, (db + 60) / 50))
        Capsule()
            .fill(.green.opacity(0.7))
            .frame(width: 42 * CGFloat(normalized) + 2, height: 4)
            .frame(width: 44, alignment: .leading)
            .background(Capsule().fill(.quaternary).frame(width: 44, height: 4))
    }
}
