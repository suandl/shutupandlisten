// The on-device speech model, made present before it is needed (docs/plans/
// 2026-08-01-001-feat-ios-transcript-core-rewrite-plan.md, R2.6).
//
// SpeechTranscriber's locale model is an AssetInventory download, not a bundle
// resource: first run needs network + storage, and the SYSTEM can evict it
// later under storage pressure. So the same helpers run in two places —
// onboarding (with download progress surfaced) and EVERY session start
// (re-verify; a session must never begin against a missing model, it blocks
// with a clear message instead). Reservations are managed too: locales the app
// no longer transcribes are released so the inventory can reclaim them.
//
// Same API-drift rule as AnalyzerEngine: the exact AssetInventory /
// SpeechTranscriber symbol shapes are reconciled at first Xcode build; each
// uncertain call site carries an `// SDK-CHECK:` comment.

import Foundation
import Speech

enum AssetEnsure {
    enum Status {
        /// The locale's model is installed — sessions may start.
        case installed
        /// Supported, but the model must be downloaded (first run, or evicted).
        case needsDownload
        /// SpeechTranscriber cannot transcribe this locale at all.
        case unsupported
    }

    enum AssetError: LocalizedError {
        case unsupportedLocale(Locale)

        var errorDescription: String? {
            switch self {
            case .unsupportedLocale(let locale):
                let name = Locale.current.localizedString(forIdentifier: locale.identifier)
                    ?? locale.identifier
                return "On-device transcription isn't available for \(name) yet."
            }
        }
    }

    /// Where the locale's model stands right now. Cheap; called at every
    /// session start (assets can be evicted under storage pressure — R2.6).
    static func status(for locale: Locale) async -> Status {
        // SDK-CHECK: SpeechTranscriber.supportedLocales /
        // .installedLocales — static async [Locale] on the module type.
        let supported = await SpeechTranscriber.supportedLocales
        guard supported.contains(where: { same($0, locale) }) else {
            return .unsupported
        }
        let installed = await SpeechTranscriber.installedLocales
        return installed.contains(where: { same($0, locale) }) ? .installed : .needsDownload
    }

    /// Ensure the locale's model is installed, downloading if needed.
    /// `progress` (0…1, called on an arbitrary executor) drives the
    /// onboarding UI; session start calls this without a progress handler.
    static func ensure(
        for locale: Locale, progress: (@Sendable (Double) -> Void)? = nil
    ) async throws {
        switch await status(for: locale) {
        case .installed:
            progress?(1)
            return
        case .unsupported:
            throw AssetError.unsupportedLocale(locale)
        case .needsDownload:
            break
        }

        // The request is scoped to a module with the SAME configuration the
        // session will use, so what installs is what runs.
        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        // SDK-CHECK: AssetInventory.assetInstallationRequest(supporting:) —
        // returns nil when nothing needs installing; the request exposes a
        // Foundation `progress` and `downloadAndInstall()`.
        guard let request = try await AssetInventory.assetInstallationRequest(
            supporting: [transcriber]
        ) else {
            progress?(1)
            return
        }

        // Poll the request's Progress for the UI — simpler and safer than KVO
        // across concurrency domains, and 5 Hz is plenty for a download bar.
        let reporter: Task<Void, Never>? = progress.map { report in
            let requestProgress = request.progress
            return Task {
                while !Task.isCancelled {
                    report(requestProgress.fractionCompleted)
                    if requestProgress.isFinished { break }
                    try? await Task.sleep(nanoseconds: 200_000_000)
                }
            }
        }
        defer { reporter?.cancel() }
        try await request.downloadAndInstall()
        progress?(1)
    }

    /// Release reservations for locales we no longer transcribe, so the
    /// inventory can reclaim their storage (R2.6: reservations are managed).
    static func releaseStaleReservations(keeping locale: Locale) async {
        // SDK-CHECK: AssetInventory.reservedLocales /
        // .release(reservedLocale:) — reservation management surface.
        for reserved in await AssetInventory.reservedLocales where !same(reserved, locale) {
            await AssetInventory.release(reservedLocale: reserved)
        }
    }

    /// Locale equivalence by BCP-47 identifier — `Locale.current` and the
    /// inventory's locales may differ in representation while naming the same
    /// language.
    private static func same(_ a: Locale, _ b: Locale) -> Bool {
        a.identifier(.bcp47) == b.identifier(.bcp47)
    }
}
