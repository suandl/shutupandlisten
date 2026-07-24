// Minimal Keychain wrapper for the secrets the app holds: the developer-mode
// Claude API key and the proxy session token. Never stored in UserDefaults,
// never logged.

import Foundation
import Security

enum KeychainStore {
    private static let service = "sh.shutupandlisten"
    // The API key predates the generic store and keeps its original location.
    private static let apiKeyService = "sh.shutupandlisten.apikey"
    private static let apiKeyAccount = "anthropic"

    // ── generic string storage ──

    static func string(for key: String) -> String? {
        read(service: service, account: key)
    }

    static func setString(_ value: String?, for key: String) {
        write(value, service: service, account: key)
    }

    /// Developer-mode Claude API key (kept at its original Keychain location
    /// so existing installs don't lose it).
    static var apiKey: String? {
        get { read(service: apiKeyService, account: apiKeyAccount) }
        set { write(newValue, service: apiKeyService, account: apiKeyAccount) }
    }

    // ── shared query code ──

    private static func read(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ value: String?, service: String, account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard let value, !value.isEmpty,
              let data = value.data(using: .utf8)
        else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
