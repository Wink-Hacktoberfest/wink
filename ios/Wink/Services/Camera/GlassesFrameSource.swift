import CoreImage
import CoreMedia
import Foundation
import MWDATCamera
import MWDATCore
import Observation
import UIKit
#if DEBUG
import MWDATMockDevice
#endif

/// Meta Ray-Ban camera via the Wearables Device Access Toolkit: registration with Meta AI,
/// camera permission, a DeviceSession and a raw video stream.
@Observable
final class GlassesFrameSource: FrameSource {
    let kind: FrameSourceKind = .glasses
    let broadcaster = FrameBroadcaster()

    private(set) var registration: RegistrationState = .unavailable
    private(set) var deviceCount = 0
    private(set) var isRunning = false
    private(set) var statusText = "Not connected"
    private(set) var frameCount = 0
    private(set) var lastError: String?
    private(set) var isMock = false

    @ObservationIgnored private var session: DeviceSession?
    @ObservationIgnored private var camera: Camera?
    @ObservationIgnored private var tokens = ListenerTokenBag()          // stream listeners
    @ObservationIgnored private var sessionTokens = ListenerTokenBag()   // session listeners
    // Sample keeps the selector as a stored property for the session's whole life; we used a temporary.
    @ObservationIgnored private var deviceSelector: AutoDeviceSelector?
    @ObservationIgnored private var observing = false

    var isRegistered: Bool { registration == .registered }

    var registrationText: String {
        switch registration {
        case .registered: "Registered"
        case .registering: "Registering…"
        case .available: "Not registered"
        case .unavailable: "Unavailable"
        @unknown default: "Unknown"
        }
    }

    /// Start observing registration and device state. Call once after `Wearables.configure()`.
    func observe() {
        guard !observing, WinkApp.wearablesConfigured else { return }
        observing = true
        let wearables = Wearables.shared
        Task { [weak self] in
            for await state in wearables.registrationStateStream() {
                self?.registration = state
            }
        }
        Task { [weak self] in
            for await devices in wearables.devicesStream() {
                self?.deviceCount = devices.count
            }
        }
    }

    /// Opens Meta AI so the wearer approves Wink. Meta AI calls back via `wink://` (see `WinkApp`).
    func register() async {
        guard WinkApp.wearablesConfigured else { lastError = "Wearables SDK not configured"; return }
        do {
            try await Wearables.shared.startRegistration()
        } catch {
            lastError = error.description
        }
    }

    func unregister() async {
        do { try await Wearables.shared.startUnregistration() } catch { lastError = error.description }
    }

    static func handle(url: URL) async -> String? {
        guard WinkApp.wearablesConfigured,
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              comps.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true else { return nil }
        do {
            _ = try await Wearables.shared.handleUrl(url)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func start() async throws {
        guard !isRunning else { return }
        do {
            try await startGlasses()
        } catch {
            // Previously every throw below left statusText at "Starting session…" and never set lastError,
            // and WinkController hides cameraError whenever controller.lastError is set. Surface it.
            NSLog("[Wink][Glasses] start failed during '\(statusText)': \(error)")
            lastError = "\(statusText) → \(error)"
            statusText = "Failed: \(error)"
            teardownSDK()
            isRunning = false
            throw error
        }
    }

    private func startGlasses() async throws {
        guard WinkApp.wearablesConfigured else { throw GlassesError.notConfigured }
        let wearables = Wearables.shared
        lastError = nil
        // Kill any session left over from a failed/duplicate attempt, otherwise createSession → .sessionAlreadyExists.
        teardownSDK()

        statusText = "Checking permission…"
        var status = try await wearables.checkPermissionStatus(.camera)
        if status != .granted {
            status = try await wearables.requestPermission(.camera)
        }
        guard status == .granted else { throw GlassesError.permissionDenied }

        // 1. Device: keep a strong reference to the selector (as Meta's CameraAccess sample does).
        let selector = AutoDeviceSelector(wearables: wearables)
        deviceSelector = selector
        if selector.activeDevice == nil {
            statusText = "Waiting for glasses (wear them, arms open)…"
            guard await poll(seconds: 10, { selector.activeDevice != nil }) else { throw GlassesError.noActiveDevice }
        }

        // 2. Session: subscribe to state AND errors before start() (sample + docs), then wait for .started.
        statusText = "Starting session…"
        let session = try wearables.createSession(deviceSelector: selector)
        self.session = session
        let sid = ObjectIdentifier(session)
        session.statePublisher.listen { [weak self] state in
            Task { @MainActor in self?.sessionStateChanged(state, sid: sid) }
        }.store(in: sessionTokens)
        session.errorPublisher.listen { [weak self] error in
            Task { @MainActor in self?.sessionFailed(error) }
        }.store(in: sessionTokens)
        try session.start()
        NSLog("[Wink][Glasses] session.start() ok, state=\(session.state) device=\(session.deviceId)")
        if session.state != .started {
            statusText = "Waiting for glasses session…"
            _ = await poll(seconds: 15, { session.state == .started || session.state == .stopped })
            guard session.state == .started else { throw GlassesError.sessionNotStarted }
        }

        // 3. Camera + stream: docs' reference config (raw / low / 24). Valid fps: 2, 7, 15, 24, 30.
        statusText = "Adding camera…"
        let config = StreamConfiguration(videoCodec: .raw, resolution: .low, frameRate: 24)
        guard let camera = try session.addCamera(config: config) else { throw GlassesError.cameraUnavailable }
        self.camera = camera
        let stream = camera.stream
        let broadcaster = self.broadcaster
        frameCount = 0

        // Listeners before stream.start(), tokens retained in a long-lived bag.
        stream.videoFramePublisher.listen { [weak self] frame in
            // Runs on the SDK's queue. Glasses frames are pixel-buffer backed, so UIImage.cgImage is nil; convert directly.
            guard let cg = GlassesFrameSource.cgImage(from: frame) else { return }
            broadcaster.publish(Frame(image: cg))
            Task { @MainActor in self?.countFrame() }
        }.store(in: tokens)
        stream.statePublisher.listen { [weak self] state in
            Task { @MainActor in self?.streamStateChanged(state) }
        }.store(in: tokens)
        stream.errorPublisher.listen { [weak self] error in
            NSLog("[Wink][Glasses] stream error: \(error)")
            Task { @MainActor in self?.lastError = "Stream error: \(error)" }
        }.store(in: tokens)

        statusText = "Starting stream…"
        stream.start()
        isRunning = true                 // stops connectGlasses() from double-starting
        NSLog("[Wink][Glasses] stream.start() called, state=\(stream.state)")
        // The publisher may not replay the current state; seed it (but .stopped here just means "not yet").
        if stream.state != .stopped { streamStateChanged(stream.state) }

        // Watchdog: never hang silently. Report the real state if the stream doesn't come up.
        _ = await poll(seconds: 20, { stream.state == .streaming || self.frameCount > 0 })
        if stream.state != .streaming && frameCount == 0 {
            statusText = "Stream: \(stream.state)"
            lastError = "Stream stuck in \(stream.state) after 20 s. Re-toggle Developer Mode in Meta AI (it resets after firmware updates), unfold + wear the glasses, and retry with the wake-word mic stopped."
        }
    }

    private func streamStateChanged(_ state: StreamState) {
        NSLog("[Wink][Glasses] stream state -> \(state)")
        switch state {
        case .streaming:
            if frameCount == 0 { statusText = "Streaming" }
            isRunning = true
        case .waitingForDevice: statusText = "Waiting for glasses…"
        case .starting: statusText = "Starting…"
        case .paused: statusText = "Paused"
        case .stopping: statusText = "Stopping…"
        case .stopped:
            if camera != nil { statusText = "Stopped" }
            isRunning = false
        @unknown default: break
        }
    }

    private func sessionStateChanged(_ state: DeviceSessionState, sid: ObjectIdentifier) {
        NSLog("[Wink][Glasses] session state -> \(state)")
        guard let session, ObjectIdentifier(session) == sid else { return } // ignore stale sessions
        switch state {
        case .paused: statusText = "Session paused by glasses"
        case .stopped:
            statusText = "Glasses session ended"
            teardownSDK()
            isRunning = false
        default: break
        }
    }

    private func sessionFailed(_ error: DeviceSessionError) {
        // We never listened to session errors before; one-shot errors were silently dropped.
        NSLog("[Wink][Glasses] session error: \(error)")
        lastError = "Session error: \(error)"
        if error == .datAppOnTheGlassesUpdateRequired {
            statusText = "Glasses app update required"
            Task { try? await Wearables.shared.openDATGlassesAppUpdate() }
        }
    }

    /// Polls a cheap synchronous condition on the main actor. Avoids task groups whose children may ignore cancellation.
    private func poll(seconds: Double, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return condition()
    }

    /// Cancels listeners first (so teardown events don't reach us), then stops camera and session.
    private func teardownSDK() {
        tokens.clear()
        sessionTokens.clear()
        camera?.stop()
        session?.stop()
        camera = nil
        session = nil
        deviceSelector = nil
    }

    func stop() {
        teardownSDK()
        isRunning = false
        statusText = "Not connected"
        broadcaster.clear()
    }

    private func countFrame() {
        frameCount += 1
        if frameCount == 1 || frameCount % 30 == 0 { statusText = "Streaming · \(frameCount) frames" }
    }

    nonisolated(unsafe) private static let ciContext = CIContext()

    nonisolated private static func cgImage(from frame: VideoFrame) -> CGImage? {
        if let pixels = CMSampleBufferGetImageBuffer(frame.sampleBuffer) {
            let ci = CIImage(cvPixelBuffer: pixels)
            if let cg = ciContext.createCGImage(ci, from: ci.extent) { return cg }
        }
        guard let image = frame.makeUIImage() else { return nil }
        if let cg = image.cgImage { return cg }
        if let ci = image.ciImage { return ciContext.createCGImage(ci, from: ci.extent) }
        return UIGraphicsImageRenderer(size: image.size).image { _ in image.draw(at: .zero) }.cgImage
    }

    enum GlassesError: LocalizedError {
        case notConfigured, permissionDenied, cameraUnavailable, sessionNotStarted, noActiveDevice
        var errorDescription: String? {
            switch self {
            case .notConfigured: "Wearables SDK failed to configure."
            case .permissionDenied: "Glasses camera permission was denied in Meta AI."
            case .cameraUnavailable: "Couldn't attach to the glasses camera."
            case .sessionNotStarted: "The glasses didn't start a session. Wear them with the arms open, then tap Connect again."
            case .noActiveDevice: "No connected glasses. Unfold and wear them, check Bluetooth, then tap Connect again."
            }
        }
    }

    #if DEBUG
    /// Simulated glasses (MockDeviceKit) streaming the phone's back camera, for testing without hardware.
    func enableMockGlasses() {
        let kit = MockDeviceKit.shared
        kit.enable()
        do {
            let glasses = try kit.pairGlasses(model: .rayBanMeta)
            glasses.powerOn()
            glasses.unfold()
            glasses.don()
            glasses.services.camera.setCameraFeed(cameraFacing: .back)
            isMock = true
        } catch {
            lastError = "Mock glasses: \(error.localizedDescription)"
        }
    }
    #endif
}
