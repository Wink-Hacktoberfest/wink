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
    @ObservationIgnored private var tokens = ListenerTokenBag()
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
        guard WinkApp.wearablesConfigured else { throw GlassesError.notConfigured }
        let wearables = Wearables.shared
        lastError = nil

        // TODO(glasses): untested without hardware. Permission prompt switches to Meta AI.
        statusText = "Checking permission…"
        var status = try await wearables.checkPermissionStatus(.camera)
        if status != .granted {
            status = try await wearables.requestPermission(.camera)
        }
        guard status == .granted else { statusText = "Camera permission denied"; throw GlassesError.permissionDenied }

        statusText = "Starting session…"
        let session = try wearables.createSession(deviceSelector: AutoDeviceSelector(wearables: wearables))
        self.session = session
        try session.start()
        // The session may already be started before we subscribe, or pause/stop if the glasses are folded,
        // so check the current state and give up after a bounded wait instead of hanging on "Starting session…".
        if session.state != .started {
            statusText = "Waiting for glasses session…"
            let started = await withTaskGroup(of: Bool.self) { group in
                group.addTask {
                    for await state in session.stateStream() {
                        if state == .started { return true }
                        if state == .stopped { return false }
                    }
                    return false
                }
                group.addTask {
                    try? await Task.sleep(for: .seconds(12))
                    return false
                }
                let result = await group.next() ?? false
                group.cancelAll()
                return result
            }
            guard started || session.state == .started else {
                statusText = "Session \(session.state)"
                session.stop()
                self.session = nil
                throw GlassesError.sessionNotStarted
            }
        }

        // Low resolution + modest frame rate = better per-frame quality over Bluetooth.
        let config = StreamConfiguration(videoCodec: .raw, resolution: .medium, frameRate: 15)
        guard let camera = try session.addCamera(config: config) else {
            statusText = "Camera unavailable"
            throw GlassesError.cameraUnavailable
        }
        self.camera = camera
        let stream = camera.stream
        let broadcaster = self.broadcaster

        frameCount = 0
        stream.videoFramePublisher.listen { [weak self] frame in
            // Runs on the SDK's queue. Glasses frames are pixel-buffer backed, so UIImage.cgImage is nil; convert directly.
            guard let cg = GlassesFrameSource.cgImage(from: frame) else { return }
            broadcaster.publish(Frame(image: cg))
            Task { @MainActor in self?.countFrame() }
        }.store(in: tokens)

        stream.statePublisher.listen { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .streaming: self.statusText = "Streaming"; self.isRunning = true
                case .waitingForDevice: self.statusText = "Waiting for glasses…"
                case .starting: self.statusText = "Starting…"
                case .paused: self.statusText = "Paused"
                case .stopped: self.statusText = "Stopped"; self.isRunning = false
                case .stopping: self.statusText = "Stopping…"
                @unknown default: break
                }
            }
        }.store(in: tokens)

        stream.errorPublisher.listen { [weak self] error in
            Task { @MainActor in self?.lastError = error.localizedDescription }
        }.store(in: tokens)

        stream.start()
        isRunning = true
    }

    func stop() {
        camera?.stop()
        session?.stop()
        camera = nil
        session = nil
        tokens.clear()
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
        case notConfigured, permissionDenied, cameraUnavailable, sessionNotStarted
        var errorDescription: String? {
            switch self {
            case .notConfigured: "Wearables SDK failed to configure."
            case .permissionDenied: "Glasses camera permission was denied in Meta AI."
            case .cameraUnavailable: "Couldn't attach to the glasses camera."
            case .sessionNotStarted: "The glasses didn't start a session. Wear them with the arms open, then tap Connect again."
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
