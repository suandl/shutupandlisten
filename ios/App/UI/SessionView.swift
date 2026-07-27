// The live session screen — the waiting IS the interface.
//
// The root of the app (talk-first): a large breathing ring (PatienceRing) is
// the whole stage. At most three ambient states are ever named — listening /
// waiting / speaking — in one small lowercase word. The transcript collapses
// to a one-line peek (tap for the full text in a sheet); the listener's one
// earned question arrives as a staged moment (QuestionCard) with a gentle
// haptic. The library and settings live behind toolbar icons.

#if APPLE_SIGN_IN
import AuthenticationServices
#endif
import SwiftData
import SwiftUI
import TurnEngine

struct SessionView: View {
    @EnvironmentObject private var controller: SessionController
    @EnvironmentObject private var accountStore: AccountStore
    @Environment(\.modelContext) private var modelContext

    // Presented surfaces.
    @State private var showSettings = false
    @State private var showLibrary = false
    @State private var showTranscript = false
    #if APPLE_SIGN_IN
    @State private var showSignIn = false
    @State private var signInReason: SessionErrorKind = .accountRequired
    #endif

    // The ring's displayed fill — animated here so it never snaps: linear
    // 0.1 s while the controller ticks the window, a slow ease back to zero
    // when speech resumes.
    @State private var ringFill: Double = 0

    // The question moment.
    @State private var activeQuestion: TranscriptEntry?
    @State private var questionMinimized = false
    @State private var questionHaptic = 0

    // First-session coaching: shown once, the first time the machine
    // visibly waits.
    @AppStorage("seenPatienceTip") private var seenPatienceTip = false
    @State private var showPatienceTip = false

    // Session voice — persisted; the controller freezes both at session
    // start, so the control only shows (and only matters) between sessions.
    @AppStorage("sessionMode") private var sessionModeRaw = SessionMode.open.rawValue
    @AppStorage("justListen") private var justListen = false

    private var selectedMode: SessionMode {
        SessionMode(rawValue: sessionModeRaw) ?? .open
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                stage
                Spacer(minLength: 0)
                if !controller.isRunning {
                    modeControl
                }
                transcriptPeek
                controls
            }

            if let question = activeQuestion, !questionMinimized {
                QuestionCard(text: question.text) {
                    withAnimation(.easeInOut(duration: 0.5)) { activeQuestion = nil }
                }
                .transition(.opacity)
                .zIndex(1)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showLibrary = true } label: {
                    Image(systemName: "books.vertical")
                }
                .accessibilityLabel("Library")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
            }
        }
        .overlay(alignment: .top) {
            if let question = activeQuestion, questionMinimized {
                QuestionChip(text: question.text) {
                    withAnimation(.easeInOut(duration: 0.5)) { questionMinimized = false }
                }
                .padding(.top, 8)
                .padding(.horizontal, 24)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .sensoryFeedback(.impact(weight: .light, intensity: 0.7), trigger: questionHaptic)
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showLibrary) { LibraryView() }
        .sheet(isPresented: $showTranscript) { TranscriptSheet() }
        #if APPLE_SIGN_IN
        .sheet(isPresented: $showSignIn, onDismiss: { controller.lastError = nil }) {
            SignInSheet(reason: signInReason)
        }
        #endif
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: {
                    guard controller.lastError != nil else { return false }
                    #if APPLE_SIGN_IN
                    // Account/expired kinds get the sign-in sheet, not this alert.
                    return controller.lastErrorKind == .general
                    #else
                    // No sheet in this build — every error surfaces here, using
                    // the controller's human-readable message.
                    return true
                    #endif
                },
                set: { if !$0 { controller.lastError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(controller.lastError ?? "")
        }
        .onAppear {
            controller.configure(modelContext: modelContext, accountStore: accountStore)
        }
        .onChange(of: controller.patienceProgress) { _, progress in
            if let progress {
                // The controller's 0.1 s tick — consume it linearly.
                withAnimation(.linear(duration: 0.12)) { ringFill = progress }
            } else {
                // Speech resumed (or the window resolved): dissolve, never snap.
                withAnimation(.easeOut(duration: 1.6)) { ringFill = 0 }
            }
        }
        .onChange(of: controller.machineState) { _, state in
            if state == .pending && !seenPatienceTip {
                seenPatienceTip = true
                withAnimation(.easeIn(duration: 1.2)) { showPatienceTip = true }
            }
            // The thinker resumed over an open question — it steps aside.
            if state == .speaking, activeQuestion != nil, !questionMinimized {
                withAnimation(.easeInOut(duration: 0.6)) { questionMinimized = true }
            }
        }
        .onChange(of: controller.transcript) { _, entries in
            guard let latest = entries.last(where: {
                $0.speaker == .listener
                    && ($0.tier == .question || $0.tier == .reflection)
                    && !$0.text.isEmpty
            }) else { return }
            if latest.id != activeQuestion?.id {
                questionHaptic += 1
                withAnimation(.easeOut(duration: 0.9)) {
                    activeQuestion = latest
                    questionMinimized = false
                }
            }
        }
        .onChange(of: controller.isRunning) { _, running in
            if running {
                activeQuestion = nil
                questionMinimized = false
                ringFill = 0
            } else {
                withAnimation(.easeOut(duration: 1)) { showPatienceTip = false }
            }
        }
        #if APPLE_SIGN_IN
        .onChange(of: controller.lastErrorKind) { _, kind in
            guard let kind, kind != .general else { return }
            signInReason = kind
            showSignIn = true
        }
        #endif
    }

    // ── the stage: ring + one word ──

    private var stage: some View {
        VStack(spacing: 32) {
            PatienceRing(
                phase: ringPhase,
                fill: ringFill,
                levelDb: controller.inputLevelDb
            )
            .frame(width: 220, height: 220)

            VStack(spacing: 14) {
                Text(stateWord)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .animation(.easeInOut(duration: 0.8), value: stateWord)
                if showPatienceTip {
                    patienceTip
                }
            }
            // Reserve room so the tip's arrival doesn't shove the ring.
            .frame(minHeight: 64, alignment: .top)
        }
        .padding(.horizontal, 24)
    }

    private var ringPhase: PatienceRing.Phase {
        guard controller.isRunning, !controller.isInterrupted else { return .idle }
        switch controller.machineState {
        case .listening: return .listening
        case .speaking: return .thinkerSpeaking
        case .pending: return .waiting
        case .deciding: return .deciding
        case .responding: return .replying
        }
    }

    /// The whole live vocabulary: three lowercase words (plus honest edges
    /// for "not started" and "the system took the mic").
    private var stateWord: String {
        if controller.isInterrupted { return "on hold" }
        guard controller.isRunning else { return "ready" }
        switch controller.machineState {
        case .listening, .speaking: return "listening"
        case .pending, .deciding: return "waiting"
        case .responding: return "speaking"
        }
    }

    // ── first-session coaching ──

    private var patienceTip: some View {
        Text("it's waiting on purpose — keep thinking; it won't jump in")
            .font(.caption)
            .foregroundStyle(Color.sulAccent)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .transition(.opacity)
            .onTapGesture {
                withAnimation(.easeOut(duration: 0.6)) { showPatienceTip = false }
            }
            .task {
                try? await Task.sleep(nanoseconds: 9_000_000_000)
                withAnimation(.easeOut(duration: 2)) { showPatienceTip = false }
            }
            .accessibilityHint("Double tap to dismiss.")
    }

    // ── mode control (between sessions only) ──

    private var modeControl: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                ForEach(SessionMode.allCases, id: \.rawValue) { mode in
                    modeChip(mode)
                }
                justListenChip
            }
            Text(modeBlurb)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(minHeight: 30, alignment: .top)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 6)
        .transition(.opacity)
    }

    private func modeChip(_ mode: SessionMode) -> some View {
        let selected = mode == selectedMode
        return Button {
            sessionModeRaw = mode.rawValue
        } label: {
            Text(mode.displayName.lowercased())
                .font(.footnote)
                .foregroundStyle(selected ? Color.sulAccent : Color.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(selected ? Color.sulAccent.opacity(0.14) : Color.primary.opacity(0.04))
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(mode.displayName) mode")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var justListenChip: some View {
        Button {
            justListen.toggle()
        } label: {
            Text("just listen")
                .font(.footnote)
                .foregroundStyle(justListen ? Color.sulAccent : Color.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(justListen ? Color.sulAccent.opacity(0.14) : Color.primary.opacity(0.04))
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Just listen")
        .accessibilityValue(justListen ? "On" : "Off")
        .accessibilityHint("Questions off — it stays quiet unless you pull a thread.")
    }

    private var modeBlurb: String {
        justListen
            ? "questions off — it stays quiet; pull a thread still asks"
            : selectedMode.blurb.lowercased()
    }

    // ── transcript peek ──

    @ViewBuilder private var transcriptPeek: some View {
        if let line = lastThinkerLine {
            Button { showTranscript = true } label: {
                Text(line)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 32)
            .padding(.vertical, 10)
            .accessibilityLabel("Transcript: \(line)")
            .accessibilityHint("Double tap to read the full transcript.")
        }
    }

    private var lastThinkerLine: String? {
        controller.transcript.last {
            $0.speaker == .thinker
                && !$0.text.trimmingCharacters(in: .whitespaces).isEmpty
        }?.text
    }

    // ── controls ──

    private var controls: some View {
        VStack(spacing: 18) {
            if controller.isRunning {
                Button(action: controller.askNow) {
                    Text("pull a thread")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .disabled(controller.isThinking)
                .accessibilityLabel("Pull a thread now")
                .accessibilityHint("Asks the listener for its one question right away.")
            }

            Button(action: controller.toggleSession) {
                ZStack {
                    if controller.isRunning {
                        Circle().fill(Color.primary.opacity(0.08))
                        Image(systemName: "stop.fill")
                            .font(.title2)
                            .foregroundStyle(.primary)
                    } else {
                        Circle().fill(Color.sulAccent)
                        Image(systemName: "mic.fill")
                            .font(.title2)
                            .foregroundStyle(Color.black.opacity(0.8))
                    }
                }
                .frame(width: 76, height: 76)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(controller.isRunning ? "End session" : "Start talking")
        }
        .padding(.top, 6)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity)
    }
}

// ── full transcript (peek expanded) ──

private struct TranscriptSheet: View {
    @EnvironmentObject private var controller: SessionController
    @Environment(\.dismiss) private var dismiss
    @State private var showCoverage = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(visibleEntries) { entry in
                            entryText(entry)
                                .id(entry.id)
                        }
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onAppear {
                    if let last = visibleEntries.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
                .onChange(of: controller.transcript) { _, _ in
                    if let last = visibleEntries.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
            .navigationTitle("transcript")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if controller.isRunning && !controller.coverageCriteria.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            controller.checkCoverage()
                        } label: {
                            if controller.coverageChecking {
                                ProgressView()
                            } else {
                                Text("did I cover everything?")
                                    .font(.footnote)
                            }
                        }
                        .accessibilityLabel("Check coverage")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: controller.coverageResult) { _, result in
                if result != nil { showCoverage = true }
            }
            .sheet(isPresented: $showCoverage) { CoverageView() }
        }
        .presentationDetents([.medium, .large])
    }

    private var visibleEntries: [TranscriptEntry] {
        controller.transcript.filter {
            !$0.text.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    @ViewBuilder private func entryText(_ entry: TranscriptEntry) -> some View {
        if entry.speaker == .thinker {
            Text(entry.text)
                .font(.body)
                .foregroundStyle(.primary)
        } else {
            // The listener's rare line: indented, serif, unlabeled.
            Text(entry.text)
                .font(.system(.body, design: .serif).italic())
                .foregroundStyle(Color.sulAccent)
                .padding(.leading, 18)
        }
    }
}

// ── the sign-in moment ──
//
// Presented when the controller reports `.accountRequired` (the listener's
// first escalation with no account) or `.signInExpired` — a purpose-built
// invitation instead of a raw error alert.
//
// Gated on APPLE_SIGN_IN — see AppleSignIn.swift and ios/README.md → Building.
// When the flag is off, `.accountRequired` / `.signInExpired` fall back to the
// generic error alert above (the controller always sets a readable message).

#if APPLE_SIGN_IN
private struct SignInSheet: View {
    let reason: SessionErrorKind
    @EnvironmentObject private var accountStore: AccountStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var signingIn = false
    @State private var signInError: String?

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Text(reason == .signInExpired ? "Your sign-in expired" : "One quiet connection")
                .font(.system(.title2, design: .serif))
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
            Spacer()
            SignInWithAppleButton(.signIn) { request in
                request.requestedScopes = []
            } onCompletion: { result in
                handleSignIn(result)
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 48)
            .disabled(signingIn)
            if signingIn {
                ProgressView()
            }
            if let signInError {
                Text(signInError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button("Not now") { dismiss() }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
        .padding(28)
        .presentationDetents([.medium])
    }

    private var message: String {
        switch reason {
        case .signInExpired:
            return "Sign in again so the listener's rare question can reach the model. "
                + "Everything else — listening, waiting, saving — keeps working regardless."
        default:
            return "The listener needs an account for its rare questions — everything "
                + "else works without one. Sign in with Apple; there's no key to manage, "
                + "and your audio never leaves the phone."
        }
    }

    private func handleSignIn(_ result: Result<ASAuthorization, Error>) {
        switch AppleSignIn.outcome(of: result) {
        case .cancelled:
            return
        case .failed(let text):
            signInError = text
        case .token(let identityToken):
            signingIn = true
            signInError = nil
            Task {
                do {
                    try await accountStore.completeSignIn(identityToken: identityToken)
                    dismiss()
                } catch {
                    signInError = error.localizedDescription
                }
                signingIn = false
            }
        }
    }
}
#endif
