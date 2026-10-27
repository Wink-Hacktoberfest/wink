import CoreLocation
import Foundation

/// One-shot location. Returns nil when denied or when no fix arrives quickly.
final class LocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiters: [CheckedContinuation<CLLocation?, Never>] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func requestPermission() {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
    }

    var isDenied: Bool {
        [.denied, .restricted].contains(manager.authorizationStatus)
    }

    func current(timeout: Double = 3) async -> Location? {
        guard !isDenied else { return nil }
        if let loc = manager.location, -loc.timestamp.timeIntervalSinceNow < 120 {
            return Location(lat: loc.coordinate.latitude, lng: loc.coordinate.longitude)
        }
        requestPermission()
        let fix: CLLocation? = await withCheckedContinuation { c in
            waiters.append(c)
            manager.requestLocation()
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                self?.resolve(nil)
            }
        }
        return fix.map { Location(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude) }
    }

    private func resolve(_ location: CLLocation?) {
        let pending = waiters
        waiters = []
        pending.forEach { $0.resume(returning: location ?? manager.location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let last = locations.last
        Task { @MainActor in self.resolve(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.resolve(nil) }
    }
}
