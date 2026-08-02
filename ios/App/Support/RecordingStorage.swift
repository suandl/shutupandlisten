// Where session audio lives: Application Support/Recordings/<uuid>.m4a.
// Files are owned by their SessionRecord — deleting a record deletes its file.

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

    /// Every .m4a currently on disk. Ownership is one-way (records point at
    /// files), so crash recovery diffs this list against the records to find
    /// orphans — see `SessionRecovery`.
    static func allRecordingFileNames() -> [String] {
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        )) ?? []
        return urls
            .filter { $0.pathExtension == "m4a" }
            .map(\.lastPathComponent)
    }
}
