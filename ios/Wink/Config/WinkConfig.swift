import Foundation
import Observation

/// Where the backend lives and how to authenticate. A Sendable snapshot handed to the API client and socket.
nonisolated struct WinkEndpoint: Sendable, Equatable {
    let baseURL: URL
    let token: String
}

/// Reads `WinkAPIBaseURL` / `WinkToken` from Info.plist (filled from Config/Secrets.xcconfig),
/// with in-app overrides stored in UserDefaults so the demo can switch servers without rebuilding.
@Observable
final class WinkConfig {
    static let shared = WinkConfig()

    private static let baseURLKey = "wink.override.baseURL"
    private static let tokenKey = "wink.override.token"

    nonisolated static var bundleBaseURL: String {
        (Bundle.main.object(forInfoDictionaryKey: "WinkAPIBaseURL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    nonisolated static var bundleToken: String {
        (Bundle.main.object(forInfoDictionaryKey: "WinkToken") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// Empty string means "use the bundled value".
    var baseURLOverride: String {
        didSet { UserDefaults.standard.set(baseURLOverride, forKey: Self.baseURLKey) }
    }

    var tokenOverride: String {
        didSet { UserDefaults.standard.set(tokenOverride, forKey: Self.tokenKey) }
    }

    init() {
        baseURLOverride = UserDefaults.standard.string(forKey: Self.baseURLKey) ?? ""
        tokenOverride = UserDefaults.standard.string(forKey: Self.tokenKey) ?? ""
    }

    var baseURLString: String {
        let override = baseURLOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        return override.isEmpty ? Self.bundleBaseURL : override
    }

    var token: String {
        let override = tokenOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        return override.isEmpty ? Self.bundleToken : override
    }

    var endpoint: WinkEndpoint? {
        var string = baseURLString
        while string.hasSuffix("/") { string.removeLast() }
        if !string.contains("://") { string = "http://" + string }
        guard let url = URL(string: string), url.host != nil else { return nil }
        return WinkEndpoint(baseURL: url, token: token)
    }

    func resetOverrides() {
        baseURLOverride = ""
        tokenOverride = ""
    }
}
