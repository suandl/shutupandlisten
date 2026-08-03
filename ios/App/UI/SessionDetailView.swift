// A saved session, opened to what mattered: the one question the listener
// earned (when there was one), the audio, and a quiet transcript. Lines that
// carry timing seek the recording when tapped; the current line highlights
// softly while the audio plays.
//
// TRUE REPLAY (plan R3.3). The data source is `record.transcriptSegments` —
// segment rows when the record has them, the legacy blob decoded lazily when
// it does not — and the timeline is the canonical FED-SAMPLES audio clock
// (`audioStart`/`audioEnd`, seconds), not the wall-clock ms the pre-port
// records stored. Both paths agree by construction: the migration's row
// materializer and TranscriptCore's lazy fallback map the legacy blob's
// startMs/endMs identically, so a record cannot gain or lose replay depending
// on which one reached it. Records whose blob carried NO timings (base-era)
// rehydrate with zeroed ranges, `hasTimings` is false, and the view degrades
// to exactly the old static presentation: no seek, no highlight, no broken
// affordance.

import AVFoundation
import SwiftUI
import TranscriptCore
import TurnEngine

struct SessionDetailView: View {
    let record: SessionRecord
    @AppStorage("showCostReadout") private var showCostReadout = false
    @StateObject private var playback = AudioPlayback()

    private var audioURL: URL? {
        guard let name = record.audioFileName else { return nil }
        let url = RecordingStorage.url(for: name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    var body: some View {
        let segments = record.transcriptSegments
        let hasTranscript = segments.contains { !$0.text.isEmpty }
        // Read once, off the segments this body is about to render, rather than
        // per rendered line: `record.hasTimings` decodes the legacy blob on the
        // fallback path, and asking it per line would decode once per line.
        let hasTimings = TranscriptCore.hasTimings(segments)
        let currentIndex = activeIndex(in: segments, hasTimings: hasTimings)

        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                header
                if showCostReadout, let cost = record.costUSD {
                    Text(String(format: "model cost: $%.4f", cost))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                headline(hasTranscript: hasTranscript)

                if audioURL != nil {
                    if playback.loadFailed {
                        audioUnavailableNote
                    } else {
                        playerControls
                    }
                }

                if hasTranscript {
                    transcript(
                        segments: segments,
                        currentIndex: currentIndex,
                        hasTimings: hasTimings
                    )
                } else if audioURL != nil {
                    audioOnlyNote
                } else {
                    Text("Nothing was captured in this session.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let coverage = record.coverage {
                    coverageSection(coverage)
                }
            }
            .padding()
        }
        .navigationTitle(record.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { shareMenu }
        .onAppear {
            if let audioURL { playback.load(url: audioURL) }
        }
        .onDisappear { playback.stop() }
    }

    // ── header ──

    private var header: some View {
        HStack(spacing: 6) {
            Text(record.startedAt.formatted(date: .abbreviated, time: .shortened))
            Text("·")
            Text(Clock.text(record.duration))
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    // ── headline: the open question, or the calm stat ──

    @ViewBuilder
    private func headline(hasTranscript: Bool) -> some View {
        if let question = record.openQuestion {
            openQuestionCard(question)
        } else if hasTranscript {
            // No question was earned — silence is the product. Say so calmly.
            Text(calmStat)
                .font(.system(.title3, design: .serif))
                .padding(.vertical, 2)
        }
    }

    private func openQuestionCard(_ question: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("The question you left with")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(question)
                .font(.system(.title2, design: .serif))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Image(
                    systemName: record.openQuestionAnsweredByThinker
                        ? "checkmark.circle" : "circle.dotted"
                )
                .foregroundStyle(Color.sulAccent.opacity(0.8))
                Text(
                    record.openQuestionAnsweredByThinker
                        ? "You picked it up before stopping."
                        : "Still open — a place to start next time."
                )
                .foregroundStyle(.secondary)
            }
            .font(.caption)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(Color.sulAccent.opacity(0.18))
        )
        .accessibilityElement(children: .combine)
    }

    private var calmStat: String {
        let minutes = Int((record.duration / 60).rounded())
        switch minutes {
        case ..<1: return "Under a minute, uninterrupted."
        case 1: return "One minute, uninterrupted."
        default: return "\(minutes) minutes, uninterrupted."
        }
    }

    // ── audio player ──

    private var playerControls: some View {
        HStack(spacing: 12) {
            Button {
                playback.togglePlayback()
            } label: {
                Image(systemName: playback.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 34))
            }
            .accessibilityLabel(playback.isPlaying ? "Pause" : "Play")

            Slider(
                value: Binding(
                    get: { playback.currentTime },
                    set: { playback.seek(to: $0) }
                ),
                in: 0...max(playback.duration, 0.01)
            )
            .accessibilityLabel("Playback position")

            Text(Clock.text(playback.currentTime))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private var audioUnavailableNote: some View {
        Text(
            """
            This recording couldn't be opened — the session may have ended \
            before the audio finished saving.
            """
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    /// Shown for recovered sessions: audio exists, transcript doesn't.
    private var audioOnlyNote: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Audio only")
                .font(.footnote.weight(.medium))
            Text("This session was recovered from its recording, so there's no transcript.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    // ── transcript ──

    @ViewBuilder
    private func transcript(
        segments: [TranscriptSegment],
        currentIndex: Int?,
        hasTimings: Bool
    ) -> some View {
        ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
            if !segment.text.isEmpty {
                EntryRow(
                    segment: segment,
                    isCurrent: index == currentIndex,
                    onSeek: seekAction(for: segment, hasTimings: hasTimings)
                )
            }
        }
    }

    /// Tap-to-seek, only when the record carries real timings and the audio
    /// opened. Records without them stay inert — no broken affordances.
    ///
    /// `hasTimings` is passed in rather than read off the record per line: the
    /// caller computed it from the very segments being rendered, which is both
    /// cheaper and exactly the right question — the affordance must match the
    /// transcript on screen, whichever source it came from.
    ///
    /// Listener lines are excluded deliberately: their audio span is silence in
    /// the recording (the AEC removes the companion's voice from the mic), so
    /// seeking into one would read as broken playback.
    private func seekAction(
        for segment: TranscriptSegment,
        hasTimings: Bool
    ) -> (() -> Void)? {
        guard hasTimings, segment.speaker == .thinker,
              audioURL != nil, !playback.loadFailed
        else { return nil }
        let start = segment.audioStart
        return { playback.play(from: start) }
    }

    /// The line currently sounding: the last one whose start the playhead has
    /// passed. `transcriptSegments` is in chronological order, so scan in
    /// order. Listener lines never highlight, for the same reason they never
    /// seek.
    private func activeIndex(in segments: [TranscriptSegment], hasTimings: Bool) -> Int? {
        guard playback.isPlaying, hasTimings else { return nil }
        let now = playback.currentTime
        var current: Int?
        for (index, segment) in segments.enumerated() {
            guard segment.speaker == .thinker else { continue }
            if segment.audioStart <= now { current = index } else { break }
        }
        return current
    }

    // ── coverage snapshot ──

    private func coverageSection(_ coverage: CoverageResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What you meant to cover")
                .font(.headline)
            if !coverage.nudge.isEmpty {
                Label(coverage.nudge, systemImage: "arrow.turn.down.right")
                    .font(.footnote.weight(.medium))
            }
            ForEach(coverage.topics, id: \.topic) { topic in
                VStack(alignment: .leading, spacing: 2) {
                    Label(
                        topic.topic,
                        systemImage: topic.covered ? "checkmark.circle.fill" : "circle"
                    )
                    .font(.footnote)
                    .foregroundStyle(topic.covered ? .primary : .secondary)
                    if topic.covered && !topic.evidence.isEmpty {
                        Text("“\(topic.evidence)”")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 24)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .padding(.top, 8)
    }

    // ── share ──

    private var shareMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                ShareLink(item: record.markdown) {
                    Label("Share as Markdown", systemImage: "doc.text")
                }
                if let audioURL {
                    ShareLink(item: audioURL) {
                        Label("Share audio", systemImage: "waveform")
                    }
                }
            } label: {
                Image(systemName: "square.and.arrow.up")
            }
            .accessibilityLabel("Share")
        }
    }
}

/// mm:ss, shared by the header, the player readout, and transcript stamps.
private enum Clock {
    static func text(_ duration: TimeInterval) -> String {
        let total = Int(duration.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    static func text(ms: Int) -> String {
        String(format: "%02d:%02d", ms / 60_000, (ms / 1000) % 60)
    }
}

// ── one transcript line, quiet ──
//
// Thinker text is primary and unadorned; listener turns carry the accent and a
// small tag — no tier jargon. Timestamps sit faint on the leading edge.

private struct EntryRow: View {
    let segment: TranscriptSegment
    let isCurrent: Bool
    let onSeek: (() -> Void)?

    var body: some View {
        if let onSeek {
            Button(action: onSeek) { rowContent }
                .buttonStyle(.plain)
                .accessibilityHint("Plays this moment")
        } else {
            rowContent
        }
    }

    private var rowContent: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // A zero range is this schema's encoding of "no timing recorded",
            // so the stamp is shown only when there is a real one to show.
            if segment.audioStart != 0 || segment.audioEnd != 0 {
                Text("[\(Clock.text(ms: Int((segment.audioStart * 1000).rounded())))]")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            if segment.speaker == .thinker {
                Text(segment.text)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    Text("listener")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Color.sulAccent.opacity(0.8))
                    Text(segment.text)
                        .font(
                            segment.tier == .question
                                ? .system(.body, design: .serif).italic()
                                : .callout.italic()
                        )
                        .foregroundStyle(Color.sulAccent)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.sulAccent.opacity(isCurrent ? 0.10 : 0))
        )
        .animation(.easeInOut(duration: 0.25), value: isCurrent)
        .contentShape(Rectangle())
    }
}

// ── the AVAudioPlayer wrapper ──

@MainActor
final class AudioPlayback: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0
    /// True when the file couldn't be opened (e.g. a checkpointed recording
    /// whose AAC container never finalized). The UI degrades to a quiet note.
    @Published private(set) var loadFailed = false

    private var player: AVAudioPlayer?
    private var timer: Timer?

    func load(url: URL) {
        guard player == nil else { return }
        player = try? AVAudioPlayer(contentsOf: url)
        if let player {
            player.delegate = self
            duration = player.duration
            loadFailed = false
        } else {
            loadFailed = true
        }
    }

    func togglePlayback() {
        guard let player else { return }
        if player.isPlaying {
            player.pause()
            isPlaying = false
            stopTimer()
        } else {
            activatePlaybackSession()
            player.play()
            isPlaying = true
            startTimer()
        }
    }

    func seek(to seconds: Double) {
        guard let player else { return }
        player.currentTime = min(max(0, seconds), duration)
        currentTime = player.currentTime
    }

    /// Jump to an offset and make sure playback is running — the tap-to-seek
    /// path. Clamps just short of the end so a tap on the last entry plays it.
    func play(from seconds: Double) {
        guard let player else { return }
        player.currentTime = min(max(0, seconds), max(duration - 0.05, 0))
        currentTime = player.currentTime
        if !player.isPlaying {
            activatePlaybackSession()
            player.play()
            isPlaying = true
            startTimer()
        }
    }

    func stop() {
        stopTimer()
        player?.stop()
        player = nil
        isPlaying = false
        currentTime = 0
    }

    private func activatePlaybackSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let player = self.player else { return }
                self.currentTime = player.currentTime
            }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    // MARK: AVAudioPlayerDelegate

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
            self.currentTime = 0
            self.stopTimer()
        }
    }
}
