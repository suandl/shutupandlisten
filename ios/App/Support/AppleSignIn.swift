// Shared Sign in with Apple plumbing: turn an authorization result into the
// identity-token string the proxy exchanges (server/API.md POST /v1/auth/apple),
// or a user-facing failure. Used by onboarding and Settings.
//
// Gated on APPLE_SIGN_IN: the capability cannot be provisioned by a free/
// personal Apple Developer team, so personal-token builds compile this out and
// rely on Developer mode (BYOK). See ios/README.md → Building.

#if APPLE_SIGN_IN
import AuthenticationServices
import Foundation

enum AppleSignIn {
    enum Outcome {
        case token(String)
        case cancelled
        case failed(String)
    }

    static func outcome(of result: Result<ASAuthorization, Error>) -> Outcome {
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken
            else {
                return .failed("Apple did not return an identity token. Please try again.")
            }
            return .token(String(decoding: tokenData, as: UTF8.self))
        case .failure(let error):
            if let authError = error as? ASAuthorizationError, authError.code == .canceled {
                return .cancelled
            }
            return .failed(error.localizedDescription)
        }
    }
}
#endif
