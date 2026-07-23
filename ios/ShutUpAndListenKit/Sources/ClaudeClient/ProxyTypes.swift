// Shared types for the shutupandlisten proxy (server/API.md v1): the client
// configuration, the session issued by POST /v1/auth/apple, and the error
// space the wire contract's `{ error: { type, message } }` envelope maps into.
//
// The proxy is the customer-facing replacement for bring-your-own-API-key:
// the server holds the Anthropic key, the app holds a per-user session token.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct ProxyConfig: Sendable {
    /// The proxy's base URL (default in the app: https://api.shutupandlisten.sh).
    public var baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }
}

/// The session issued by POST /v1/auth/apple: an opaque-to-client token the
/// app sends as `Authorization: Bearer <sessionToken>` on every call.
public struct ProxySession: Codable, Equatable, Sendable {
    public let sessionToken: String
    public let userId: String
    /// Session expiry, decoded from the API's ISO 8601 string; nil when the
    /// field is absent or unparseable — the client treats that as "unknown"
    /// and simply re-authenticates when a request comes back 401.
    public let expiresAt: Date?

    public init(sessionToken: String, userId: String, expiresAt: Date?) {
        self.sessionToken = sessionToken
        self.userId = userId
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case sessionToken, userId, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionToken = try container.decode(String.self, forKey: .sessionToken)
        userId = try container.decode(String.self, forKey: .userId)
        let raw = (try? container.decodeIfPresent(String.self, forKey: .expiresAt)) ?? nil
        expiresAt = raw.flatMap(Self.parseISO8601)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionToken, forKey: .sessionToken)
        try container.encode(userId, forKey: .userId)
        if let expiresAt {
            let formatter = ISO8601DateFormatter()
            try container.encode(formatter.string(from: expiresAt), forKey: .expiresAt)
        }
    }

    private static func parseISO8601(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}

/// Client-side view of the proxy's error contract. The associated string is
/// the server's `error.message` where one was parseable (or a transport /
/// decoding detail), so callers can surface something actionable.
public enum ProxyError: Error, LocalizedError, Equatable {
    case unauthorized
    case quotaExceeded(String)
    case invalidRequest(String)
    case upstream(String)
    case transport(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Your session expired — sign in again."
        case .quotaExceeded(let message):
            return message.isEmpty
                ? "You've hit today's usage limit — try again tomorrow."
                : message
        case .invalidRequest(let message):
            return message.isEmpty
                ? "The server rejected this request."
                : message
        case .upstream(let message):
            return message.isEmpty
                ? "The server could not reach the model — try again in a moment."
                : message
        case .transport(let message):
            return message.isEmpty
                ? "Network error — check your connection and try again."
                : "Network error — \(message)"
        case .decoding(let detail):
            return "Could not decode the server's response: \(detail)"
        }
    }
}

// ── Shared wire plumbing (internal) ──
//
// Both AccountClient and ProxyClient speak the same dialect: JSON POST,
// optional bearer token, the shared error envelope. Centralised here so the
// status → ProxyError mapping lives in exactly one place.

enum ProxyWire {
    /// POST `body` as JSON to `url`, map failures into ProxyError, and return
    /// the raw response data for the caller to decode.
    static func post(
        _ url: URL,
        body: [String: Any],
        bearerToken: String?,
        session: URLSession
    ) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 60

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw ProxyError.transport(error.localizedDescription)
        } catch {
            throw ProxyError.transport(String(describing: error))
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw proxyError(status: status, data: data)
        }
        return data
    }

    /// Map a non-2xx status + body into a ProxyError, pulling the message out
    /// of the `{ error: { type, message } }` envelope when it parses and
    /// falling back to the raw body (or nothing) when it doesn't.
    static func proxyError(status: Int, data: Data) -> ProxyError {
        let message = envelopeMessage(from: data)
            ?? String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
        switch status {
        case 401:
            return .unauthorized
        case 429:
            return .quotaExceeded(message)
        case 400:
            return .invalidRequest(message)
        case 500...599:
            return .upstream(message)
        default:
            return .upstream(message.isEmpty ? "unexpected status \(status)" : message)
        }
    }

    private static func envelopeMessage(from data: Data) -> String? {
        struct Envelope: Decodable {
            struct Inner: Decodable { let message: String }
            let error: Inner
        }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.error.message
    }
}
