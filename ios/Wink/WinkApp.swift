import MWDATCore
import SwiftUI

@main
struct WinkApp: App {
    /// False if `Wearables.configure()` threw; glasses features stay disabled and the phone camera still works.
    nonisolated(unsafe) static var wearablesConfigured = false
    nonisolated(unsafe) static var wearablesError: String?

    @State private var controller: WinkController

    init() {
        do {
            try Wearables.configure()
            Self.wearablesConfigured = true
        } catch {
            Self.wearablesError = "\(error)"
            NSLog("[Wink] Wearables.configure failed: \(error)")
        }
        _controller = State(wrappedValue: WinkController())
    }

    var body: some Scene {
        WindowGroup {
            ContentView(controller: controller)
                .task {
                    // Unit tests use the app as host; don't grab the mic/camera there.
                    guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
                    await controller.start()
                }
                // Meta AI calls back via wink://...?metaWearablesAction=... after registration/permissions.
                .onOpenURL { url in
                    Task { await controller.handleOpenURL(url) }
                }
                .preferredColorScheme(.light)
        }
    }
}
