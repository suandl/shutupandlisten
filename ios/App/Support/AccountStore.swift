// Auth state for the customer path: a proxy session token obtained via Sign
// in with Apple (server/API.md POST /v1/auth/apple), held in the Keychain.
// Developer mode (bring-your-own-key) remains available underneath —
// `makeListenerService` resolves which backend a session talks to, so the
// product/dev split stays a configuration choice, not a code path.

import ClaudeClient
import Foundation
import SwiftUI

enum AccountError: Error, LocalizedError {
    case invalidBaseURL

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "The server address is not a valid URL. Check it under Settings → Server → Advanced."
        }
    }
}

@MainActor
final class AccountStore: ObservableObject {
    @Published private(set) var isSignedIn = false
    @Published private(set) var userId: String?

    /// The proxy base URL — overridable under Settings → Server → Advanced.
    @AppStorage("proxyBaseURL") var proxyBaseURL = "https://api.shutupandlisten.sh"

    private static let tokenKey = "proxySessionToken"
    private static let userIdKey = "proxyUserId"

    init() {
        let token = KeychainStore.string(for: Self.tokenKey) ?? ""
        isSignedIn = !token.isEmpty
        userId = KeychainStore.string(for: Self.userIdKey)
    }

    private var baseURL: URL? {
        URL(string: proxyBaseURL.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Exchange the Apple identity token for a proxy session and persist it.
    func completeSignIn(identityToken: String) async throws {
        guard let baseURL else { throw AccountError.invalidBaseURL }
        let client = AccountClient(config: ProxyConfig(baseURL: baseURL))
        let session = try await client.exchangeAppleIdentityToken(identityToken)
        KeychainStore.setString(session.sessionToken, for: Self.tokenKey)
        KeychainStore.setString(session.userId, for: Self.userIdKey)
        userId = session.userId
        isSignedIn = true
    }

    func signOut() {
        KeychainStore.setString(nil, for: Self.tokenKey)
        KeychainStore.setString(nil, for: Self.userIdKey)
        userId = nil
        isSignedIn = false
    }

    /// Resolve the listener backend: the account proxy when a session token
    /// exists, the developer-mode key when one is set, nil when neither is
    /// configured (the caller shows the call-to-action).
    func makeListenerService(devAPIKey: String?) -> (any ListenerService)? {
        if let token = KeychainStore.string(for: Self.tokenKey), !token.isEmpty, let baseURL {
            return ProxyClient(config: ProxyConfig(baseURL: baseURL), sessionToken: token)
        }
        if let key = devAPIKey?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty {
            return ClaudeClient(config: ClaudeConfig(apiKey: key))
        }
        return nil
    }
}
