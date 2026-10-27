@preconcurrency import AVFoundation
import CoreImage
import Foundation
import Observation

/// Back camera via AVCaptureSession: the fallback when the glasses aren't connected.
@Observable
final class PhoneFrameSource: FrameSource {
    let kind: FrameSourceKind = .phone
    let broadcaster = FrameBroadcaster()
    private(set) var isRunning = false
    private(set) var statusText = "Off"

    @ObservationIgnored private let session = AVCaptureSession()
    @ObservationIgnored private let output = AVCaptureVideoDataOutput()
    @ObservationIgnored private let queue = DispatchQueue(label: "wink.phone-camera", qos: .userInitiated)
    @ObservationIgnored private var delegate: SampleDelegate?
    @ObservationIgnored private var configured = false

    enum CameraError: LocalizedError {
        case denied, unavailable
        var errorDescription: String? {
            switch self {
            case .denied: "Camera access is off. Enable it in Settings."
            case .unavailable: "No back camera on this device."
            }
        }
    }

    func start() async throws {
        guard !isRunning else { return }
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted else { statusText = "Denied"; throw CameraError.denied }
        if !configured { try configure() }
        let session = self.session
        await Task.detached { session.startRunning() }.value
        isRunning = session.isRunning
        statusText = isRunning ? "Streaming" : "Failed to start"
    }

    func stop() {
        let session = self.session
        queue.async { session.stopRunning() }
        isRunning = false
        statusText = "Off"
        broadcaster.clear()
    }

    private func configure() throws {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device) else {
            statusText = "Unavailable"
            throw CameraError.unavailable
        }
        session.beginConfiguration()
        session.sessionPreset = .hd1280x720
        if session.canAddInput(input) { session.addInput(input) }
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        let delegate = SampleDelegate(broadcaster: broadcaster)
        self.delegate = delegate
        output.setSampleBufferDelegate(delegate, queue: queue)
        if session.canAddOutput(output) { session.addOutput(output) }
        if let connection = output.connection(with: .video), connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90 // portrait, upright
        }
        session.commitConfiguration()
        configured = true
    }

    private nonisolated final class SampleDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
        let broadcaster: FrameBroadcaster
        let context = CIContext(options: [.cacheIntermediates: false])
        var lastEmit: TimeInterval = 0

        init(broadcaster: FrameBroadcaster) { self.broadcaster = broadcaster }

        func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
            let now = ProcessInfo.processInfo.systemUptime
            guard now - lastEmit >= 1.0 / 20.0, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            lastEmit = now
            let ci = CIImage(cvPixelBuffer: pixelBuffer)
            guard let cg = context.createCGImage(ci, from: ci.extent) else { return }
            broadcaster.publish(Frame(image: cg, pixelBuffer: pixelBuffer, timestamp: now))
        }
    }
}
