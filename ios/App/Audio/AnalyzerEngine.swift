// Speech-to-text: the iOS 26 SpeechAnalyzer engine behind the
// TranscriptionEngine seam (docs/plans/
// 2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, "TranscriptionEngine
// protocol + AnalyzerEngine" section + R2). Replaces the SFSpeechRecognizer
// adapter — no duty-cycle restarts, no dropped-buffer seams: ONE analyzer
// session spans the whole recording session (R2.2), volatile results stream
// and visibly refine (R2.1), and audio time ranges ride along for seek/replay
// (R2.3).
//
// The protocol is the plan's seam verbatim: the ENGINE owns segment identity.
// A stable SegmentID is issued when a volatile segment opens and held across
// every in-place revision; finalization closes it into FinalizedText(s) —
// reusing the volatile's ID for the first final, which is what keeps identity
// stable volatile → final in the store — and the next volatile mints a fresh
// ID. Any second arm (the deferred WhisperKit Phase W) must honor the same
// contract, which is what keeps the store honest.
//
// API-DRIFT RULE (plan Risks): this file is written against the iOS 26 Speech
// framework as documented; exact symbol shapes must be reconciled against the
// real SDK at the first Xcode build. Every uncertain call site carries an
// `// SDK-CHECK:` comment. Mismatches are mechanical fixes INSIDE this file —
// the TranscriptionEngine protocol insulates everything else.
//
// Threading: `prepare`/`start`/`stopAndFinalize` are called by the MainActor
// host; result processing (and the only mutation of `openVolatileID` /
// `lastKnownEnd`) is confined to the single results-drain task. The events
// stream has exactly one consumer: the host's engine-events bridge.

import AVFoundation
import Foundation
import Speech
import TranscriptCore

/// Canonical-format PCM buffers, produced by CaptureController's converter.
typealias AnalyzerBuffer = AVAudioPCMBuffer

/// What a transcription engine emits: volatile revisions of the one open
/// segment, and finalized batches that close it. IDs are engine-issued and
/// stable across revisions (plan Key Decisions: segment identity is the
/// engine's job, not the store's).
enum EngineEvent: Sendable {
    case volatile(SegmentID, text: String, range: ClosedRange<TimeInterval>)
    case finalized([FinalizedText])
}

/// The seam between capture/host and any transcription arm (plan's protocol,
/// verbatim). `events` is single-consumer — the host's bridge task.
protocol TranscriptionEngine {
    func start(buffers: AsyncStream<AnalyzerBuffer>) async throws
    func stopAndFinalize() async // drains; returns only when all results landed
    var events: AsyncStream<EngineEvent> { get }
}

final class SpeechAnalyzerTranscriptionEngine: TranscriptionEngine {
    enum EngineError: LocalizedError {
        case noCompatibleFormat
        case notPrepared

        var errorDescription: String? {
            switch self {
            case .noCompatibleFormat:
                return "No compatible audio format is available for on-device transcription."
            case .notPrepared:
                return "The transcription engine was started before it was prepared."
            }
        }
    }

    let events: AsyncStream<EngineEvent>
    private let eventContinuation: AsyncStream<EngineEvent>.Continuation
    /// Non-fatal engine failures, delivered on the main actor. Marking the
    /// callback `@MainActor` makes the closure value Sendable, so the failure
    /// paths below can hand it (plus the message) across the main-actor hop
    /// without capturing non-Sendable `self` in a `@Sendable` closure.
    var onError: (@MainActor (String) -> Void)?

    private let locale: Locale
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var feedTask: Task<Void, Never>?
    private var resultsTask: Task<Void, Never>?

    // ── results-task-confined state ──
    /// The one open volatile segment (the analyzer's real contract: at most
    /// one, updated in place by successive volatile results).
    private var openVolatileID: SegmentID?
    /// Fallback timeline position when a result carries no usable timing.
    private var lastKnownEnd: TimeInterval = 0

    init(locale: Locale = .current) {
        self.locale = locale
        (events, eventContinuation) = AsyncStream.makeStream(of: EngineEvent.self)
    }

    /// Create the pinned-configuration transcriber + analyzer, resolve the
    /// canonical audio format, and preheat so first words don't lag (plan:
    /// preheat during session start, after asset verification). The returned
    /// format is THE canonical format for the whole session — the host hands
    /// it to CaptureController, whose converter feeds analyzer, recording,
    /// and VAD from the same stream.
    func prepare() async throws -> AVAudioFormat {
        // Configuration pinned per the plan: volatile results on, audio time
        // ranges attached. No contextual-strings equivalent exists in the
        // iOS 26 API — no custom-vocabulary biasing is assumed.
        // DEVIATION (documented per the plan's API-drift rule): the plan's
        // sketch tracked the moving volatile/finalized boundary via
        // `volatileRangeChangedHandler`. No handler is installed here — the
        // results stream already carries the same boundary (each result's
        // `isFinal` closes the open volatile in `handle(_:)`), so a separate
        // callback would be a second, redundant source of one fact.
        // SDK-CHECK: SpeechTranscriber module initializer — parameter names/
        // order (locale:transcriptionOptions:reportingOptions:attributeOptions:)
        // and whether a preset initializer should seed these options instead.
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        // SDK-CHECK: static SpeechAnalyzer.bestAvailableAudioFormat(
        // compatibleWith:) — returns AVAudioFormat? for the module set.
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber]
        ) else {
            throw EngineError.noCompatibleFormat
        }
        // SDK-CHECK: prepareToAnalyze(in:) — the preheat call; may also take
        // a reporting/progress parameter.
        try await analyzer.prepareToAnalyze(in: format)
        self.transcriber = transcriber
        self.analyzer = analyzer
        return format
    }

    func start(buffers: AsyncStream<AnalyzerBuffer>) async throws {
        guard let analyzer, let transcriber else { throw EngineError.notPrepared }

        // Drain first, so no result can be dropped between start and the loop.
        resultsTask = Task { [weak self] in
            await self?.drainResults(from: transcriber)
        }

        let (inputSequence, inputBuilder) = AsyncStream.makeStream(of: AnalyzerInput.self)
        inputContinuation = inputBuilder
        do {
            // SDK-CHECK: analyzer.start(inputSequence:) — begins autonomous
            // analysis of the sequence and returns once started (it must not
            // block until end-of-input; if the real SDK's method does, this call
            // moves into its own Task).
            try await analyzer.start(inputSequence: inputSequence)
        } catch {
            // Unwind the drain task started above — a failed start must not
            // leak a task parked on `transcriber.results` forever.
            resultsTask?.cancel()
            resultsTask = nil
            inputBuilder.finish()
            inputContinuation = nil
            eventContinuation.finish()
            throw error
        }

        feedTask = Task {
            for await buffer in buffers {
                // SDK-CHECK: AnalyzerInput(buffer:) — there is also a
                // bufferStartTime variant; the default continues the fed-audio
                // timeline, which is what the canonical clock requires.
                inputBuilder.yield(AnalyzerInput(buffer: buffer))
            }
            inputBuilder.finish()
        }
    }

    /// The plan's graceful-stop sequence, in order: (1) finish the input
    /// stream's continuation; (2) finalizeAndFinishThroughEndOfInput; (3)
    /// drain `transcriber.results` to completion so trailing finals land;
    /// (4) only then return — the host closes the record after this. A
    /// graceful stop therefore loses nothing.
    func stopAndFinalize() async {
        // The host has already ended the capture buffer stream
        // (CaptureController.finishBuffers), so the feed task drains every
        // QUEUED buffer and finishes the input stream itself — cancelling it
        // here would drop the tail of the session's audio on the floor. A
        // timeout guard (2 s, then cancel) keeps a wedged stream from being
        // able to hang stop.
        if let feedTask {
            let watchdog = Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                feedTask.cancel()
            }
            await feedTask.value
            watchdog.cancel()
        }
        feedTask = nil
        inputContinuation?.finish() // (1) — idempotent backstop for the timeout path
        inputContinuation = nil
        do {
            // SDK-CHECK: finalizeAndFinishThroughEndOfInput() — finalizes all
            // pending volatile results and ends the analysis session.
            try await analyzer?.finalizeAndFinishThroughEndOfInput() // (2)
        } catch {
            // The finalize failed, so `transcriber.results` may never end —
            // cancel the drain (and end the events stream) BEFORE awaiting it,
            // or this await could hang forever and brick every future session
            // (the host's isStopping latch would never clear).
            resultsTask?.cancel()
            eventContinuation.finish()
            let message = error.localizedDescription
            let onError = self.onError
            await MainActor.run { onError?("Finishing transcription failed: \(message)") }
        }
        await resultsTask?.value // (3) — ends when transcriber.results ends
        resultsTask = nil
        analyzer = nil
        transcriber = nil
    }

    // ── results processing (single task) ──

    private func drainResults(from transcriber: SpeechTranscriber) async {
        do {
            // SDK-CHECK: transcriber.results — an async throwing sequence of
            // SpeechTranscriber.Result; ends after
            // finalizeAndFinishThroughEndOfInput completes.
            for try await result in transcriber.results {
                handle(result)
            }
        } catch {
            // A cancelled drain (the finalize-failure path already surfaced
            // its own error) should not stack a spurious second message.
            if !Task.isCancelled {
                let message = error.localizedDescription
                let onError = self.onError
                await MainActor.run { onError?("Transcription failed: \(message)") }
            }
        }
        eventContinuation.finish()
    }

    // SDK-CHECK: SpeechTranscriber.Result member names — `text`
    // (AttributedString) and `isFinal` per the documented surface; the
    // result-level CMTimeRange (`range`) is read in audioRange(of:runs:).
    private func handle(_ result: SpeechTranscriber.Result) {
        let attributed = result.text
        let text = String(attributed.characters)
        let runs = timedRuns(in: attributed)
        let range = audioRange(of: result, runs: runs)
        lastKnownEnd = max(lastKnownEnd, range.upperBound)

        guard !text.isEmpty else {
            if result.isFinal, openVolatileID != nil {
                // The open volatile finalized to nothing — tell the bridge to
                // drop it (an empty finalized batch closes the open segment).
                openVolatileID = nil
                eventContinuation.yield(.finalized([]))
            }
            return
        }

        if result.isFinal {
            let id = openVolatileID ?? SegmentID()
            if openVolatileID == nil {
                // A final with no preceding volatile (very short audio, or
                // volatile reporting raced finalization): open the segment
                // first so the store has an identity to close.
                eventContinuation.yield(.volatile(id, text: text, range: range))
            }
            openVolatileID = nil
            eventContinuation.yield(
                .finalized(sentenceFinals(text: text, runs: runs, range: range, reusing: id))
            )
        } else {
            let id: SegmentID
            if let open = openVolatileID {
                id = open // successive volatile results REPLACE the open segment
            } else {
                id = SegmentID() // a fresh volatile opens after each finalization
                openVolatileID = id
            }
            eventContinuation.yield(.volatile(id, text: text, range: range))
        }
    }

    /// Extract TimedRuns from the attributed text's audioTimeRange runs.
    /// Offsets are UTF-16 code units (via NSRange bridging) — the unit
    /// TranscriptCore's split/carve logic expects.
    private func timedRuns(in attributed: AttributedString) -> [TimedRun] {
        var runs: [TimedRun] = []
        // SDK-CHECK: the `audioTimeRange` attribute key path
        // (AttributeScopes.SpeechAttributes) — value is a CMTimeRange on the
        // fed-audio timeline, which IS the canonical timeline (the same
        // converter output is written to the recording file).
        for (timeRange, runRange) in attributed.runs[\.audioTimeRange] {
            guard let timeRange else { continue }
            let ns = NSRange(runRange, in: attributed)
            guard ns.location != NSNotFound, ns.length > 0 else { continue }
            let start = timeRange.start.seconds
            let end = timeRange.end.seconds
            guard start.isFinite, end.isFinite else { continue }
            runs.append(TimedRun(
                charOffset: ns.location,
                charLength: ns.length,
                audioStart: min(start, end),
                audioEnd: max(start, end)
            ))
        }
        return runs
    }

    /// The result's span on the canonical timeline: derived from its runs
    /// when present (the trusted source), else the result-level CMTimeRange,
    /// else pinned at the last known position (zero-width — better than
    /// inventing a span).
    private func audioRange(
        of result: SpeechTranscriber.Result, runs: [TimedRun]
    ) -> ClosedRange<TimeInterval> {
        if let first = runs.first, let last = runs.last, first.audioStart <= last.audioEnd {
            return first.audioStart ... last.audioEnd
        }
        // SDK-CHECK: result.range — the result-level CMTimeRange.
        let start = result.range.start.seconds
        let end = result.range.end.seconds
        if start.isFinite, end.isFinite, start <= end {
            return start ... end
        }
        return lastKnownEnd ... lastKnownEnd
    }

    // ── sentence-level finalization split ──

    /// Split one finalized text into sentence-level FinalizedTexts by its
    /// audioTimeRange runs (plan: volatile identity closes "into sentence-
    /// level final segments"). The FIRST final reuses the closed volatile's
    /// ID — the store expects that identity to stay stable. Without usable
    /// runs (or with a single sentence) the text stays whole — best-effort by
    /// design, same posture as the store's boundary splits.
    private func sentenceFinals(
        text: String, runs: [TimedRun], range: ClosedRange<TimeInterval>, reusing id: SegmentID
    ) -> [FinalizedText] {
        let sentences = sentenceSlices(of: text)
        guard sentences.count > 1, !runs.isEmpty else {
            return [FinalizedText(id: id, text: text, range: range, runs: runs)]
        }
        var finals: [FinalizedText] = []
        for (position, sentence) in sentences.enumerated() {
            // Runs whose start falls inside this sentence, rebased to it.
            let sentenceRuns = runs
                .filter {
                    $0.charOffset >= sentence.utf16Offset
                        && $0.charOffset < sentence.utf16Offset + sentence.utf16Length
                }
                .map {
                    TimedRun(
                        charOffset: $0.charOffset - sentence.utf16Offset,
                        charLength: $0.charLength,
                        audioStart: $0.audioStart,
                        audioEnd: $0.audioEnd
                    )
                }
            let fallbackStart = finals.last?.range.upperBound ?? range.lowerBound
            let start = sentenceRuns.first?.audioStart ?? fallbackStart
            let end = sentenceRuns.last?.audioEnd ?? start
            finals.append(FinalizedText(
                id: position == 0 ? id : SegmentID(),
                text: sentence.text,
                range: min(start, end) ... max(start, end),
                runs: sentenceRuns
            ))
        }
        return finals
    }

    private struct SentenceSlice {
        let text: String
        let utf16Offset: Int
        let utf16Length: Int
    }

    /// Sentence boundaries: a terminal punctuation mark followed by whitespace
    /// (or end of text). Offsets/lengths in UTF-16 code units to match the
    /// run offsets.
    private func sentenceSlices(of text: String) -> [SentenceSlice] {
        var slices: [SentenceSlice] = []
        var utf16Cursor = 0

        func append(_ slice: Substring) {
            let trimmedLeading = slice.drop(while: { $0.isWhitespace })
            let leadingSkipped = slice.utf16.count - trimmedLeading.utf16.count
            let trimmed = String(trimmedLeading).trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty {
                slices.append(SentenceSlice(
                    text: trimmed,
                    utf16Offset: utf16Cursor + leadingSkipped,
                    utf16Length: trimmed.utf16.count
                ))
            }
            utf16Cursor += slice.utf16.count
        }

        var sentenceStart = text.startIndex
        var i = text.startIndex
        while i < text.endIndex {
            let next = text.index(after: i)
            if ".!?".contains(text[i]), next == text.endIndex || text[next].isWhitespace {
                append(text[sentenceStart..<next])
                sentenceStart = next
                i = next
            } else {
                i = next
            }
        }
        if sentenceStart < text.endIndex {
            append(text[sentenceStart...])
        }
        return slices
    }
}
