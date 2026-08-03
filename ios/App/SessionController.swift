// The host — wires audio → TurnDetector → response gate → Claude → TTS.
//
// This is the iOS counterpart of web/src/main.ts: the impure shell around the
// pure engine. The division of labour after the transcript-core rewrite
// (docs/plans/2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, "Host"
// section), with PR#37's ambient-analysis brain layered on top:
//
//   CaptureController    mic → canonical buffers + speech-start/end events
//                        (both clocks: wall ms for the detector, canonical
//                        audio seconds for the store). Also owns the TTS
//                        playback sink, so the AEC cancels our own voice.
//   AnalyzerEngine       canonical buffers → EngineEvents (stable segment IDs)
//   TranscriptStore      the ONE source of truth for transcript state — the
//                        UI, the evidence feed, persistence, and agents are
//                        all subscribers of the same multicast log (R4.1)
//   AgentFeed            the public in-process subscription seam over the
//                        store (R4.2), published per session; coverage mode
//                        consumes it, and the opt-in TranscriptForwarder
//                        rides its finalized-only stream (R4.3)
//   LinguisticEOU        utterance text → P(complete) evidence
//   TurnDetector         pure reducer: when the patience window closes, it asks
//                        (`evaluate`) — it never decides to speak on its own
//   decideTier (gate)    rules answer silence/acknowledge with NO model call;
//                        only reflection/question reach Claude
//   ConversationAnalyst  the ambient brain: warms a candidate pool between
//                        turns so the common case lands with no round-trip
//   SpeechOutput         speaks the reply; barge-in cuts it instantly
//
// Two bridge tasks connect the seams. The ENGINE BRIDGE consumes
// engine.events (single consumer) and writes store.append/revise/finalize.
// The STORE SUBSCRIPTION consumes store.updates() and refreshes the
// MainActor caches: the published transcript, and — load-bearing —
// `cachedUtteranceText`, the current utterance as the gate must see it.
// `speech-end` handling and evidence re-fires read that cache SYNCHRONOUSLY:
// there is never an `await` between a VAD event and feeding its evidence to
// the detector, preserving the strict main-actor event ordering the machine
// relies on. Evidence is stamped at delivery (`nowMs`) and dropped unless the
// machine is in `pending`/`deciding`, exactly as before the rewrite.
//
// Utterance identity is segment identity + canonical audio time (R2.4):
// `turn-start` becomes `store.startTurn(turn, atAudioTime:)` via the capture
// clock's wall→audio mapping — the old character-offset anchor is gone.
// Host-driven store writes (turn starts, listener segments) are chained onto
// one serial task so append-before-close ordering can never invert.
//
// THE ANALYST'S DRIFT BASIS is `cachedFinalizedText`, not `cachedFullText`.
// `CandidatePool` anchors candidate freshness to a character offset and
// expires on `currentPosition - anchorPosition > maxDrift`, which is only
// meaningful while `currentPosition` never decreases. `fullText` includes
// volatile segments and SpeechAnalyzer revises those in place — a revision can
// be SHORTER — so a fullText basis lets drift go negative and candidates stop
// expiring exactly when the transcript churns. BOTH analyst call sites (`tick`
// and `candidate(for:transcriptLength:)`) must read the same basis: split them
// and drift is systematically mis-stated in one direction or the other, both
// compile, and both are silent. `askNow` and `checkCoverage` deliberately stay
// on the live text — they want the in-flight utterance and are not anchored to
// anything.
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
import TranscriptCore
import TurnEngine
import UIKit

/// The UI's view of one transcript line. `id` is the store segment's
/// engine-issued SegmentID — stable across volatile revisions, so SwiftUI
/// treats a refining segment as the SAME row, not a new one.
struct TranscriptEntry: Identifiable, Equatable {
    enum Speaker: Equatable { case thinker, listener }
    let id: SegmentID
    let speaker: Speaker
    var text: String
    var tier: Tier?
    var turn: Int
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
    /// Truthful capture state from CaptureController (R1.2): the UI shows
    /// paused/resuming instead of pretending to listen through a phone call.
    @Published private(set) var captureState: CaptureController.State = .idle
    /// Human-readable error text. Clearing it (the alert's dismiss path) also
    /// clears `lastErrorKind`, so the two never disagree.
    @Published var lastError: String? {
        didSet { if lastError == nil { lastErrorKind = nil } }
    }
    /// Typed companion to `lastError` — see `SessionErrorKind`. Set whenever
    /// `lastError` is set by the controller; nil whenever `lastError` is nil.
    @Published private(set) var lastErrorKind: SessionErrorKind?

    /// True while the system holds the mic (phone call, Siri, alarm) or we are
    /// climbing back out. Derived from `captureState` rather than stored: after
    /// the port CaptureController owns the audio graph and reports the truth,
    /// so a second stored flag could only ever disagree with it.
    var isInterrupted: Bool {
        captureState == .paused || captureState == .resuming
    }

    /// Developer cost readout: the running per-session model spend. Only shown
    /// behind the `showCostReadout` debug toggle; always accumulated so the
    /// figure is ready if the toggle is on.
    @Published private(set) var sessionCost = SessionCost()

    /// The top on-screen hints (spec §2/§3): the analyst's best 1–2 candidates,
    /// republished from the background brain. Empty when the pool is cold.
    @Published private(set) var hint: [Candidate] = []

    /// The ambient analysis brain. Owned here; driven from the tick + turn-end.
    private let analyst = ConversationAnalyst()

    // Coverage mode
    @Published private(set) var coverageResult: CoverageResult?
    @Published private(set) var coverageChecking = false
    /// Monotonic count of completed coverage checks. The UI presents the
    /// sheet when this changes — a repeat check returning the IDENTICAL
    /// result would never fire an onChange of `coverageResult` itself.
    @Published private(set) var coverageCheckCount = 0

    /// The id of the SessionRecord saved by the last `stopSession`, for the
    /// "Saved to library" confirmation. Nil when nothing was worth saving.
    @Published private(set) var lastSavedRecordID: UUID?

    /// The agent seam (R4.2): the running session's public subscription point
    /// over the transcript spine, for any feature that wants to attach —
    /// coverage, the opt-in forwarder, a debug console. Session-scoped: set
    /// at start, nil between sessions.
    @Published private(set) var agentFeed: AgentFeed?

    // ── live-tunable knobs (mirrors web/src/knobs.ts; defaults bias to "keep listening") ──
    @Published var knobs = TurnKnobs.defaults {
        didSet {
            // Preserve the machine's LIVE responseDurationMs: takeFloor sizes
            // it to the clip being spoken, and a slider edit mid-response must
            // not clobber the response window with the struct's default.
            detector?.setKnobs {
                let liveResponseMs = $0.responseDurationMs
                $0 = knobs
                $0.responseDurationMs = liveResponseMs
            }
        }
    }
    /// Speak the rules-only backchannel ("mm", "yeah") on short finished asides.
    /// Off by default: prompts/claude.md forbids minimal acknowledgments, so the
    /// spoken backchannel contradicted the listener's own role. Opt in under
    /// Developer settings.
    @AppStorage("speakAcknowledgments") var speakAcknowledgments = false
    /// Criteria for coverage mode, one topic per line.
    @AppStorage("coverageCriteria") var coverageCriteriaText = ""
    // The opt-in transcript feed (R4.3; same keys as SettingsView). Read at
    // session start — flipping the toggle applies from the next session.
    @AppStorage("transcriptFeedEnabled") var transcriptFeedEnabled = false
    @AppStorage("transcriptFeedURL") var transcriptFeedURL = ""
    @AppStorage("transcriptFeedCadenceSeconds") var transcriptFeedCadenceSeconds = 5

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
    private var store: TranscriptStore?
    private var capture: CaptureController?
    /// Held concretely for `prepare()` (canonical-format query + preheat);
    /// everything downstream of `start` speaks only the TranscriptionEngine
    /// protocol — the seam a WhisperKit arm would plug into (plan Phase W).
    private var engine: SpeechAnalyzerTranscriptionEngine?
    #if DEBUG
    /// CI-only fixture driver (design: in-app audio injection). Non-nil only
    /// while a `-captureInjectAudio` session is running. DEBUG-only — the
    /// capture seam is compiled out of Release (su-uzy9.1, f4).
    private var injector: CaptureAudioInjector?
    #endif
    private let speech = SpeechOutput()
    private var tickTimer: Timer?
    /// One-shot CI capture watchdog (design §reliability); invalidated on stop
    /// so a stale fire can't paint the seed into a later session.
    private var seedWatchdogTimer: Timer?
    private var clockOrigin: TimeInterval = 0
    /// The stop path is async (the engine drain); block re-entry until done.
    private var isStopping = false
    /// The start path is async too (permission, assets, engine prepare/start)
    /// and `isRunning` flips only at its END — this latch is set synchronously
    /// BEFORE the first await so a double-invoke cannot stand up a second
    /// capture stack (leaked observers, un-invalidated tickTimer, stranded
    /// recording record). Cleared on every exit path.
    private var isStarting = false

    // ── bridge tasks + MainActor caches (see header) ──
    private var engineBridgeTask: Task<Void, Never>?
    private var storeSubscriptionTask: Task<Void, Never>?
    /// The incremental persistence arm (plan R3.1): its own ModelContext off
    /// the shared container, subscribed to the store, saving per final. The
    /// record itself is created on the MAIN context at session start; the
    /// writer holds only its persistentModelID.
    private var writer: PersistenceWriter?
    private var writerTask: Task<Void, Never>?
    /// The id of the record the running session writes into (for
    /// `lastSavedRecordID` once closeOut confirms the record was kept).
    private var currentRecordID: UUID?
    /// Host-driven store writes chained onto one serial task, so e.g. a
    /// listener segment's append can never execute after its close.
    private var lastStoreWrite: Task<Void, Never>?
    /// The opt-in remote arm (R4.3) — exists only while a session runs WITH
    /// the Settings toggle on; nil means zero transcript egress.
    private var forwarder: TranscriptForwarder?

    /// The current utterance as the gate must see it — refreshed by the store
    /// subscription, reset synchronously at turn-start, and read with NO await
    /// on the VAD/evidence path.
    private var cachedUtteranceText = ""
    /// Everything the thinker has said, finalized + volatile (askNow's
    /// fallback). NOT the analyst's basis — see the header.
    private var cachedFullText = ""
    /// The thinker's SETTLED text — the analyst's drift basis. Cached beside
    /// `cachedFullText` from the same store event rather than fetched on
    /// demand, because `analyst.candidate(for:transcriptLength:)` is called
    /// synchronously inside the gate's decision path and cannot await.
    private var cachedFinalizedText = ""
    /// Latest store snapshot, for synchronous reads (history, transcript).
    private var segmentsSnapshot: [TranscriptSegment] = []
    /// The listener segment currently holding the floor, awaiting its close.
    private var openListenerSegmentID: SegmentID?

    /// Latest EOU probability for the current pause (gate rule 2 evidence).
    private var lastEouProb: Double = .nan
    private var lastSpeechEndMs: Double = .nan
    /// When the companion last released the floor (response-end / barge-in /
    /// an interruption cutting a clip). WALL-clock ms from `nowMs()` — not the
    /// canonical audio clock, which stops with the engine. The two diverge by
    /// exactly the length of an interruption.
    private var lastFloorReleaseMs: Double = .infinity
    /// Final decision per UTTERANCE (spec §4b) — the gate's history.
    private var decisionsByTurn: [Int: Tier] = [:]
    /// The reply text currently holding (or about to hold) the floor.
    private var pendingReply: (text: String, tier: Tier)?

    /// The machine's identity for one evaluated pause: which thought (`turn`)
    /// and which patience-window closure within it (`evaluation`) — spec §4b's
    /// two ids.
    private struct PauseKey: Hashable {
        let turn: Int
        let evaluation: Int
    }

    /// Evaluated pauses already handed to the analyst. A pause can be
    /// re-evaluated on fresh EOU evidence under the SAME evaluation id, and a
    /// `speak` verdict replays that id onto `turnEnd`, so de-duping here makes
    /// one substantive pause worth exactly one mark however often we see it.
    private var analyzedPauses: Set<PauseKey> = []

    /// Bumped on every session start and stop. A model call captures the value
    /// it was launched under and drops its reply unless the token still
    /// matches: a reply landing after stop/start belongs to a conversation that
    /// no longer exists and must not add cost, answer this session's machine,
    /// speak, or append to its transcript. The analyst holds its own generation
    /// counter for the same reason (`ConversationAnalyst.reset`).
    ///
    /// `isRunning` alone is NOT sufficient and never was: stop a session and
    /// start another inside one in-flight request and `isRunning` is `true`
    /// again while the reply belongs to the previous conversation. The
    /// transcript seam did not make this redundant — it fences model replies,
    /// which are a network round-trip, not transcript delivery.
    private var sessionGeneration = 0

    // ── app context (late-bound from the SwiftUI environment) ──
    private var modelContext: ModelContext?
    private var accountStore: AccountStore?
    /// Wall-clock start of the running session, for the saved record.
    private var sessionStartDate: Date?
    /// File name of the in-progress CAF recording under RecordingStorage
    /// (remuxed to .m4a at graceful stop).
    private var recordingFileName: String?
    /// Crash recovery runs once per launch, on the first `configure`.
    private var didRunRecovery = false

    init() {
        // Shortcuts reach the controller through the bridge (weak ref) —
        // App Intents cannot touch the SwiftUI-owned instance directly.
        IntentBridge.shared.register(self)

        analyst.makeService = { [weak self] in self?.resolveService() }
        analyst.onUsage = { [weak self] usage in self?.sessionCost.add(usage) }
        analyst.onCandidatesChanged = { [weak self] candidates in
            self?.hint = Array(candidates.prefix(2))
        }
    }

    /// Hand in the SwiftData container and the account layer. Idempotent —
    /// the root view calls this on appear.
    func configure(modelContext: ModelContext, accountStore: AccountStore) {
        self.modelContext = modelContext
        self.accountStore = accountStore
        if !didRunRecovery {
            didRunRecovery = true
            // ORDERING IS LOAD-BEARING, and the two sweeps are not commutative.
            // `PersistenceWriter.recoverIncompleteSessions` remuxes a crashed
            // CAF to .m4a and then adopts it into its own record. Between the
            // remux and the save there is a window where a finished-looking
            // .m4a exists whose record does not yet point at it — an orphan
            // sweep running in that window adopts a DUPLICATE "Recovered
            // recording" for audio that already has a home. So the orphan
            // sweep waits on the same latch `startSession` waits on.
            //
            // `adoptOrphanedRecordings` documents its own precondition ("called
            // once per launch, before any new session can start recording");
            // running it behind the gate keeps that true and adds the second
            // ordering the port needs.
            let context = modelContext
            Task { @MainActor in
                await RecoveryGate.shared.waitUntilDone()
                SessionRecovery.adoptOrphanedRecordings(in: context)
            }
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
        if isRunning {
            stopSession()
        } else if !isStarting, !isStopping {
            Task { await startSession() }
        }
    }

    func startSession() async {
        guard !isRunning, !isStarting, !isStopping else { return }
        // Latch synchronously, BEFORE the first await (see isStarting). The
        // defer clears it on every exit path — success included: from
        // `isRunning = true` on, re-entry is blocked by the isRunning guard.
        isStarting = true
        defer { isStarting = false }
        lastError = nil

        // Launch recovery closes every `recording`-state record it finds —
        // wait for it, or it could adopt this session's just-created record as
        // a crashed one. The gate is already open on every start after the
        // first await completes once.
        await RecoveryGate.shared.waitUntilDone()

        // Under CI capture (-uiTestCapture) the simulator's privacy is pre-granted
        // by capture-demo.sh, so skip the interactive permission request — a TCC
        // dialog would otherwise suspend startup and the session would never go live.
        // `captureActive` is a compile-time `false` in Release (the seam is
        // DEBUG-only, su-uzy9.1 f4), so production always runs the real request.
        #if DEBUG
        let captureActive = CaptureSeam.isActive
        #else
        let captureActive = false
        #endif
        if !captureActive {
            // Mic permission only: SpeechAnalyzer's on-device recognition has
            // no speech-authorization gate (plan Key Decisions — the legacy
            // SFSpeechRecognizer.requestAuthorization path is gone, and with it
            // the NSSpeechRecognitionUsageDescription Info.plist key).
            guard await AVAudioApplication.requestRecordPermission() else {
                fail("Microphone access is required to listen.")
                return
            }
        }

        // R2.6: re-verify the on-device model at EVERY session start — assets
        // can be evicted under storage pressure. Missing → try to fetch;
        // failing that, block with a clear message rather than start deaf.
        let locale = Locale.current
        switch await AssetEnsure.status(for: locale) {
        case .installed:
            break
        case .unsupported:
            fail(AssetEnsure.AssetError.unsupportedLocale(locale).localizedDescription)
            return
        case .needsDownload:
            do {
                try await AssetEnsure.ensure(for: locale)
            } catch {
                fail("The on-device speech model isn't installed. "
                    + "Connect to the internet and try again.")
                return
            }
        }

        // Engine first: prepare() resolves THE canonical format for the whole
        // session (SpeechAnalyzer's best available for this transcriber) and
        // preheats so first words don't lag.
        let engine = SpeechAnalyzerTranscriptionEngine(locale: locale)
        engine.onError = { [weak self] message in
            MainActor.assumeIsolated { self?.fail(message) }
        }
        let canonicalFormat: AVAudioFormat
        do {
            canonicalFormat = try await engine.prepare()
        } catch {
            fail("Could not start transcription: \(error.localizedDescription)")
            return
        }

        // A new conversation: anything still in flight from the last one is
        // now stale and must not touch this session's state.
        sessionGeneration += 1
        clockOrigin = ProcessInfo.processInfo.systemUptime
        sessionStartDate = Date()
        lastSavedRecordID = nil
        lastEouProb = .nan
        lastSpeechEndMs = .nan
        lastFloorReleaseMs = .infinity
        decisionsByTurn = [:]
        analyzedPauses = []
        pendingReply = nil
        transcript = []
        sessionCost = SessionCost()
        analyst.reset()
        hint = []
        coverageResult = nil
        coverageChecking = false
        isThinking = false
        cachedUtteranceText = ""
        cachedFullText = ""
        cachedFinalizedText = ""
        segmentsSnapshot = []
        openListenerSegmentID = nil
        engineBridgeTask?.cancel()
        storeSubscriptionTask?.cancel()
        writerTask?.cancel()
        writerTask = nil
        writer = nil
        currentRecordID = nil
        lastStoreWrite = nil
        forwarder = nil
        // Freeze the session voice: the picker edits the NEXT session.
        activeMode = sessionMode
        activeJustListen = justListen

        let store = TranscriptStore()
        self.store = store
        self.engine = engine
        // The agent seam goes up WITH the store: any feature can attach from
        // the first word (R4.2).
        let feed = AgentFeed(store: store)
        agentFeed = feed
        detector = TurnDetector(knobs: knobs)

        let capture = CaptureController()
        self.capture = capture
        // Render the listener's TTS through the SAME engine that taps the mic,
        // so its AEC cancels our own speech from the input (honest barge-in).
        // Re-homed from AudioPipeline, which owned the player node before the
        // port (§3.3).
        speech.sink = capture
        wireCapture(capture)
        wireSpeechOutput()

        // R3.1: the SessionRecord exists BEFORE capture starts — state
        // `recording`, placeholder title, the CAF already referenced — so the
        // audio file is owned by a record from its very first sample and can
        // never be orphaned. The PersistenceWriter subscribes with
        // replayingSnapshot: false (nothing to replay — the log is empty; the
        // record predates any segment) and saves on every finalized segment
        // and turn start, no debounce. A crash from here on costs at most the
        // current volatile segment; a failed start below deletes record and
        // file together (abortStart).
        let fileName = RecordingStorage.cafFileName(stem: UUID().uuidString)
        recordingFileName = fileName
        var record: SessionRecord?
        if let modelContext {
            let newRecord = SessionRecord(
                startedAt: sessionStartDate ?? Date(),
                title: SessionRecord.placeholderTitle,
                state: .recording,
                criteriaText: coverageCriteriaText,
                audioFileName: fileName
            )
            modelContext.insert(newRecord)
            try? modelContext.save() // save first: the ID must be permanent
            record = newRecord
            currentRecordID = newRecord.id
            let writer = PersistenceWriter(
                modelContainer: modelContext.container,
                recordID: newRecord.persistentModelID
            )
            self.writer = writer
            writerTask = Task {
                let updates = await store.updates(replayingSnapshot: false)
                await writer.run(updates: updates)
            }
        }

        #if DEBUG
        let injectingCapture = CaptureSeam.shouldInjectAudio
        #else
        let injectingCapture = false
        #endif

        // Capture opens the CAF (AAC-in-CAF, crash-safe, remuxed to .m4a at
        // graceful stop) BEFORE installing the tap: the recording, the
        // fed-samples clock, and the analyzer all begin at the same first
        // buffer, so every stored timing stays aligned with the file. The
        // recording itself is best-effort — the session runs without one.
        let buffers: AsyncStream<AVAudioPCMBuffer>
        do {
            buffers = try capture.start(
                canonicalFormat: canonicalFormat,
                clockOrigin: clockOrigin,
                recordingTo: RecordingStorage.url(for: fileName),
                injecting: injectingCapture
            )
        } catch {
            fail("Could not start the microphone: \(error.localizedDescription)")
            abortStart(record: record)
            return
        }
        if !capture.isRecording {
            // No recording opened: drop the dangling audio reference (and any
            // half-created file) now, so nothing downstream points at audio
            // that will never exist.
            RecordingStorage.deleteBoth(stem: RecordingStorage.stem(of: fileName))
            recordingFileName = nil
            record?.audioFileName = nil
            try? modelContext?.save()
        }

        startEngineBridge(engine: engine, store: store)
        startStoreSubscription(store: store)

        do {
            try await engine.start(buffers: buffers)
        } catch {
            fail("Could not start transcription: \(error.localizedDescription)")
            capture.stop()
            abortStart(record: record)
            return
        }

        #if DEBUG
        // CI capture: drive the real capture graph from the bundled fixture
        // .wav instead of the (silent) simulator mic. Injected buffers go
        // through the canonical converter, so they reach the recording sink,
        // the analyzer, the VAD, AND advance the fed-samples clock exactly as
        // live audio does — which is what makes the injected run produce real
        // audioStart/audioEnd ranges and exercise the replay path too. Inert
        // unless the flag is set.
        if injectingCapture {
            let injector = CaptureAudioInjector { [weak self] buffer in
                self?.capture?.injectForCapture(buffer)
            }
            self.injector = injector
            injector.start()
            // Watchdog: if real transcription is still empty ~8 s in, paint the
            // fixture so the transcript/hint checkpoints still render.
            // Injection stays primary; this is the net.
            seedWatchdogTimer = Timer.scheduledTimer(withTimeInterval: 8.0, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.isRunning else { return }
                    let hasRealText = self.transcript.contains {
                        $0.speaker == .thinker
                            && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    }
                    if !hasRealText { self.seedCaptureState() }
                }
            }
        }
        #endif

        // R4.3: the opt-in remote arm — ONLY when the user turned the toggle
        // on, and only toward an HTTPS endpoint. A missing/invalid URL
        // disables the forwarder, never the session. With the toggle off
        // (the default) no forwarder exists and zero transcript text leaves
        // the device.
        if transcriptFeedEnabled,
           let url = URL(string: transcriptFeedURL.trimmingCharacters(in: .whitespaces)),
           url.scheme?.lowercased() == "https" {
            let forwarder = TranscriptForwarder(
                feed: feed,
                sessionID: currentRecordID ?? UUID(),
                endpoint: url,
                cadenceSeconds: TimeInterval(transcriptFeedCadenceSeconds)
            )
            self.forwarder = forwarder
            Task { await forwarder.start() }
        }

        // Housekeeping, off the start path: drop model reservations for
        // locales we no longer transcribe (R2.6).
        Task.detached { await AssetEnsure.releaseStaleReservations(keeping: locale) }

        tickTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.onTick() }
        }

        isRunning = true
        machineState = .listening
        #if DEBUG
        seedCaptureStateIfNeeded()
        #endif
        // Thinking out loud means long stretches of not touching the screen —
        // don't let auto-lock read that as absence. Background audio makes a
        // lock survivable, but mid-session lock is still a jolt.
        UIApplication.shared.isIdleTimerDisabled = true
    }

    /// Unwind a failed start: tear down whatever was already stood up (bridge
    /// tasks, writer, capture) and delete the just-created record together
    /// with its recording file — a session that never ran leaves nothing
    /// behind.
    private func abortStart(record: SessionRecord?) {
        engineBridgeTask?.cancel()
        engineBridgeTask = nil
        storeSubscriptionTask?.cancel()
        storeSubscriptionTask = nil
        writerTask?.cancel()
        writerTask = nil
        writer = nil
        currentRecordID = nil
        #if DEBUG
        injector?.stop()
        injector = nil
        seedWatchdogTimer?.invalidate()
        seedWatchdogTimer = nil
        #endif
        if let record {
            modelContext?.delete(record)
            try? modelContext?.save()
        }
        if let recordingFileName {
            RecordingStorage.deleteBoth(stem: RecordingStorage.stem(of: recordingFileName))
        }
        recordingFileName = nil
        speech.sink = nil
        capture = nil
        engine = nil
        store = nil
        detector = nil
        agentFeed = nil
    }

    func stopSession() {
        guard isRunning, !isStopping else { return }
        isStopping = true
        // Retire the token first: a model call already in flight is answering a
        // conversation that ends here, and its reply must land nowhere.
        sessionGeneration += 1
        #if DEBUG
        injector?.stop()
        injector = nil
        #endif
        tickTimer?.invalidate()
        tickTimer = nil
        seedWatchdogTimer?.invalidate()
        seedWatchdogTimer = nil
        speech.stop()
        // The synthesizer reports the cut clip via didCancel, asynchronously —
        // close the open listener segment HERE, synchronously, at the cut
        // point: a stop mid-speech must never persist unspoken words as
        // spoken. The close is enqueued on the serial write chain (drained by
        // the stop task below) and idempotent — didCancel's late onFinished
        // close finds the open ID already nilled and no-ops.
        closeOpenListener(bargedIn: true)
        capture?.stopRecording()
        // Kill the decision loop SYNCHRONOUSLY, before the drain's first
        // await can let a VAD callback, an evidence re-fire, or a landing
        // model reply drive it: answer the outstanding evaluation (if any)
        // with the cheap `silence` — exactly once, spec §4a; a late model
        // reply finds the detector gone and its decision/takeFloor no-op —
        // then abandon the turn and drop the machine. This feeds the detector
        // directly: `feed(_:)` is guarded on isRunning for everyone else.
        detector?.input(.decision(t: nowMs(), outcome: .silence))
        detector?.dropTurn()
        detector = nil
        // End the analyzer's buffer stream now, so stopAndFinalize's feed
        // task drains the queued tail and finishes naturally instead of being
        // cancelled mid-stream.
        capture?.finishBuffers()
        isRunning = false
        patienceProgress = nil
        machineState = .listening
        // The in-flight indicators belong to calls whose replies are now
        // discarded by the generation guard — clear them here rather than
        // leaving a spinner up for a session that has ended.
        isThinking = false
        coverageChecking = false
        analyst.reset()
        hint = []
        UIApplication.shared.isIdleTimerDisabled = false

        // The plan's stop sequence: engine drain FIRST (finish input →
        // finalize-through-end-of-input → drain results), so the trailing
        // finals land in the store before anything reads it — a graceful stop
        // loses nothing. Then capture teardown and the writer's close-out
        // (with the CAF → .m4a remux).
        Task { [weak self] in
            guard let self else { return }
            await self.engine?.stopAndFinalize()
            await self.engineBridgeTask?.value // every engine write committed
            await self.lastStoreWrite?.value // every host write committed
            self.capture?.stop()
            await self.closeOutSession()
            // The forwarder's tail flush runs detached: it reconciles against
            // the post-drain snapshot (the feed keeps the store alive) and its
            // final POST must not be able to hold the stop path — delivery is
            // best-effort, stopping is not.
            if let forwarder = self.forwarder {
                self.forwarder = nil
                Task.detached { await forwarder.stop() }
            }
            self.agentFeed = nil // the seam is session-scoped (R4.2)
            self.storeSubscriptionTask?.cancel()
            self.storeSubscriptionTask = nil
            self.engineBridgeTask = nil
            self.store = nil // after closeOut's snapshot; the forwarder holds the feed
            self.speech.sink = nil
            self.capture = nil
            self.engine = nil
            self.captureState = .idle
            self.isStopping = false
        }
    }

    #if DEBUG
    /// CI capture fallback (design §reliability): when launched with
    /// -captureSeedTranscript, paint the fixture's transcript + top hint onto
    /// the live screen so the "live transcript" and "SUGGESTED" checkpoints
    /// render even if host mic injection produced no audio. Display only — the
    /// network path is untouched; inert unless the flag is present. DEBUG-only —
    /// the capture seam is compiled out of Release (su-uzy9.1, f4).
    private func seedCaptureStateIfNeeded() {
        guard CaptureSeam.shouldSeedTranscript else { return }
        seedCaptureState()
    }

    /// Paint the fixture transcript + top hint onto the live screen (design
    /// §reliability). Display only — the network path is untouched. Called by
    /// the explicit `-captureSeedTranscript` flag AND by the injection-mode
    /// watchdog when real transcription produced nothing.
    ///
    /// The seeded rows carry store-minted SegmentIDs so SwiftUI has stable
    /// identities; they are never written to the store, so nothing is
    /// persisted and no timing is implied.
    private func seedCaptureState() {
        let fixture = CaptureURLProtocol.fixture
        var seeded: [TranscriptEntry] = []
        for (i, line) in fixture.seedTranscript.enumerated() where !line.isEmpty {
            seeded.append(TranscriptEntry(
                id: SegmentID(), speaker: .thinker, text: line, tier: nil, turn: i + 1
            ))
        }
        if let reply = fixture.listenerReplies.first, !reply.isEmpty {
            seeded.append(TranscriptEntry(
                id: SegmentID(), speaker: .listener, text: reply, tier: .question,
                turn: fixture.seedTranscript.count
            ))
        }
        transcript = seeded
        hint = fixture.analystCandidates.prefix(2).compactMap { candidate in
            guard let register = Tier(rawValue: candidate.register) else { return nil }
            return Candidate(text: candidate.text, register: register, anchorPosition: 0)
        }
    }
    #endif

    // ── lifecycle: interruptions & scene phase ──

    /// Answer any outstanding evaluation with `silence` and drop the open
    /// turn — when audio returns, the next words start a fresh turn.
    ///
    /// Restored from PR#37, where it was driven by `AudioPipeline.Interruption`.
    /// CaptureController now owns the audio graph and handles the interruption
    /// *event* itself (pause the engine, retry with backoff, report `.paused`
    /// truthfully), but the SESSION's response to it is still the host's:
    /// nothing in CaptureController knows about turns.
    private func parkTurnMachine() {
        detector?.input(.decision(t: nowMs(), outcome: .silence))
        detector?.dropTurn()
        lastEouProb = .nan
        patienceProgress = nil
        machineState = detector?.state ?? .listening
    }

    /// Forwarded from the App's `scenePhase`. Backgrounding releases the
    /// idle-timer hold — background audio makes a lock survivable, so we don't
    /// fight the lock there. There is no checkpoint to write any more: the
    /// PersistenceWriter saves on every finalized segment, so the record on
    /// disk is already at most one volatile segment behind.
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
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

    // ── wiring ──

    private func wireCapture(_ capture: CaptureController) {
        // All CaptureController callbacks arrive on the main queue, so hopping
        // onto the main actor via assumeIsolated is safe and keeps event
        // ordering strict.
        capture.onSpeechStart = { [weak self] wallMs, _ in
            MainActor.assumeIsolated { self?.feed(.speechStart(t: wallMs)) }
        }
        capture.onSpeechEnd = { [weak self] wallMs, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.lastSpeechEndMs = wallMs
                self.feed(.speechEnd(t: wallMs))
                // Synchronous cache read — NO await between the VAD event and
                // its evidence (see header).
                self.feedEouEvidence(at: wallMs)
            }
        }
        capture.onLevel = { [weak self] db in
            MainActor.assumeIsolated { self?.inputLevelDb = db }
        }
        capture.onState = { [weak self] state in
            MainActor.assumeIsolated {
                guard let self else { return }
                let wasPaused = self.captureState == .paused
                self.captureState = state // the UI banner

                // THE SESSION'S RESPONSE TO AN INTERRUPTION (§3.2).
                // CaptureController replaces only two of the five things
                // PR#37's `handleInterruption(.began)` did — pausing the engine
                // and (obsoleted by PersistenceWriter) checkpointing. The
                // other three are the host's and are done here, in order:
                //
                //   1. cut the clip,
                //   2. close the open listener segment at the cut point, so a
                //      segment whose end was an ESTIMATE never claims the
                //      companion said words it was cut off before speaking —
                //      on a long interruption that estimate can land
                //      arbitrarily far from any audio that exists,
                //   3. release the floor, in WALL-clock ms (the audio clock
                //      stops with the engine; the two diverge by exactly the
                //      interruption's length),
                //   4. park the machine, so it is not left holding an open
                //      turn in pending/deciding across a mic gap of arbitrary
                //      length and then resumed against it.
                //
                // Edge-triggered: repeated `.paused` reports must not re-park
                // or re-close. (The VAD half of the reset is CaptureController's
                // own state, and lives there — §3.2a.)
                guard state == .paused, !wasPaused, self.isRunning else { return }
                self.speech.stop()
                self.closeOpenListener(bargedIn: true)
                self.lastFloorReleaseMs = self.nowMs()
                self.parkTurnMachine()
            }
        }
        capture.onError = { [weak self] message in
            MainActor.assumeIsolated { self?.fail(message) }
        }
    }

    private func wireSpeechOutput() {
        speech.onFinished = { [weak self] in
            // Let the machine's response window close on real audio end, and
            // close the listener segment at the ACTUAL end (R4/replay: never
            // present unspoken words as spoken).
            MainActor.assumeIsolated {
                guard let self else { return }
                self.closeOpenListener(bargedIn: false)
                self.feed(.tick(t: self.nowMs()))
            }
        }
    }

    /// The engine-events bridge: the single consumer of engine.events,
    /// translating them into store writes. The engine's contract: at most one
    /// open volatile at a time, and a finalized batch reuses the open
    /// volatile's ID for its first final.
    private func startEngineBridge(engine: SpeechAnalyzerTranscriptionEngine, store: TranscriptStore) {
        engineBridgeTask = Task {
            var openID: SegmentID?
            for await event in engine.events {
                switch event {
                case .volatile(let id, let text, let range):
                    if openID == id {
                        await store.revise(id: id, text: text, range: range)
                    } else {
                        openID = id
                        await store.append(id: id, text: text, range: range)
                    }
                case .finalized(let finals):
                    if let first = finals.first {
                        await store.finalize(id: first.id, into: finals)
                    } else if let id = openID {
                        // Finalized to nothing: drop the open volatile.
                        await store.finalize(id: id, into: [])
                    }
                    openID = nil
                }
            }
        }
    }

    /// The store subscription: refreshes the MainActor caches (published
    /// transcript, utterance text, full text, finalized text, snapshot) on
    /// every store event, and re-fires EOU evidence while a pause is being
    /// timed — new words are EVIDENCE (§6): the machine re-evaluates
    /// evidence-driven, never on a clock.
    private func startStoreSubscription(store: TranscriptStore) {
        storeSubscriptionTask = Task { [weak self] in
            let updates = await store.updates()
            for await _ in updates {
                guard let self, !Task.isCancelled else { return }
                let turn = self.detector?.currentTurn ?? 0
                let segments = await store.snapshot()
                let utterance = await store.utteranceText(turn: turn)
                let full = await store.fullText
                // The analyst's basis, cached from the SAME event so the two
                // projections can never be read a beat apart.
                let finalized = await store.finalizedText
                self.segmentsSnapshot = segments
                self.cachedFullText = full
                self.cachedFinalizedText = finalized
                // A turn-start may have reset the cache while we awaited the
                // actor; never clobber the new turn with the old turn's text.
                if (self.detector?.currentTurn ?? 0) == turn {
                    self.cachedUtteranceText = utterance
                }
                self.refreshTranscriptEntries()
                // No evidence re-fires once the stop path has begun — the
                // drain keeps this subscription alive for the caches, but the
                // machine is already answered and gone.
                guard self.isRunning else { continue }
                let state = self.detector?.state
                if state == .pending || state == .deciding {
                    self.feedEouEvidence(at: self.nowMs())
                }
            }
        }
    }

    private func refreshTranscriptEntries() {
        transcript = segmentsSnapshot.compactMap { segment in
            guard !segment.text.isEmpty else { return nil }
            return TranscriptEntry(
                id: segment.id,
                speaker: segment.speaker == .thinker ? .thinker : .listener,
                text: segment.text,
                tier: segment.tier,
                turn: segment.turn
            )
        }
    }

    /// The thinker's text for one turn, read synchronously off the cached
    /// snapshot — the analyst's trigger needs it on the main actor with no
    /// await, inside the machine's event handling.
    private func thinkerText(forTurn turn: Int) -> String {
        segmentsSnapshot
            .filter { $0.speaker == .thinker && $0.turn == turn && !$0.text.isEmpty }
            .map(\.text)
            .joined(separator: " ")
    }

    /// Chain a host-driven store write onto the serial writer task. Ops run on
    /// the main actor in enqueue order — appendListener always lands before
    /// the closeListener enqueued after it.
    private func enqueueStoreWrite(_ op: @escaping @MainActor (TranscriptStore) async -> Void) {
        guard let store else { return }
        let previous = lastStoreWrite
        lastStoreWrite = Task {
            await previous?.value
            await op(store)
        }
    }

    // ── the decision loop ──

    private func feed(_ event: InputEvent) {
        // Post-stop events (a VAD callback racing teardown, didCancel's tick,
        // a late model reply's decision) must not drive the machine: the stop
        // path already answered the outstanding evaluation, synchronously,
        // feeding the detector directly before dropping it.
        guard isRunning, let detector else { return }
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
        // The analyst stays TICK-driven on purpose. `AnalystCadence` is
        // time-based, and the case it exists to serve is warming the pool
        // during a substantive pause — exactly when no new transcript events
        // are arriving. A purely event-driven analyst would starve there.
        // Content comes from the feed-backed cache; "may I run now?" stays on
        // the clock.
        analyst.tick(nowMs: now, transcript: cachedFinalizedText)
    }

    private func feedEouEvidence(at t: Double) {
        guard knobs.useSmartTurn else { return }
        let prob = LinguisticEOU.completionProbability(for: cachedUtteranceText)
        lastEouProb = prob
        feed(.eou(t: t, verdict: nil, completionProb: prob))
    }

    private func handle(_ event: OutputEvent) {
        switch event {
        case .turnStart(let t, let turn):
            // Utterance identity is segment identity + canonical audio time
            // (R2.4): stamp the boundary via the capture clock's wall→audio
            // mapping; the store derives every segment's turn tag from it.
            // The cache resets synchronously — the new thought starts empty.
            cachedUtteranceText = ""
            if let capture {
                let audioTime = capture.audioTime(atWallMs: t)
                enqueueStoreWrite { await $0.startTurn(turn, atAudioTime: audioTime) }
            }

        case .evaluate(_, let turn, let evaluation, let reason, _):
            evaluate(turn: turn, evaluation: evaluation, reason: reason)

        case .turnEnd(let t, let turn, let evaluation, _):
            // The store's segments already carry the words; all that is left
            // here is the analyst's mark. The evaluation that ended this turn
            // was already marked when it was answered, unless the words only
            // crossed the substantive line while the model deliberated — the
            // de-dupe collapses the two into one mark.
            noteAnalyzablePause(
                turn: turn,
                evaluation: evaluation,
                text: thinkerText(forTurn: turn),
                config: gateConfig(),
                at: t
            )

        case .responseStart:
            if let reply = pendingReply, !reply.text.isEmpty {
                pendingReply = nil
                speech.speak(reply.text)
                appendListenerSegment(text: reply.text, tier: reply.tier)
            }

        case .responseEnd(let t, _, _):
            lastFloorReleaseMs = t

        case .bargeIn(let t, _):
            // The yield is instant: cut the clip at t, not at its natural end —
            // and the listener segment closes at the CUT point, marked barged-in.
            speech.stop()
            lastFloorReleaseMs = t
            closeOpenListener(bargedIn: true)
        }
    }

    /// Append the reply the companion is about to speak as an open listener
    /// segment: start = audioNow at speak, end = a TTS estimate, revised to
    /// the actual on finish/barge-in by closeOpenListener.
    private func appendListenerSegment(text: String, tier: Tier) {
        let start = capture?.audioNow ?? 0
        let estimatedEnd = start + SpeechOutput.estimateDurationMs(for: text) / 1000
        enqueueStoreWrite { [weak self] store in
            guard let self else { return }
            // askNow's out-of-band branch can append while an earlier reply
            // (an ack, say) is still playing — the synthesizer QUEUES the new
            // utterance. Blindly overwriting the open ID would leave the
            // earlier segment open forever and let its didFinish close the
            // WRONG one. Close the open segment first: not barged-in (nothing
            // was cut — the queued clip simply plays after it), at the
            // current position.
            if let open = self.openListenerSegmentID {
                self.openListenerSegmentID = nil
                await store.closeListener(id: open, actualEnd: start, bargedIn: false)
            }
            let id = await store.appendListener(
                text: text, tier: tier, estimatedRange: start ... estimatedEnd
            )
            self.openListenerSegmentID = id
        }
    }

    /// Close the open listener segment at the actual end (natural finish, or
    /// the cut point on barge-in or an interruption). Reads the open ID at
    /// EXECUTION time on the serial writer, so it always sees the append that
    /// preceded it, and is idempotent — a late `onFinished` finds nothing open.
    ///
    /// The cut point is `capture?.audioNow`, which is right even across an
    /// interruption: the fed-samples clock stops with the engine, so `audioNow`
    /// IS the last real audio position.
    private func closeOpenListener(bargedIn: Bool) {
        let end = capture?.audioNow ?? 0
        enqueueStoreWrite { [weak self] store in
            guard let self, let id = self.openListenerSegmentID else { return }
            self.openListenerSegmentID = nil
            await store.closeListener(id: id, actualEnd: end, bargedIn: bargedIn)
        }
    }

    /// The gate's config for this session, with the frozen session voice
    /// applied. One derivation point, so the gate and the analyst's
    /// "substantive" threshold can never disagree.
    private func gateConfig() -> GateConfig {
        var config = GateConfig.derived(from: knobs)
        config.justListen = activeJustListen
        return config
    }

    /// Hand a substantive evaluated pause to the analyst, so the candidate pool
    /// warms on the pause itself rather than on the listener's answer to it.
    ///
    /// The analyst's cadence fires on "new material since the last cycle", and
    /// the only thing that used to mark material was `turnEnd` — which the
    /// machine emits ONLY when the gate answers `speak` (spec §4b). A pause the
    /// gate met with silence (or a silent acknowledge) therefore left the pool
    /// cold precisely where the pre-warmed hint was supposed to be ready: after
    /// a substantive stretch, one pause before the listener finally speaks.
    /// Marking on the EVALUATED pause makes the trigger independent of the
    /// gate's answer; the (turn, evaluation) key keeps one pause worth one mark
    /// across evidence-driven re-evaluations and the replayed `turnEnd`.
    ///
    /// Unaffected by the transcript seam: the key is produced by the turn
    /// machine's gate evaluation, not by the transcript.
    private func noteAnalyzablePause(
        turn: Int,
        evaluation: Int,
        text: String,
        config: GateConfig,
        at t: Double
    ) {
        // Read "substantive" off the SAME derived config the gate uses, so a
        // retuned knob can never leave the two disagreeing.
        guard wordCount(text) >= config.substantiveWords else { return }
        guard analyzedPauses.insert(PauseKey(turn: turn, evaluation: evaluation)).inserted else { return }
        analyst.noteFinishedTurn(atMs: t)
    }

    /// Answer an `evaluate`. Rules tiers answer synchronously; model tiers
    /// leave the machine in `deciding` until the reply lands.
    private func evaluate(turn: Int, evaluation: Int, reason: PatienceReason) {
        let now = nowMs()
        let text = cachedUtteranceText
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
        let config = gateConfig()
        // New material for the analyst regardless of what the gate answers next.
        noteAnalyzablePause(
            turn: turn, evaluation: evaluation, text: text, config: config, at: now
        )
        let decision = decideTier(ctx, config: config)
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
            // Prefer a ready, still-fresh candidate from the pool: what's heard
            // matches the hint already on screen and it lands with no round-trip
            // (spec §2). Already metered when analyzed, so no cost is added here.
            //
            // The drift basis is `cachedFinalizedText` — the SAME string
            // `analyst.tick` was handed, which is what makes the pool's
            // character-offset expiry meaningful. `recompute` stamps its anchor
            // from the string `tick` received, so the two must move together.
            if let candidate = analyst.candidate(
                for: decision.tier, transcriptLength: cachedFinalizedText.count
            ), takeFloor(with: candidate.text, tier: decision.tier) {
                // Spoke straight from the pool — already metered at analyze time.
                // Consume it only now that the floor was actually taken: a line
                // that has been said must not be said again at the next pause in
                // this cadence window, nor keep sitting on screen as a hint.
                analyst.consume(candidate)
            } else {
                // Nothing fresh fits, or the floor couldn't be taken — fall back
                // to a single live call (today's behavior, the safety net). A
                // turn is never silently dropped.
                requestModelReply(tier: decision.tier, turn: turn, utterance: text)
            }
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
        // The conversation this call belongs to. Everything below is dropped if
        // the session has since stopped or restarted (see `isCurrent`).
        let generation = sessionGeneration
        Task { [weak self] in
            defer {
                Task { @MainActor [weak self] in
                    guard let self, self.isCurrent(generation) else { return }
                    self.isThinking = false
                }
            }
            do {
                let reply = try await client.respondWithUsage(to: request)
                await MainActor.run { [weak self] in
                    guard let self, self.isCurrent(generation) else { return }
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
                    guard let self, self.isCurrent(generation) else { return }
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
    /// Returns whether the floor was actually taken. `false` ⇒ the machine had
    /// already left `deciding` (the thinker resumed), so the reply is stale and
    /// discarded — the caller may fall back to a live call.
    @discardableResult
    private func takeFloor(with text: String, tier: Tier) -> Bool {
        guard let detector, detector.state == .deciding else { return false }
        pendingReply = (text, tier)
        detector.setKnobs { $0.responseDurationMs = SpeechOutput.estimateDurationMs(for: text) }
        feed(.decision(t: nowMs(), outcome: .speak))
        pendingReply = nil // consumed by response-start, or stale
        return true
    }

    /// "Pull a thread now" — the upon-prompting path. Bypasses the gate's
    /// earned-question spacing (the user explicitly invited the question) but
    /// still runs through the machine when it is parked in `deciding`, so the
    /// turn accounting stays truthful.
    func askNow() {
        guard isRunning else { return }
        let turn = detector?.currentTurn ?? 0
        // Deliberately the LIVE text, volatile included — the user is asking
        // about what they just said, and this is not drift-anchored to
        // anything. Only the two analyst call sites use the finalized basis.
        let text = cachedUtteranceText.isEmpty ? cachedFullText : cachedUtteranceText
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            fail("Nothing has been said yet.")
            return
        }
        // The gate's history is only written once a question can actually be
        // asked — recording it before the service guard would charge the
        // earned-question spacing for a question that never happened.
        guard let client = makeService() else { return }
        decisionsByTurn[turn] = .question
        let request = buildPullThreadRequest(
            systemPrompt: ListenerPrompt.systemPrompt(mode: activeMode, justListen: activeJustListen),
            currentTurnText: text,
            history: conversationHistory(before: turn)
        )
        isThinking = true
        // Same guard as `requestModelReply`: an out-of-band pull-a-thread reply
        // that lands after stop/start would otherwise speak into — and append to
        // the transcript of — a session that never asked for it.
        let generation = sessionGeneration
        Task { [weak self] in
            defer {
                Task { @MainActor [weak self] in
                    guard let self, self.isCurrent(generation) else { return }
                    self.isThinking = false
                }
            }
            do {
                let reply = try await client.respondWithUsage(to: request)
                await MainActor.run { [weak self] in
                    guard let self, self.isCurrent(generation) else { return }
                    self.sessionCost.add(reply.usage)
                    guard !reply.text.isEmpty else { return }
                    if self.detector?.state == .deciding {
                        self.takeFloor(with: reply.text, tier: .question)
                    } else {
                        // Out-of-band: the user asked while the machine was not
                        // parked on an evaluation. Speak directly; the turn
                        // continues (with AEC the mic will not hear our TTS).
                        self.speech.speak(reply.text)
                        self.appendListenerSegment(text: reply.text, tier: .question)
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self, self.isCurrent(generation) else { return }
                    self.report(error)
                }
            }
        }
    }

    // ── coverage mode ──

    /// Coverage is the agent seam's FIRST consumer (plan Phase 5): its
    /// transcript comes from the feed's snapshot — the same public API any
    /// other feature attaches through — not from a controller-internal cache.
    /// Volatile text included, deliberately: coverage asks "what has this
    /// recording covered", which includes the sentence still being spoken.
    func checkCoverage() {
        guard !coverageCriteria.isEmpty else {
            fail("Add checklist topics in Settings first.")
            return
        }
        guard let feed = agentFeed else {
            // The seam is session-scoped; the coverage button is only enabled
            // while a session runs, so this is a belt-and-braces guard.
            fail("Start a session first.")
            return
        }
        guard let client = makeService() else { return }
        coverageChecking = true
        // Coverage is offered only while a session runs, and its result is
        // persisted into that session's record — so a late answer must not land
        // on the next one.
        let generation = sessionGeneration
        Task { [weak self] in
            // Everything the thinker has said so far, finalized + volatile —
            // the same "recording so far" the old cache held.
            let text = await feed.currentSnapshot()
                .filter { $0.speaker == .thinker && !$0.text.isEmpty }
                .map(\.text)
                .joined(separator: " ")
            do {
                let result = try await client.checkCoverage(
                    transcript: text,
                    criteria: self?.coverageCriteria ?? []
                )
                await MainActor.run { [weak self] in
                    guard let self, self.isCurrent(generation) else { return }
                    self.coverageResult = result
                    self.coverageChecking = false
                    self.coverageCheckCount += 1 // presents the sheet, even on an identical result
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self, self.isCurrent(generation) else { return }
                    self.report(error)
                    self.coverageChecking = false
                }
            }
        }
    }

    // ── close-out (stop path; the record grew incrementally via PersistenceWriter) ──

    /// Close the session record: compute the duration, remux the crash-safe
    /// CAF into the .m4a the library plays, and hand the PersistenceWriter its
    /// close-out — which reconciles against the post-drain store snapshot,
    /// applies the zero-speech rule (no finalized thinker segment → record +
    /// audio deleted), and stamps the record `complete`. Runs AFTER the engine
    /// drain, so the snapshot holds every finalized segment.
    private func closeOutSession() async {
        let started = sessionStartDate ?? Date()
        sessionStartDate = nil
        let cafName = recordingFileName
        recordingFileName = nil
        let duration = Date().timeIntervalSince(started)

        // Graceful stop: remux the crash-safe CAF into the .m4a the library
        // plays (off the main actor — it is a decode/encode loop). The record
        // keeps referencing the CAF until closeOut swaps the name, so a crash
        // DURING the remux still recovers via the CAF at next launch.
        var audioFileName: String?
        var remuxed = false
        if let cafName {
            let m4aName = RecordingStorage.m4aFileName(stem: RecordingStorage.stem(of: cafName))
            let source = RecordingStorage.url(for: cafName)
            let destination = RecordingStorage.url(for: m4aName)
            remuxed = await Task.detached {
                do {
                    try CaptureController.remux(caf: source, to: destination)
                    return true
                } catch {
                    return false
                }
            }.value
            // A failed remux keeps the CAF as the record's audio — AVAudioPlayer
            // plays AAC-in-CAF just fine, and SessionDetailView keys off
            // audioFileName alone. Losing the .m4a nicety must never cost the
            // session audio itself.
            audioFileName = remuxed ? m4aName : cafName
        }

        guard let writer, let store else {
            // No persistence was configured (previews, or record creation
            // failed): nothing to close; drop the orphan audio.
            if let cafName {
                RecordingStorage.deleteBoth(stem: RecordingStorage.stem(of: cafName))
            }
            writerTask?.cancel()
            writerTask = nil
            self.writer = nil
            currentRecordID = nil
            return
        }

        // Ground truth for close-out: the post-drain log. The writer's pull
        // loop may still be catching up on queued events — closeOut reconciles
        // this snapshot against what it already wrote, so nothing rides on the
        // race.
        let finals = await store.snapshot()
        let kept = await writer.closeOut(
            duration: duration,
            audioFileName: audioFileName,
            coverage: coverageResult,
            criteria: coverageCriteriaText,
            // Only store a figure when every call was metered; the usage-less
            // proxy path leaves it nil (cost unknown, not zero).
            costUSD: sessionCost.isExact ? sessionCost.dollars() : nil,
            finalSegments: finals
        )
        if let cafName, remuxed, kept {
            // The .m4a is the record's audio now; the CAF has served its
            // crash-safety purpose. When the remux failed the CAF IS the
            // record's audio and stays.
            RecordingStorage.delete(fileName: cafName)
        }
        lastSavedRecordID = kept ? currentRecordID : nil
        currentRecordID = nil
        writerTask?.cancel()
        writerTask = nil
        self.writer = nil
    }

    // ── helpers ──

    /// Is `generation` still the running session's? The guard every late model
    /// reply passes before it may touch session state — add cost, answer the
    /// machine, speak, or append to the transcript. Both halves matter: the
    /// token catches a reply that outlived its session, and `isRunning` keeps a
    /// reply from speaking into the gap after a stop.
    private func isCurrent(_ generation: Int) -> Bool {
        isRunning && generation == sessionGeneration
    }

    /// Resolve the listener backend for this call: the account proxy when
    /// signed in, the developer-mode key otherwise. Nil (with a friendly
    /// lastError) when neither is configured.
    private func makeService() -> (any ListenerService)? {
        guard let service = resolveService() else {
            // Typed as `.accountRequired` so the UI can offer sign-in instead of
            // showing a raw error — the user most likely just skipped onboarding.
            fail(
                "Sign in — or add a developer API key in Settings — so the "
                    + "listener's rare question can reach the model.",
                kind: .accountRequired
            )
            return nil
        }
        return service
    }

    /// Resolve the listener backend WITHOUT any side effect — nil simply means
    /// "no account and no dev key configured". The ambient analyst probes this
    /// on every cadence tick and must stay silent when signed out (a cold pool
    /// is a valid state); only the reactive gate, when it actually needs to
    /// speak, raises the `.accountRequired` sign-in banner (via `makeService`).
    private func resolveService() -> (any ListenerService)? {
        #if DEBUG
        // Under CI capture the listener must reach the CaptureURLProtocol stub
        // deterministically — bypass the keychain + account store (an unsigned
        // capture build's keychain write can silently fail, which otherwise
        // leaves askNow/the gate with no service and raises a spurious
        // account-required alert). Inert outside the capture flag, and compiled
        // out of Release entirely so no auth bypass ships (su-uzy9.1, f4).
        if CaptureSeam.isActive {
            return ClaudeClient(config: ClaudeConfig(apiKey: CaptureSeam.fakeAPIKey))
        }
        #endif
        if let service = accountStore?.makeListenerService(devAPIKey: KeychainStore.apiKey) {
            return service
        }
        // No account store injected (e.g. previews): the dev key alone.
        if accountStore == nil,
           let key = KeychainStore.apiKey,
           !key.trimmingCharacters(in: .whitespaces).isEmpty {
            return ClaudeClient(config: ClaudeConfig(apiKey: key))
        }
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

    /// Prior turns for the listener prompt, from the cached store snapshot.
    /// Consecutive segments by the same speaker in the same turn are joined,
    /// preserving the one-entry-per-voice-per-turn shape the prompt was tuned
    /// on.
    private func conversationHistory(before turn: Int) -> [ConversationTurn] {
        var grouped: [(speaker: TranscriptCore.Speaker, turn: Int, text: String)] = []
        for segment in segmentsSnapshot where segment.turn < turn && !segment.text.isEmpty {
            if var last = grouped.last, last.speaker == segment.speaker, last.turn == segment.turn {
                last.text += " " + segment.text
                grouped[grouped.count - 1] = last
            } else {
                grouped.append((segment.speaker, segment.turn, segment.text))
            }
        }
        return grouped.map {
            ConversationTurn(
                speaker: $0.speaker == .thinker ? .thinker : .listener,
                text: $0.text
            )
        }
    }
}
