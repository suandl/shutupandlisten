// The home screen: past sessions, newest first, with search — and the one
// prominent action, starting a new session (which pushes the live SessionView).

import SwiftData
import SwiftUI

struct LibraryView: View {
    @EnvironmentObject private var controller: SessionController
    @EnvironmentObject private var accountStore: AccountStore
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \SessionRecord.startedAt, order: .reverse)
    private var records: [SessionRecord]

    @State private var searchText = ""
    @State private var showLiveSession = false
    @State private var showSettings = false

    private var filtered: [SessionRecord] {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return records }
        return records.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.searchableText.localizedCaseInsensitiveContains(query)
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
            .navigationDestination(isPresented: $showLiveSession) {
                SessionView()
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

    private var newSessionButton: some View {
        VStack(spacing: 0) {
            Button {
                showLiveSession = true
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

// ── row ──

private struct RecordRow: View {
    let record: SessionRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(record.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                if record.hasThreadPull {
                    Image(systemName: "questionmark.bubble.fill")
                        .font(.caption2)
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Includes a thread-pull")
                }
            }
            HStack(spacing: 6) {
                Text(record.startedAt, format: .relative(presentation: .named))
                Text("·")
                Text(Self.durationText(record.duration))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    static func durationText(_ duration: TimeInterval) -> String {
        let total = Int(duration.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
