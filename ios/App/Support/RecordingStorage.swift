// Where session audio lives: Application Support/Recordings/<uuid stem> with
// one of two extensions — `.caf` while capturing (append-safe, readable after
// a crash), `.m4a` once the graceful-stop / launch-recovery remux adopts it
// (plan Key Decisions: CAF during capture, remux at close). Files are owned by
// their SessionRecord — deleting a record deletes its files, and the
// stem-based helpers below delete BOTH incarnations so neither can linger.

import Foundation

enum RecordingStorage {
    /// The recordings directory, created on first use.
    static var directory: URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        )[0]
        let dir = base.appendingPathComponent("Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func url(for fileName: String) -> URL {
        directory.appendingPathComponent(fileName)
    }

    static func delete(fileName: String) {
        try? FileManager.default.removeItem(at: url(for: fileName))
    }

    static func exists(fileName: String) -> Bool {
        FileManager.default.fileExists(atPath: url(for: fileName).path)
    }

    // ── the CAF/M4A naming convention (same UUID stem, two extensions) ──

    static func cafFileName(stem: String) -> String { stem + ".caf" }
    static func m4aFileName(stem: String) -> String { stem + ".m4a" }

    /// The extension-less stem of a recording file name.
    static func stem(of fileName: String) -> String {
        (fileName as NSString).deletingPathExtension
    }

    /// Delete both incarnations of a recording — the crash-safe CAF and the
    /// remuxed M4A — whichever exist.
    static func deleteBoth(stem: String) {
        delete(fileName: cafFileName(stem: stem))
        delete(fileName: m4aFileName(stem: stem))
    }

    /// Every .m4a currently on disk. Ownership is one-way (records point at
    /// files), so crash recovery diffs this list against the records to find
    /// orphans — see `SessionRecovery`.
    ///
    /// IT FILTERS `.m4a` ONLY, AND THAT IS DELIBERATE — do not "fix" it to
    /// include `.caf`. Under record-at-start every live capture owns a record
    /// from its first sample, so a crash-orphaned `.caf` is never record-less:
    /// `PersistenceWriter.recoverIncompleteSessions` owns it, keyed on record
    /// state. Widening this sweep to `.caf` would make the two recovery paths
    /// race for the same file. The only true orphans left are `.m4a` files
    /// from pre-port builds, which is exactly what this is narrowed to.
    static func allRecordingFileNames() -> [String] {
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        )) ?? []
        return urls
            .filter { $0.pathExtension == "m4a" }
            .map(\.lastPathComponent)
    }
}
