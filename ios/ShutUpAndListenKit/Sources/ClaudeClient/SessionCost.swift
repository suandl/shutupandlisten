// What a model call cost, and the running per-session tally.
//
// Usage is decoded from the Messages API `usage` block; SessionCost sums it and
// values it under Opus 4.8 pricing. `isExact` is false once any call reported no
// usage (today the account proxy path) — the readout labels that "approximate".
//
// PURE — no I/O. Prices live in one place (`ModelPricing.opus48`) so a price
// change is a one-line edit.

import Foundation

/// Token usage for one Messages API call. Cached input is reported separately
/// from fresh input, so all four fields are additive with their own rates.
public struct Usage: Equatable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheCreationInputTokens: Int
    public let cacheReadInputTokens: Int

    public init(
        inputTokens: Int,
        outputTokens: Int,
        cacheCreationInputTokens: Int,
        cacheReadInputTokens: Int
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheCreationInputTokens = cacheCreationInputTokens
        self.cacheReadInputTokens = cacheReadInputTokens
    }
}

/// Dollars per 1M tokens. Cache WRITE is 1.25× input; cache READ is 0.1× input.
public struct ModelPricing: Sendable {
    public let inputPerMTok: Double
    public let outputPerMTok: Double
    public let cacheWritePerMTok: Double
    public let cacheReadPerMTok: Double

    public init(
        inputPerMTok: Double,
        outputPerMTok: Double,
        cacheWritePerMTok: Double,
        cacheReadPerMTok: Double
    ) {
        self.inputPerMTok = inputPerMTok
        self.outputPerMTok = outputPerMTok
        self.cacheWritePerMTok = cacheWritePerMTok
        self.cacheReadPerMTok = cacheReadPerMTok
    }

    /// Opus 4.8: input $5, output $25, cache write $6.25, cache read $0.50 / 1M.
    public static let opus48 = ModelPricing(
        inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.50
    )
}

/// The per-session accumulator. Value type — the host holds one and adds to it
/// as calls return.
public struct SessionCost: Equatable, Sendable {
    public private(set) var inputTokens = 0
    public private(set) var outputTokens = 0
    public private(set) var cacheCreationInputTokens = 0
    public private(set) var cacheReadInputTokens = 0
    /// A metered call is one that reported usage. Once a call reports none, the
    /// figure can only be a lower bound.
    public private(set) var isExact = true

    public init() {}

    /// Fold in one call's usage. `nil` (a call that surfaced no usage — the
    /// proxy path today) counts nothing but flips the tally to approximate.
    public mutating func add(_ usage: Usage?) {
        guard let usage else { isExact = false; return }
        inputTokens += usage.inputTokens
        outputTokens += usage.outputTokens
        cacheCreationInputTokens += usage.cacheCreationInputTokens
        cacheReadInputTokens += usage.cacheReadInputTokens
    }

    public func dollars(pricing: ModelPricing = .opus48) -> Double {
        (Double(inputTokens) * pricing.inputPerMTok
            + Double(cacheCreationInputTokens) * pricing.cacheWritePerMTok
            + Double(cacheReadInputTokens) * pricing.cacheReadPerMTok
            + Double(outputTokens) * pricing.outputPerMTok) / 1_000_000
    }
}

/// One substantive listener turn plus what it cost. `text` empty ⇒ the model
/// chose silence (a valid, free outcome). `usage` nil ⇒ the backend surfaced no
/// token count (e.g. the account proxy today).
public struct ListenerReply: Equatable, Sendable {
    public let text: String
    public let usage: Usage?

    public init(text: String, usage: Usage?) {
        self.text = text
        self.usage = usage
    }
}
