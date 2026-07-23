// Sign in with Apple → proxy session, per server/API.md.
//
// The app hands the ASAuthorizationAppleIDCredential's identity token to
// POST /v1/auth/apple; the server verifies it against Apple's JWKS and mints
// the session token every authenticated endpoint expects. This client is the
// only unauthenticated call in the contract — everything else goes through
// ProxyClient with the session token this returns.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public final class AccountClient: @unchecked Sendable {
    private let config: ProxyConfig
    private let session: URLSession

    public init(config: ProxyConfig, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    /// Exchange a Sign in with Apple identity token (the JWT from
    /// `ASAuthorizationAppleIDCredential.identityToken`) for a proxy session.
    /// A bad or expired identity token surfaces as `ProxyError.unauthorized`.
    public func exchangeAppleIdentityToken(_ identityToken: String) async throws -> ProxySession {
        let url = config.baseURL.appendingPathComponent("v1/auth/apple")
        let data = try await ProxyWire.post(
            url,
            body: ["identityToken": identityToken],
            bearerToken: nil,
            session: session
        )
        do {
            return try JSONDecoder().decode(ProxySession.self, from: data)
        } catch {
            throw ProxyError.decoding(String(describing: error))
        }
    }
}
