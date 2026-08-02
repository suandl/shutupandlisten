// The session library: past sessions, newest first, with search. Presented as
// a sheet over the live session screen, so the one prominent action — "New
// session" — simply dismisses back to the mic that is already waiting
// underneath. Search matches the title and what YOU said; the listener's few
// words never pollute results.

import SwiftData
import SwiftUI

struct LibraryView: View {
    @EnvironmentObject private var controller: SessionController
    @EnvironmentObject private var accountStore: AccountStore
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \SessionRecord.startedAt, order: .reverse)
    private var records: [SessionRecord]

    @Environment(\.dismiss) private var dismiss

    @State private var searchText = ""
    @State private var showSettings = false
    @State private var searchIndex = ThinkerSearchIndex()

    private var filtered: [SessionRecord] {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return records }
        return records.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || searchIndex.thinkerText(for: $0).localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if records.isEmpty {
                    emptyState
                } else {
                    recordList
                }
            }
            .navigationTitle("Library")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .navigationDestination(for: SessionRecord.self) { record in
                SessionDetailView(record: record)
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .safeAreaInset(edge: .bottom) { newSessionButton }
        }
        .onAppear {
            controller.configure(modelContext: modelContext, accountStore: accountStore)
        }
    }

    // ── list ──

    private var recordList: some View {
        List {
            ForEach(filtered) { record in
                NavigationLink(value: record) {
                    RecordRow(record: record)
                }
            }
            .onDelete(perform: delete)
        }
        .searchable(text: $searchText, prompt: "Search sessions")
        .overlay {
            if filtered.isEmpty && !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            }
        }
    }

    private func delete(at offsets: IndexSet) {
        for index in offsets {
            let record = filtered[index]
            if let fileName = record.audioFileName {
                RecordingStorage.delete(fileName: fileName)
            }
            modelContext.delete(record)
        }
        try? modelContext.save()
    }

    // ── empty state ──

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "waveform")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("No sessions yet")
                .font(.title3.weight(.semibold))
            Text(
                """
                Start one and think out loud. It listens like a voice \
                recorder, waits out your pauses, and keeps every session here.
                """
            )
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 32)
    }

    // ── new session ──

    /// The library lives in a sheet over the live session screen — starting a
    /// new session is just getting out of its way.
    private var newSessionButton: some View {
        VStack(spacing: 0) {
            Button {
                dismiss()
            } label: {
                Label("New session", systemImage: "mic.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal)
            .padding(.vertical, 10)
        }
        .background(.bar)
    }
}

// ── thinker-only search text, memoized ──

/// Joins each record's THINKER utterances for search, decoded once per record
/// and cached. Keyed on the transcript's byte count as well as the id so a
/// record finalized in place (checkpointed sessions keep their UUID) refreshes
/// naturally. Reference type on purpose: reading it inside `body` never
/// invalidates the view.
private final class ThinkerSearchIndex {
    private var store: [UUID: (byteCount: Int, text: String)] = [:]

    func thinkerText(for record: SessionRecord) -> String {
        let byteCount = record.transcriptJSON.count
        if let cached = store[record.id], cached.byteCount == byteCount {
            return cached.text
        }
        let text = record.entries
            .filter { $0.speaker == "thinker" }
            .map(\.text)
            .joined(separator: " ")
        store[record.id] = (byteCount, text)
        return text
    }
}

// ── row ──

private struct RecordRow: View {
    let record: SessionRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(record.title)
                .font(.body.weight(.medium))
                .lineLimit(1)
            if let question = record.openQuestion {
                Text(question)
                    .font(.system(.subheadline, design: .serif).italic())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .accessibilityLabel("Open question: \(question)")
            }
            metadata
        }
        .padding(.vertical, 4)
    }

    private var metadata: some View {
        HStack(spacing: 6) {
            Text(record.startedAt, format: .relative(presentation: .named))
            Text("·")
            Text(Self.durationText(record.duration))
            if isAudioOnly {
                Text("·")
                Text("audio only")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    /// Recovered sessions carry a recording but no transcript — say so
    /// quietly instead of rendering an empty-looking row.
    private var isAudioOnly: Bool {
        record.audioFileName != nil && !record.entries.contains { !$0.text.isEmpty }
    }

    static func durationText(_ duration: TimeInterval) -> String {
        let total = Int(duration.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
