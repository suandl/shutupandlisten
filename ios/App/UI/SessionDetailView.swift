// A saved session: the transcript (same bubble language as the live screen),
// the coverage snapshot when a check ran, the audio when it was recorded, and
// a Markdown export via ShareLink.
//
// TRUE REPLAY (plan R3.3): when the record's segments carry real canonical-
// timeline ranges (`record.hasTimings`), tapping a bubble seeks playback to
// its `audioStart`, and the bubble containing the playhead — the LAST segment
// whose `audioStart` is at or before `currentTime` — is highlighted as audio
// plays. Records without timings (pre-migration, rehydrated with zeroed
// ranges) degrade to exactly the old static view: no seek, no highlight.

import AVFoundation
import SwiftUI
import TranscriptCore
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
        ScrollView {
            let segments = record.transcriptSegments
            // Replay affordances need audio AND real timings (R3.3).
            let seekable = audioURL != nil && record.hasTimings
            let current = seekable ? currentSegmentPosition(in: segments) : nil
            LazyVStack(alignment: .leading, spacing: 10) {
                header

                if let audioURL {
                    playerControls
                        .onAppear { playback.load(url: audioURL) }
                }

                ForEach(Array(segments.enumerated()), id: \.offset) { position, segment in
                    if !segment.text.isEmpty {
                        StoredBubble(segment: segment, isCurrent: position == current)
                            .contentShape(RoundedRectangle(cornerRadius: 14))
                            .onTapGesture {
                                guard seekable else { return }
                                playback.seek(to: segment.audioStart)
                            }
                    }
                }

                if let coverage = record.coverage {
                    coverageSection(coverage)
                }
            }
            .padding()
        }
        .navigationTitle(record.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: record.markdown)
                    .accessibilityLabel("Export as Markdown")
            }
        }
        .onDisappear { playback.stop() }
    }

    /// The segment the playhead is inside: the LAST one whose `audioStart` is
    /// at or before `currentTime`. Nil before playback has moved, so nothing
    /// is highlighted on a freshly opened session.
    private func currentSegmentPosition(in segments: [TranscriptSegment]) -> Int? {
        guard playback.currentTime > 0 else { return nil }
        var position: Int?
        for (i, segment) in segments.enumerated() where segment.audioStart <= playback.currentTime {
            position = i
        }
        return position
    }

    // ── header ──

    private var header: some View {
        HStack(spacing: 6) {
            Text(record.startedAt.formatted(date: .abbreviated, time: .shortened))
            Text("·")
            Text(RecordRowDuration.text(record.duration))
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
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

            Text(RecordRowDuration.text(playback.currentTime))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    // ── coverage snapshot ──

    private func coverageSection(_ coverage: CoverageResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Coverage")
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
}

/// mm:ss, shared by the header and the player readout.
private enum RecordRowDuration {
    static func text(_ duration: TimeInterval) -> String {
        let total = Int(duration.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// ── transcript bubble (visually matches SessionView's TranscriptBubble) ──

private struct StoredBubble: View {
    let segment: TranscriptSegment
    let isCurrent: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(segment.text)
                .font(segment.speaker == .thinker ? .body : .body.italic())
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            segment.speaker == .thinker
                ? AnyShapeStyle(Color(.secondarySystemBackground))
                : AnyShapeStyle(Color.accentColor.opacity(0.12)),
            in: RoundedRectangle(cornerRadius: 14)
        )
        .overlay {
            // The follow-along highlight (R3.3) — drawn, not re-tinted, so the
            // thinker/listener bubble colors stay recognizable underneath.
            if isCurrent {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(Color.accentColor.opacity(0.6), lineWidth: 1.5)
            }
        }
    }

    private var label: String {
        guard segment.speaker == .listener else { return "You" }
        switch segment.tier {
        case .question: return "Listener · thread-pull"
        case .reflection: return "Listener · reflection"
        default: return "Listener"
        }
    }
}

// ── the AVAudioPlayer wrapper ──

@MainActor
final class AudioPlayback: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: Double = 0
    @Published private(set) var duration: Double = 0

    private var player: AVAudioPlayer?
    private var timer: Timer?

    func load(url: URL) {
        guard player == nil else { return }
        player = try? AVAudioPlayer(contentsOf: url)
        player?.delegate = self
        duration = player?.duration ?? 0
    }

    func togglePlayback() {
        guard let player else { return }
        if player.isPlaying {
            player.pause()
            isPlaying = false
            stopTimer()
        } else {
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            try? AVAudioSession.sharedInstance().setActive(true)
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

    func stop() {
        stopTimer()
        player?.stop()
        player = nil
        isPlaying = false
        currentTime = 0
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
