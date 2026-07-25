// Launch-time crash recovery for session audio.
//
// A session that dies uncleanly (crash, jetsam, dead battery) leaves its .m4a
// on disk. Checkpointing (SessionController.persistSession(final: false))
// means the transcript usually already has a SessionRecord pointing at that
// file — nothing to do. A recording with NO owning record is a session that
// died before its first checkpoint: adopt it into a bare "Recovered
// recording" record so it surfaces in the library instead of leaking
// invisibly on disk.
//
// Caveat, stated honestly: AVAudioFile only finalizes the .m4a container on
// close, so a file cut off mid-write may be unreadable. An unreadable orphan
// is unrecoverable bytes — we delete it rather than adopt a record that can
// never play. Sub-second readable orphans (an empty session that crashed
// before the clean-stop cleanup) are junk and deleted too.

import AVFoundation
import Foundation
import SwiftData

enum SessionRecovery {
    /// Adopt orphaned recordings into recovered records. Called once per
    /// launch, before any new session can start recording — so every .m4a on
    /// disk without a record is genuinely an orphan, never an active file.
    @MainActor
    static func adoptOrphanedRecordings(in context: ModelContext) {
        let records = (try? context.fetch(FetchDescriptor<SessionRecord>())) ?? []
        let owned = Set(records.compactMap(\.audioFileName))

        var adopted = false
        for fileName in RecordingStorage.allRecordingFileNames() where !owned.contains(fileName) {
            let url = RecordingStorage.url(for: fileName)

            // Duration straight from the container; failure to open means the
            // crash beat the file's finalization and the audio is gone.
            guard let file = try? AVAudioFile(forReading: url),
                  file.processingFormat.sampleRate > 0
            else {
                RecordingStorage.delete(fileName: fileName)
                continue
            }
            let duration = Double(file.length) / file.processingFormat.sampleRate
            guard duration >= 1 else {
                RecordingStorage.delete(fileName: fileName)
                continue
            }

            let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?
                .creationDate ?? Date()
            context.insert(SessionRecord(
                startedAt: created,
                duration: duration,
                title: "Recovered recording",
                transcriptJSON: Data("[]".utf8), // audio survived; the words did not
                criteriaText: "",
                audioFileName: fileName
            ))
            adopted = true
        }
        if adopted { try? context.save() }
    }
}
