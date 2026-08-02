// Launch-time crash recovery for orphaned session audio.
//
// After the transcript-core port there are TWO launch recovery paths, and they
// cover different failures:
//
//   PersistenceWriter.recoverIncompleteSessions  — a RECORD in `recording`
//       state, i.e. a session that died with its record already on disk. It
//       owns the crashed CAF, remuxes it, and stamps the record `recovered`.
//       Under record-at-start this is the normal case: every live capture has
//       a record from its first sample.
//
//   adoptOrphanedRecordings (this file)          — an AUDIO FILE with no
//       owning record at all. Record-at-start makes that impossible going
//       FORWARD, but real devices can already be in it from pre-port builds,
//       whose recordings were only referenced once the first checkpoint ran.
//
// Different failure, different input, no overlap — which is why this survives
// the port rather than being replaced by the writer's path.
//
// ORDERING. The two sweeps are NOT commutative, and this one runs second.
// `recoverIncompleteSessions` remuxes a crashed CAF to .m4a and then adopts it
// into its record; between the remux and the save there is a window where a
// finished-looking .m4a exists whose record does not yet point at it. An orphan
// sweep running inside that window would adopt a duplicate "Recovered
// recording" for audio that already has a home. The caller therefore awaits
// `RecoveryGate.shared.waitUntilDone()` first — the same latch `startSession`
// waits on, which also preserves this function's own precondition that no new
// session can have started recording yet.
//
// Caveat, stated honestly: AVAudioFile only finalizes the .m4a container on
// close, so a file cut off mid-write may be unreadable. An unreadable orphan
// is unrecoverable bytes — we delete it rather than adopt a record that can
// never play. Sub-second readable orphans (an empty session that crashed
// before the clean-stop cleanup) are junk and deleted too.

import AVFoundation
import Foundation
import SwiftData
import TurnEngine

enum SessionRecovery {
    /// Adopt orphaned recordings into recovered records. Called once per
    /// launch, behind `RecoveryGate` (see the file header) — so every .m4a on
    /// disk without a record is genuinely an orphan, never an active file and
    /// never one the writer's recovery path is midway through claiming.
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
                // `state` MUST be named here. Under V2 the initializer defaults
                // to `.recording`, and LibraryView's query filters
                // `state != "recording"` — so a defaulted insert would land in
                // a live-session state, be filtered out of the library, and
                // silently produce rows no user can ever see: the exact failure
                // this sweep exists to prevent. Every argument below also
                // type-checks against V2 unchanged, so nothing would have
                // flagged it. `.recovered` is a visible terminal state and
                // LibraryView already ships its badge.
                state: .recovered,
                transcriptJSON: Data("[]".utf8), // audio survived; the words did not
                criteriaText: "",
                audioFileName: fileName
            ))
            adopted = true
        }
        if adopted { try? context.save() }
    }
}
