// A saved session, opened to what mattered: the one question the listener
// earned (when there was one), the audio, and a quiet transcript. Entries that
// carry timing seek the recording when tapped; the current line highlights
// softly while the audio plays.

import AVFoundation
import SwiftUI
import TurnEngine

struct SessionDetailView: View {
    let record: SessionRecord
    @StateObject private var playback = AudioPlayback()

    private var audioURL: URL? {
        guard let name = record.audioFileName else { return nil }
        let url = RecordingStorage.url(for: name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    var body: some View {
        let entries = record.entries
        let hasTranscript = entries.contains { !$0.text.isEmpty }
        let currentIndex = activeIndex(in: entries)

        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                header
                headline(hasTranscript: hasTranscript)

                if audioURL != nil {
                    if playback.loadFailed {
                        audioUnavailableNote
                    } else {
                        playerControls
                    }
                }

                if hasTranscript {
                    transcript(entries: entries, currentIndex: currentIndex)
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
    private func transcript(entries: [StoredEntry], currentIndex: Int?) -> some View {
        ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
            if !entry.text.isEmpty {
                EntryRow(
                    entry: entry,
                    isCurrent: index == currentIndex,
                    onSeek: seekAction(for: entry)
                )
            }
        }
    }

    /// Tap-to-seek, only when the entry carries timing and the audio opened.
    /// Old records without timestamps stay inert — no broken affordances.
    private func seekAction(for entry: StoredEntry) -> (() -> Void)? {
        guard let startMs = entry.startMs, audioURL != nil, !playback.loadFailed else {
            return nil
        }
        return { playback.play(from: Double(startMs) / 1000) }
    }

    /// The entry currently sounding: the last one whose start the playhead has
    /// passed. `startMs` is monotonic across the session, so scan in order.
    private func activeIndex(in entries: [StoredEntry]) -> Int? {
        guard playback.isPlaying else { return nil }
        let ms = Int(playback.currentTime * 1000)
        var current: Int?
        for (index, entry) in entries.enumerated() {
            guard let start = entry.startMs else { continue }
            if start <= ms { current = index } else { break }
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
    let entry: StoredEntry
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
            if let start = entry.startMs {
                Text("[\(Clock.text(ms: start))]")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            if entry.speaker == "thinker" {
                Text(entry.text)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    Text("listener")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Color.sulAccent.opacity(0.8))
                    Text(entry.text)
                        .font(
                            entry.tier == Tier.question.rawValue
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
