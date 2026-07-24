// The host — wires audio → TurnDetector → response gate → Claude → TTS.
//
// This is the iOS counterpart of web/src/main.ts: the impure shell around the
// pure engine. The division of labour (spec + CONCEPTS "reduced role"):
//
//   AudioPipeline        mic → speech-start/speech-end events
//   LinguisticEOU        transcript → P(complete) evidence (the smart-turn stand-in)
//   TurnDetector         pure reducer: when the patience window closes, it asks
//                        (`evaluate`) — it never decides to speak on its own
//   decideTier (gate)    rules answer silence/acknowledge with NO model call;
//                        only reflection/question reach Claude
//   ClaudeClient         the substantive tiers (prompts/claude.md system prompt)
//   SpeechOutput         speaks the reply; barge-in cuts it instantly
//
// Every `evaluate` is answered (spec §4a invariant): rules tiers answer
// synchronously; model tiers leave the machine parked in `deciding` (which
// carries no timer) until the reply lands, then answer `speak` — or `silence`
// if the model chose to stay quiet or the call failed. If the thinker resumed
// while we deliberated, the machine already abandoned the evaluation and our
// late `decision` is ignored as stale — exactly the spec's contract.

import AVFoundation
import ClaudeClient
import Foundation
import SwiftData
import SwiftUI
import TurnEngine

struct TranscriptEntry: Identifiable, Equatable {
    enum Speaker: Equatable { case thinker, listener }
    let id = UUID()
    let speaker: Speaker
    var text: String
    var tier: Tier?
    var turn: Int
}

@MainActor
final class SessionController: ObservableObject {
    // ── published state ──
    @Published private(set) var isRunning = false
    @Published private(set) var machineState: TurnState = .listening
    /// 0…1 progress of the patience window while a pause is being timed.
    @Published private(set) var patienceProgress: Double?
    @Published private(set) var transcript: [TranscriptEntry] = []
    @Published private(set) var inputLevelDb: Float = -70
    @Published private(set) var isThinking = false // a model call is in flight
    @Published var lastError: String?

    // Coverage mode
    @Published private(set) var coverageResult: CoverageResult?
    @Published private(set) var coverageChecking = false

    /// The id of the SessionRecord saved by the last `stopSession`, for the
    /// "Saved to library" confirmation. Nil when nothing was worth saving.
    @Published private(set) var lastSavedRecordID: UUID?

    // ── live-tunable knobs (mirrors web/src/knobs.ts; defaults bias to "keep listening") ──
    @Published var knobs = TurnKnobs.defaults {
        didSet { detector?.setKnobs { $0 = knobs } }
    }
    /// Speak the rules-only backchannel ("mm", "yeah") on short finished asides.
    @AppStorage("speakAcknowledgments") var speakAcknowledgments = true
    /// Criteria for coverage mode, one topic per line.
    @AppStorage("coverageCriteria") var coverageCriteriaText = ""

    var coverageCriteria: [CoverageCriterion] {
        coverageCriteriaText
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map(CoverageCriterion.init(topic:))
    }

    // ── internals ──
    private var detector: TurnDetector?
    private let pipeline = AudioPipeline()
    private let transcriber = SpeechTranscriber()
    private let speech = SpeechOutput()
    private var tickTimer: Timer?
    private var clockOrigin: TimeInterval = 0

    /// Latest EOU probability for the current pause (gate rule 2 evidence).
    private var lastEouProb: Double = .nan
    private var lastSpeechEndMs: Double = .nan
    /// When the companion last released the floor (response-end / barge-in).
    private var lastFloorReleaseMs: Double = .infinity
    /// Final decision per UTTERANCE (spec §4b) — the gate's history.
    private var decisionsByTurn: [Int: Tier] = [:]
    /// The reply text currently holding (or about to hold) the floor.
    private var pendingReply: (text: String, tier: Tier)?

    // ── app context (late-bound from the SwiftUI environment) ──
    private var modelContext: ModelContext?
    private var accountStore: AccountStore?
    /// Wall-clock start of the running session, for the saved record.
    private var sessionStartDate: Date?
    /// File name of the in-progress recording under RecordingStorage.
    private var recordingFileName: String?

    /// Hand in the SwiftData container and the account layer. Idempotent —
    /// the root view calls this on appear.
    func configure(modelContext: ModelContext, accountStore: AccountStore) {
        self.modelContext = modelContext
        self.accountStore = accountStore
    }

    private func nowMs() -> Double {
        (ProcessInfo.processInfo.systemUptime - clockOrigin) * 1000
    }

    // ── session lifecycle ──

    func toggleSession() {
        if isRunning { stopSession() } else { Task { await startSession() } }
    }

    func startSession() async {
        guard !isRunning else { return }
        lastError = nil

        guard await AVAudioApplication.requestRecordPermission() else {
            lastError = "Microphone access is required to listen."
            return
        }
        guard await SpeechTranscriber.requestAuthorization() else {
            lastError = "Speech recognition access is required to transcribe."
            return
        }

        clockOrigin = ProcessInfo.processInfo.systemUptime
        sessionStartDate = Date()
        lastSavedRecordID = nil
        lastEouProb = .nan
        lastSpeechEndMs = .nan
        lastFloorReleaseMs = .infinity
        decisionsByTurn = [:]
        pendingReply = nil
        transcript = []
        coverageResult = nil

        detector = TurnDetector(knobs: knobs)

        // AudioPipeline / SpeechTranscriber / SpeechOutput all deliver their
        // callbacks on the main queue, so hopping back onto the main actor via
        // assumeIsolated is safe and keeps event ordering strict.
        pipeline.onSpeechStart = { [weak self] t in
            MainActor.assumeIsolated { self?.feed(.speechStart(t: t)) }
        }
        pipeline.onSpeechEnd = { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.lastSpeechEndMs = t
                self.feed(.speechEnd(t: t))
                self.feedEouEvidence(at: t)
            }
        }
        pipeline.onBuffer = { [weak self] buffer in self?.transcriber.append(buffer) }
        pipeline.onLevel = { [weak self] db in
            MainActor.assumeIsolated { self?.inputLevelDb = db }
        }

        transcriber.onTranscriptUpdate = { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.refreshThinkerEntry()
                // New words are EVIDENCE: while a pause is being timed or an
                // evaluation is awaiting an answer, a fresher transcript can
                // flip the EOU reading — the machine re-evaluates
                // evidence-driven (§6), never on a clock.
                let s = self.detector?.state
                if s == .pending || s == .deciding {
                    self.feedEouEvidence(at: self.nowMs())
                }
            }
        }

        speech.onFinished = { [weak self] in
            // Let the machine's response window close on real audio end.
            MainActor.assumeIsolated {
                guard let self else { return }
                self.feed(.tick(t: self.nowMs()))
            }
        }

        do {
            try pipeline.start(clockOrigin: clockOrigin)
        } catch {
            lastError = "Could not start the microphone: \(error.localizedDescription)"
            return
        }
        transcriber.start()

        // Record the session audio (best-effort — the session runs regardless).
        let fileName = UUID().uuidString + ".m4a"
        do {
            try pipeline.startRecording(to: RecordingStorage.url(for: fileName))
            recordingFileName = fileName
        } catch {
            recordingFileName = nil
        }

        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.onTick() }
        }

        isRunning = true
        machineState = .listening
    }

    func stopSession() {
        guard isRunning else { return }
        tickTimer?.invalidate()
        tickTimer = nil
        speech.stop()
        pipeline.stopRecording()
        transcriber.stop()
        pipeline.stop()
        // Abandon the conversation: the next session opens a fresh turn. An
        // outstanding evaluation is answered cheaply with `silence`.
        detector?.input(.decision(t: nowMs(), outcome: .silence))
        detector?.dropTurn()
        detector = nil
        isRunning = false
        machineState = .listening
        patienceProgress = nil
        persistSession()
    }

    /// Save the finished session to the library — only when something was
    /// actually said; an empty session's orphan audio file is deleted.
    private func persistSession() {
        let started = sessionStartDate ?? Date()
        sessionStartDate = nil
        let fileName = recordingFileName
        recordingFileName = nil

        let stored = transcript
            .filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
            .map {
                StoredEntry(
                    speaker: $0.speaker == .thinker ? "thinker" : "listener",
                    text: $0.text,
                    tier: $0.tier?.rawValue,
                    turn: $0.turn
                )
            }
        guard !stored.isEmpty,
              let modelContext,
              let transcriptJSON = try? JSONEncoder().encode(stored)
        else {
            if let fileName { RecordingStorage.delete(fileName: fileName) }
            return
        }

        let record = SessionRecord(
            startedAt: started,
            duration: Date().timeIntervalSince(started),
            title: SessionRecord.deriveTitle(from: stored),
            transcriptJSON: transcriptJSON,
            criteriaText: coverageCriteriaText,
            coverageJSON: coverageResult.flatMap { try? JSONEncoder().encode($0) },
            audioFileName: fileName
        )
        modelContext.insert(record)
        try? modelContext.save()
        lastSavedRecordID = record.id
    }

    // ── the decision loop ──

    private func feed(_ event: InputEvent) {
        guard let detector else { return }
        let out = detector.input(event)
        machineState = detector.state
        for e in out { handle(e) }
        machineState = detector.state
    }

    private func onTick() {
        guard let detector else { return }
        let now = nowMs()
        feed(.tick(t: now))
        let snapshot = detector.peek(now: now)
        machineState = snapshot.state
        if let remaining = snapshot.msUntilTurnEnd {
            let window = knobs.silenceFloorMs
                + (snapshot.verdict == .incomplete && knobs.useSmartTurn ? knobs.incompleteExtensionMs : 0)
            patienceProgress = window > 0 ? max(0, min(1, 1 - remaining / window)) : nil
        } else {
            patienceProgress = nil
        }
    }

    private func feedEouEvidence(at t: Double) {
        guard knobs.useSmartTurn else { return }
        let prob = LinguisticEOU.completionProbability(for: transcriber.currentUtteranceText)
        lastEouProb = prob
        feed(.eou(t: t, verdict: nil, completionProb: prob))
    }

    private func handle(_ event: OutputEvent) {
        switch event {
        case .turnStart(_, let turn):
            transcriber.markUtteranceStart()
            transcript.append(TranscriptEntry(speaker: .thinker, text: "", tier: nil, turn: turn))

        case .evaluate(_, let turn, _, let reason, _):
            evaluate(turn: turn, reason: reason)

        case .turnEnd(_, let turn, _, _):
            _ = turn // transcript entry is already up to date via partials

        case .responseStart:
            if let reply = pendingReply, !reply.text.isEmpty {
                pendingReply = nil
                speech.speak(reply.text)
                transcript.append(TranscriptEntry(
                    speaker: .listener, text: reply.text, tier: reply.tier,
                    turn: detector?.currentTurn ?? 0
                ))
            }

        case .responseEnd(let t, _, _):
            lastFloorReleaseMs = t

        case .bargeIn(let t, _):
            // The yield is instant: cut the clip at t, not at its natural end.
            speech.stop()
            lastFloorReleaseMs = t
        }
    }

    /// Answer an `evaluate`. Rules tiers answer synchronously; model tiers
    /// leave the machine in `deciding` until the reply lands.
    private func evaluate(turn: Int, reason: PatienceReason) {
        let now = nowMs()
        let text = transcriber.currentUtteranceText
        // With the EOU heuristic off we fall back to the two-valued bridge the
        // web build used before the classifier's score was threaded through.
        let prob = knobs.useSmartTurn && lastEouProb.isFinite
            ? lastEouProb
            : completionProb(fromTurnEnd: reason)

        let ctx = EvalContext(
            utteranceIndex: turn,
            utteranceTextSoFar: text,
            completionProb: prob,
            msSinceSpeechEnd: lastSpeechEndMs.isFinite ? now - lastSpeechEndMs : .nan,
            msSinceWeLastSpoke: lastFloorReleaseMs.isFinite ? now - lastFloorReleaseMs : .infinity,
            priorDecisions: decisionsByTurn
                .filter { $0.key < turn }
                .sorted { $0.key < $1.key }
                .map { PriorDecision(turn: $0.key, tier: $0.value) }
        )
        let decision = decideTier(ctx, config: GateConfig.derived(from: knobs))
        decisionsByTurn[turn] = decision.tier

        switch decision.tier {
        case .silence:
            feed(.decision(t: now, outcome: .silence))

        case .acknowledge:
            guard speakAcknowledgments, let ack = decision.ackText else {
                decisionsByTurn[turn] = .silence
                feed(.decision(t: now, outcome: .silence))
                return
            }
            takeFloor(with: ack, tier: .acknowledge)

        case .reflection, .question:
            requestModelReply(tier: decision.tier, turn: turn, utterance: text)
        }
    }

    /// Call Claude for a substantive tier, then answer the (possibly stale)
    /// evaluation when the reply lands.
    private func requestModelReply(tier: Tier, turn: Int, utterance: String) {
        guard let client = makeService() else {
            decisionsByTurn[turn] = .silence
            feed(.decision(t: nowMs(), outcome: .silence))
            return
        }

        var request = buildListenerRequest(
            systemPrompt: ListenerPrompt.systemPrompt,
            tier: tier,
            currentTurnText: utterance,
            history: conversationHistory(before: turn)
        )
        // Coverage steering: when a checklist is set, let the thread-pull lean
        // toward a topic the recording has not covered yet.
        if !coverageCriteria.isEmpty, tier == .question {
            let topics = coverageCriteria.map(\.topic).joined(separator: "; ")
            request = ListenerRequest(
                system: request.system + "\n\nThe thinker also wants to make sure this "
                    + "recording eventually covers: \(topics). If the idea has landed and "
                    + "one of these is clearly untouched, your single question may steer "
                    + "toward it — but never before the current thought is fully out.",
                messages: request.messages,
                tier: request.tier,
                maxTokens: request.maxTokens
            )
        }

        isThinking = true
        Task { [weak self] in
            defer { Task { @MainActor [weak self] in self?.isThinking = false } }
            do {
                let reply = try await client.respond(to: request)
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    if reply.isEmpty {
                        // The model chose silence — the prompt says that is the
                        // correct response for most turns. Declining is free.
                        self.decisionsByTurn[turn] = .silence
                        self.feed(.decision(t: self.nowMs(), outcome: .silence))
                    } else {
                        self.takeFloor(with: reply, tier: tier)
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.lastError = self.friendlyMessage(for: error)
                    self.decisionsByTurn[turn] = .silence
                    self.feed(.decision(t: self.nowMs(), outcome: .silence))
                }
            }
        }
    }

    /// Answer `speak` with the response window sized to the real clip. If the
    /// thinker resumed while we deliberated the decision is stale and ignored
    /// by the machine — in that case the reply is discarded unspoken.
    private func takeFloor(with text: String, tier: Tier) {
        guard let detector, detector.state == .deciding else { return }
        pendingReply = (text, tier)
        detector.setKnobs { $0.responseDurationMs = SpeechOutput.estimateDurationMs(for: text) }
        feed(.decision(t: nowMs(), outcome: .speak))
        pendingReply = nil // consumed by response-start, or stale
    }

    /// "Pull a thread now" — the upon-prompting path. Bypasses the gate's
    /// earned-question spacing (the user explicitly invited the question) but
    /// still runs through the machine when it is parked in `deciding`, so the
    /// turn accounting stays truthful.
    func askNow() {
        guard isRunning else { return }
        let turn = detector?.currentTurn ?? 0
        let text = transcriber.currentUtteranceText.isEmpty
            ? transcriber.fullText
            : transcriber.currentUtteranceText
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            lastError = "Nothing has been said yet."
            return
        }
        decisionsByTurn[turn] = .question
        guard let client = makeService() else { return }
        let request = buildListenerRequest(
            systemPrompt: ListenerPrompt.systemPrompt,
            tier: .question,
            currentTurnText: text,
            history: conversationHistory(before: turn)
        )
        isThinking = true
        Task { [weak self] in
            defer { Task { @MainActor [weak self] in self?.isThinking = false } }
            do {
                let reply = try await client.respond(to: request)
                await MainActor.run { [weak self] in
                    guard let self, !reply.isEmpty else { return }
                    if self.detector?.state == .deciding {
                        self.takeFloor(with: reply, tier: .question)
                    } else {
                        // Out-of-band: the user asked while the machine was not
                        // parked on an evaluation. Speak directly; the turn
                        // continues (with AEC the mic will not hear our TTS).
                        self.speech.speak(reply)
                        self.transcript.append(TranscriptEntry(
                            speaker: .listener, text: reply, tier: .question,
                            turn: self.detector?.currentTurn ?? 0
                        ))
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.lastError = self.friendlyMessage(for: error)
                }
            }
        }
    }

    // ── coverage mode ──

    func checkCoverage() {
        guard !coverageCriteria.isEmpty else {
            lastError = "Add checklist topics in Settings first."
            return
        }
        guard let client = makeService() else { return }
        let text = transcriber.fullText
        coverageChecking = true
        Task { [weak self] in
            do {
                let result = try await client.checkCoverage(
                    transcript: text,
                    criteria: self?.coverageCriteria ?? []
                )
                await MainActor.run { [weak self] in
                    self?.coverageResult = result
                    self?.coverageChecking = false
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.lastError = self.friendlyMessage(for: error)
                    self.coverageChecking = false
                }
            }
        }
    }

    // ── helpers ──

    /// Resolve the listener backend for this call: the account proxy when
    /// signed in, the developer-mode key otherwise. Nil (with a friendly
    /// lastError) when neither is configured.
    private func makeService() -> (any ListenerService)? {
        if let service = accountStore?.makeListenerService(devAPIKey: KeychainStore.apiKey) {
            return service
        }
        // No account store injected (e.g. previews): the dev key alone.
        if accountStore == nil,
           let key = KeychainStore.apiKey,
           !key.trimmingCharacters(in: .whitespaces).isEmpty {
            return ClaudeClient(config: ClaudeConfig(apiKey: key))
        }
        lastError = "Sign in — or add a developer API key in Settings — so the "
            + "listener's rare question can reach the model."
        return nil
    }

    /// User-facing text for a failed model call. The proxy's auth/quota
    /// errors get plain-language guidance; everything else passes through.
    private func friendlyMessage(for error: Error) -> String {
        if let proxyError = error as? ProxyError {
            switch proxyError {
            case .unauthorized:
                return "Your sign-in has expired. Sign in again in Settings."
            case .quotaExceeded:
                return "You've reached today's usage cap. It resets tomorrow."
            default:
                return proxyError.localizedDescription
            }
        }
        return error.localizedDescription
    }

    private func conversationHistory(before turn: Int) -> [ConversationTurn] {
        transcript
            .filter { $0.turn < turn && !$0.text.isEmpty }
            .map {
                ConversationTurn(
                    speaker: $0.speaker == .thinker ? .thinker : .listener,
                    text: $0.text
                )
            }
    }

    private func refreshThinkerEntry() {
        guard let turn = detector?.currentTurn, turn > 0 else { return }
        let text = transcriber.currentUtteranceText
        if let idx = transcript.lastIndex(where: { $0.speaker == .thinker && $0.turn == turn }) {
            transcript[idx].text = text
        }
    }
}
