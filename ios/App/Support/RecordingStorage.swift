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
}
