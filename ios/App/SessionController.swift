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
import UIKit

struct TranscriptEntry: Identifiable, Equatable {
    enum Speaker: Equatable { case thinker, listener }
    let id = UUID()
    let speaker: Speaker
    var text: String
    var tier: Tier?
    var turn: Int
    /// Utterance timing in ms since session start (the machine's clock — the
    /// same origin the recording starts on). `endMs` stays nil while the
    /// utterance is still open.
    var startMs: Double?
    var endMs: Double?

    init(
        speaker: Speaker,
        text: String,
        tier: Tier?,
        turn: Int,
        startMs: Double? = nil,
        endMs: Double? = nil
    ) {
        self.speaker = speaker
        self.text = text
        self.tier = tier
        self.turn = turn
        self.startMs = startMs
        self.endMs = endMs
    }
}

/// Why the last error happened, typed so the UI can respond specifically
/// rather than parse a message string. `.accountRequired` in particular
/// should render as a sign-in invitation, not a raw error alert.
enum SessionErrorKind: Equatable {
    /// No proxy session and no developer key: the listener's substantive
    /// tiers cannot reach the model until the user signs in.
    case accountRequired
    /// The proxy rejected our session token — signing in again fixes it.
    case signInExpired
    /// Everything else; `lastError` carries the human-readable text.
    case general
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
    /// Human-readable error text. Clearing it (the alert's dismiss path) also
    /// clears `lastErrorKind`, so the two never disagree.
    @Published var lastError: String? {
        didSet { if lastError == nil { lastErrorKind = nil } }
    }
    /// Typed companion to `lastError` — see `SessionErrorKind`. Set whenever
    /// `lastError` is set by the controller; nil whenever `lastError` is nil.
    @Published private(set) var lastErrorKind: SessionErrorKind?
    /// True while the system holds the mic (phone call, Siri, alarm). The
    /// session is parked, its checkpoint written; it resumes or finalizes
    /// when the interruption ends.
    @Published private(set) var isInterrupted = false

    /// Developer cost readout: the running per-session model spend. Only shown
    /// behind the `showCostReadout` debug toggle; always accumulated so the
    /// figure is ready if the toggle is on.
    @Published private(set) var sessionCost = SessionCost()

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
    /// Off by default: prompts/claude.md forbids minimal acknowledgments, so the
    /// spoken backchannel contradicted the listener's own role. Opt in under
    /// Developer settings.
    @AppStorage("speakAcknowledgments") var speakAcknowledgments = false
    /// Criteria for coverage mode, one topic per line.
    @AppStorage("coverageCriteria") var coverageCriteriaText = ""

    // ── session voice (mode tint + just-listen), persisted between launches ──
    /// Raw `SessionMode` storage — use `sessionMode` for typed access. The
    /// same key backs the picker on the session screen.
    @AppStorage("sessionMode") var sessionModeRaw = SessionMode.open.rawValue
    /// "Just listen" — questions off. Caps the gate at the acknowledge rung
    /// for uninvited turns and tints the prompt; pull-a-thread still asks.
    @AppStorage("justListen") var justListen = false
    var sessionMode: SessionMode {
        get { SessionMode(rawValue: sessionModeRaw) ?? .open }
        set { sessionModeRaw = newValue.rawValue }
    }
    /// The voice in effect for the RUNNING session — frozen at `startSession`
    /// so a mid-session change can never flip the listener's register
    /// mid-thought. Takes effect next session.
    private var activeMode: SessionMode = .open
    private var activeJustListen = false

    var coverageCriteria: [CoverageCriterion] {
        Coverage.parseCriteria(coverageCriteriaText)
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
    /// The record the running session checkpoints into: inserted on the first
    /// checkpoint, updated in place thereafter (idempotent upsert), released
    /// on final persist. Nil between sessions.
    private var activeRecord: SessionRecord?
    /// Ticks (0.1 s each) since the last heartbeat checkpoint.
    private var ticksSinceCheckpoint = 0
    /// Crash recovery runs once per launch, on the first `configure`.
    private var didRunRecovery = false

    init() {
        // Shortcuts reach the controller through the bridge (weak ref) —
        // App Intents cannot touch the SwiftUI-owned instance directly.
        IntentBridge.shared.register(self)
    }

    /// Hand in the SwiftData container and the account layer. Idempotent —
    /// the root view calls this on appear. The first call also adopts any
    /// recording a crashed session left orphaned on disk (this is the
    /// earliest moment we hold a ModelContext, and it is guaranteed to be
    /// before any new session starts recording).
    func configure(modelContext: ModelContext, accountStore: AccountStore) {
        self.modelContext = modelContext
        self.accountStore = accountStore
        // Render the listener's TTS through the mic engine so its AEC cancels
        // our own speech from the input (honest barge-in). Idempotent.
        speech.sink = pipeline
        if !didRunRecovery {
            didRunRecovery = true
            SessionRecovery.adoptOrphanedRecordings(in: modelContext)
        }
        // A Shortcut may have queued a start before we could save sessions.
        consumePendingIntentAction()
    }

    /// Drain the action a Shortcut queued in `IntentBridge`, if any. Runs
    /// only once a ModelContext is in hand — a session started earlier could
    /// never be saved — so a cold-launch intent waits here for `configure`.
    /// Firing while a session runs is a no-op (nothing double-starts, and
    /// the persisted voice is left alone).
    func consumePendingIntentAction() {
        guard modelContext != nil else { return }
        guard let action = IntentBridge.shared.takePendingAction() else { return }
        switch action {
        case let .startListening(mode, justListen):
            guard !isRunning else { return }
            if let mode { sessionMode = mode }
            if let justListen { self.justListen = justListen }
            Task { await startSession() }
        }
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
            fail("Microphone access is required to listen.")
            return
        }
        guard await SpeechTranscriber.requestAuthorization() else {
            fail("Speech recognition access is required to transcribe.")
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
        sessionCost = SessionCost()
        coverageResult = nil
        activeRecord = nil
        ticksSinceCheckpoint = 0
        isInterrupted = false
        // Freeze the session voice: the picker edits the NEXT session.
        activeMode = sessionMode
        activeJustListen = justListen

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
        // The pipeline reports; we decide. See `handleInterruption` for the
        // policy (park + checkpoint on began, resume or finalize on ended).
        pipeline.onInterruption = { [weak self] event in
            MainActor.assumeIsolated { self?.handleInterruption(event) }
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
            fail("Could not start the microphone: \(error.localizedDescription)")
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
        // Thinking out loud means long stretches of not touching the screen —
        // don't let auto-lock read that as absence. Background audio makes a
        // lock survivable, but mid-session lock is still a jolt.
        UIApplication.shared.isIdleTimerDisabled = true
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
        isInterrupted = false
        machineState = .listening
        patienceProgress = nil
        UIApplication.shared.isIdleTimerDisabled = false
        persistSession(final: true)
    }

    // ── lifecycle: interruptions & scene phase ──

    /// Policy for the pipeline's interruption events. The stance throughout:
    /// a session must survive locking, calls, and route flaps — and when it
    /// truly cannot continue, it must *finalize*, never evaporate.
    private func handleInterruption(_ event: AudioPipeline.Interruption) {
        guard isRunning else { return }
        switch event {
        case .began:
            // The system took the mic (call, Siri, alarm). Park everything
            // cleanly and checkpoint — if the session never comes back,
            // nothing said so far is lost. The transcriber is left `running`:
            // its duty-cycle restart loop treats the audio gap like any other
            // task death, committing the partial and waiting for buffers.
            isInterrupted = true
            speech.stop()
            pipeline.suspend()
            parkTurnMachine()
            persistSession(final: false)

        case .ended(let shouldResume):
            guard isInterrupted else { return }
            isInterrupted = false
            guard shouldResume else {
                // The system says the mic is not ours to take back (e.g. the
                // user moved on to another audio app mid-call). Finish
                // honestly rather than pretend to listen to a dead mic.
                stopSession()
                return
            }
            do {
                // Re-taps at the current input format; committed transcript
                // text carried across the gap, and the next words open a
                // fresh turn (the park dropped the old one) — re-anchored.
                try pipeline.resume()
            } catch {
                stopSession()
                fail("The microphone could not be restarted after the interruption. The session was saved.")
            }

        case .routeLost:
            // Headphones unplugged / AirPods case shut. Keep the session
            // alive: re-tap whatever input is current — the built-in mic.
            do {
                try pipeline.resume()
            } catch {
                stopSession()
                fail("The microphone route was lost. The session was saved.")
            }

        case .mediaServicesReset:
            // The audio daemon died under us; every audio object is invalid.
            // Checkpoint first, then rebuild the engine from scratch.
            persistSession(final: false)
            do {
                try pipeline.resume(rebuild: true)
            } catch {
                stopSession()
                fail("Audio services were reset. The session was saved.")
            }
        }
    }

    /// Answer any outstanding evaluation with `silence` and drop the open
    /// turn — when audio returns, the next words start a fresh turn (which
    /// also re-anchors the transcriber's utterance offset via `turnStart`).
    private func parkTurnMachine() {
        detector?.input(.decision(t: nowMs(), outcome: .silence))
        detector?.dropTurn()
        lastEouProb = .nan
        patienceProgress = nil
        machineState = detector?.state ?? .listening
    }

    /// Forwarded from the App's `scenePhase`. Backgrounding checkpoints the
    /// running session (the audio background mode keeps it alive, but jetsam
    /// does not knock first) and releases the idle-timer hold — background
    /// audio makes a lock survivable, so we don't fight the lock there.
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            if isRunning { persistSession(final: false) }
            UIApplication.shared.isIdleTimerDisabled = false
        case .active:
            UIApplication.shared.isIdleTimerDisabled = isRunning
            // A start intent can land while we foreground — drain it here in
            // case `perform()` raced the controller's registration.
            consumePendingIntentAction()
        default:
            break
        }
    }

    // ── persistence ──

    /// Write the running session's state to the library now (idempotent
    /// upsert). Cheap by design — one JSON encode and a SwiftData save.
    func checkpoint() {
        guard isRunning else { return }
        persistSession(final: false)
    }

    /// Upsert the session into the library. Non-final calls (checkpoints —
    /// interruptions, backgrounding, the 30 s heartbeat) insert the record
    /// once and update it in place thereafter, so a crash at any moment loses
    /// at most the last few seconds of words. The final call (stop) is the
    /// full-quality path: by then the recording sink has closed, so the .m4a
    /// is finalized and playable. If we die before the final call, the
    /// checkpointed record still points at the partially-written file —
    /// whatever of it is readable is kept, and a session that died before its
    /// FIRST checkpoint gets its audio adopted by `SessionRecovery` on the
    /// next launch.
    ///
    /// Only sessions where something was actually said are kept; an empty
    /// session's orphan audio file is deleted on the final call.
    private func persistSession(final: Bool) {
        let started = sessionStartDate ?? Date()
        let stored = storedEntries()

        guard let modelContext,
              !stored.isEmpty,
              let transcriptJSON = try? JSONEncoder().encode(stored)
        else {
            if final {
                if let fileName = recordingFileName {
                    RecordingStorage.delete(fileName: fileName)
                }
                sessionStartDate = nil
                recordingFileName = nil
                activeRecord = nil
            }
            return
        }

        let record: SessionRecord
        if let activeRecord {
            record = activeRecord
            record.duration = Date().timeIntervalSince(started)
            record.title = SessionRecord.deriveTitle(from: stored)
            record.transcriptJSON = transcriptJSON
            record.criteriaText = coverageCriteriaText
            record.coverageJSON = coverageResult.flatMap { try? JSONEncoder().encode($0) }
            // Only store a figure when every call was metered; the usage-less
            // proxy path leaves it nil (cost unknown, not zero).
            record.costUSD = sessionCost.isExact ? sessionCost.dollars() : nil
        } else {
            record = SessionRecord(
                startedAt: started,
                duration: Date().timeIntervalSince(started),
                title: SessionRecord.deriveTitle(from: stored),
                transcriptJSON: transcriptJSON,
                criteriaText: coverageCriteriaText,
                coverageJSON: coverageResult.flatMap { try? JSONEncoder().encode($0) },
                audioFileName: recordingFileName,
                costUSD: sessionCost.isExact ? sessionCost.dollars() : nil
            )
            modelContext.insert(record)
            activeRecord = record
        }
        try? modelContext.save()

        if final {
            lastSavedRecordID = record.id
            sessionStartDate = nil
            recordingFileName = nil
            activeRecord = nil
        }
    }

    /// The transcript flattened for storage, with per-utterance timing. An
    /// utterance still open at write time keeps `endMs` nil.
    private func storedEntries() -> [StoredEntry] {
        transcript
            .filter { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }
            .map {
                StoredEntry(
                    speaker: $0.speaker == .thinker ? "thinker" : "listener",
                    text: $0.text,
                    tier: $0.tier?.rawValue,
                    turn: $0.turn,
                    startMs: $0.startMs.map { Int($0.rounded()) },
                    endMs: $0.endMs.map { Int($0.rounded()) }
                )
            }
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

        // Crash-safety heartbeat: ~every 30 s of session time, checkpoint the
        // transcript (cheap — one JSON encode) so an uncaught death costs
        // half a minute of words at most.
        ticksSinceCheckpoint += 1
        if ticksSinceCheckpoint >= 300 {
            ticksSinceCheckpoint = 0
            persistSession(final: false)
        }

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
        case .turnStart(let t, let turn):
            transcriber.markUtteranceStart()
            transcript.append(TranscriptEntry(
                speaker: .thinker, text: "", tier: nil, turn: turn, startMs: t
            ))

        case .evaluate(_, let turn, _, let reason, _):
            evaluate(turn: turn, reason: reason)

        case .turnEnd(let t, let turn, _, _):
            // Text is already up to date via partials; stamp when it closed.
            if let idx = transcript.lastIndex(where: { $0.speaker == .thinker && $0.turn == turn }) {
                transcript[idx].endMs = t
            }

        case .responseStart(let t, _):
            if let reply = pendingReply, !reply.text.isEmpty {
                pendingReply = nil
                speech.speak(reply.text)
                transcript.append(TranscriptEntry(
                    speaker: .listener, text: reply.text, tier: reply.tier,
                    turn: detector?.currentTurn ?? 0, startMs: t
                ))
            }

        case .responseEnd(let t, _, _):
            lastFloorReleaseMs = t
            closeListenerEntry(at: t)

        case .bargeIn(let t, _):
            // The yield is instant: cut the clip at t, not at its natural end.
            speech.stop()
            lastFloorReleaseMs = t
            closeListenerEntry(at: t)
        }
    }

    /// Stamp the end of the listener utterance currently holding the floor.
    private func closeListenerEntry(at t: Double) {
        if let idx = transcript.lastIndex(where: { $0.speaker == .listener && $0.endMs == nil }) {
            transcript[idx].endMs = t
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
        var gateConfig = GateConfig.derived(from: knobs)
        gateConfig.justListen = activeJustListen
        let decision = decideTier(ctx, config: gateConfig)
        decisionsByTurn[turn] = decision.tier

        switch decision.tier {
        case .silence:
            feed(.decision(t: now, outcome: .silence))

        case .acknowledge:
            // Silent when acks are off, but the decision still COUNTS as an
            // acknowledge for question-cooldown spacing (recording it as
            // silence distorted the spacing). resolveAcknowledge splits the two.
            let resolved = resolveAcknowledge(decision, speakAcknowledgments: speakAcknowledgments)
            decisionsByTurn[turn] = resolved.recordedTier
            if let ack = resolved.spokenText {
                takeFloor(with: ack, tier: .acknowledge)
            } else {
                feed(.decision(t: now, outcome: .silence))
            }

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
            systemPrompt: ListenerPrompt.systemPrompt(mode: activeMode, justListen: activeJustListen),
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
                let reply = try await client.respondWithUsage(to: request)
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.sessionCost.add(reply.usage)
                    if reply.text.isEmpty {
                        // The model chose silence — the prompt says that is the
                        // correct response for most turns. Declining is free.
                        self.decisionsByTurn[turn] = .silence
                        self.feed(.decision(t: self.nowMs(), outcome: .silence))
                    } else {
                        self.takeFloor(with: reply.text, tier: tier)
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.report(error)
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
            fail("Nothing has been said yet.")
            return
        }
        decisionsByTurn[turn] = .question
        guard let client = makeService() else { return }
        let request = buildPullThreadRequest(
            systemPrompt: ListenerPrompt.systemPrompt(mode: activeMode, justListen: activeJustListen),
            currentTurnText: text,
            history: conversationHistory(before: turn)
        )
        isThinking = true
        Task { [weak self] in
            defer { Task { @MainActor [weak self] in self?.isThinking = false } }
            do {
                let reply = try await client.respondWithUsage(to: request)
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.sessionCost.add(reply.usage)
                    guard !reply.text.isEmpty else { return }
                    if self.detector?.state == .deciding {
                        self.takeFloor(with: reply.text, tier: .question)
                    } else {
                        // Out-of-band: the user asked while the machine was not
                        // parked on an evaluation. Speak directly; the turn
                        // continues (with AEC the mic will not hear our TTS).
                        self.speech.speak(reply.text)
                        self.transcript.append(TranscriptEntry(
                            speaker: .listener, text: reply.text, tier: .question,
                            turn: self.detector?.currentTurn ?? 0,
                            startMs: self.nowMs()
                        ))
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.report(error)
                }
            }
        }
    }

    // ── coverage mode ──

    func checkCoverage() {
        guard !coverageCriteria.isEmpty else {
            fail("Add checklist topics in Settings first.")
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
                    self.report(error)
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
        // Typed as `.accountRequired` so the UI can offer sign-in instead of
        // showing a raw error — the user most likely just skipped onboarding.
        fail(
            "Sign in — or add a developer API key in Settings — so the "
                + "listener's rare question can reach the model.",
            kind: .accountRequired
        )
        return nil
    }

    /// Surface an error to the UI: message + typed kind, set together so
    /// they can never disagree.
    private func fail(_ message: String, kind: SessionErrorKind = .general) {
        lastErrorKind = kind
        lastError = message
    }

    /// Surface a failed model call: friendly text plus a typed kind (an
    /// expired proxy session is sign-in territory, like `.accountRequired`).
    private func report(_ error: Error) {
        let kind: SessionErrorKind = (error as? ProxyError) == .unauthorized
            ? .signInExpired : .general
        fail(friendlyMessage(for: error), kind: kind)
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
