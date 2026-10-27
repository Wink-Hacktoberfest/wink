import CoreGraphics
import CoreVideo
import Foundation
import os

/// One camera frame, upright, with its capture time.
nonisolated struct Frame: @unchecked Sendable {
    let image: CGImage
    let pixelBuffer: CVPixelBuffer?
    let timestamp: TimeInterval

    init(image: CGImage, pixelBuffer: CVPixelBuffer? = nil, timestamp: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        self.image = image
        self.pixelBuffer = pixelBuffer
        self.timestamp = timestamp
    }
}

/// Thread-safe fan-out of frames: holds the latest frame and hands each subscriber its own AsyncStream.
nonisolated final class FrameBroadcaster: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock()
    private var _latest: Frame?
    private var continuations: [UUID: AsyncStream<Frame>.Continuation] = [:]

    var latest: Frame? { lock.withLock { _latest } }

    func publish(_ frame: Frame) {
        let targets: [AsyncStream<Frame>.Continuation] = lock.withLock {
            _latest = frame
            return Array(continuations.values)
        }
        for c in targets { c.yield(frame) }
    }

    func clear() { lock.withLock { _latest = nil } }

    /// Newest-only buffering: slow consumers skip frames instead of queueing them.
    func frames() -> AsyncStream<Frame> {
        let id = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            lock.withLock { continuations[id] = continuation }
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.withLock { _ = self.continuations.removeValue(forKey: id) }
            }
        }
    }
}

enum FrameSourceKind: String, CaseIterable, Identifiable {
    case glasses, phone
    var id: String { rawValue }
    var label: String { self == .glasses ? "Glasses" : "Phone" }
    var captureSource: CaptureSource { self == .glasses ? .glasses : .phone }
}

/// A camera the app can see through: the glasses (DAT) or the phone's back camera.
protocol FrameSource: AnyObject {
    var kind: FrameSourceKind { get }
    var broadcaster: FrameBroadcaster { get }
    var isRunning: Bool { get }
    var statusText: String { get }
    func start() async throws
    func stop()
}

extension FrameSource {
    var latestFrame: Frame? { broadcaster.latest }
    func frames() -> AsyncStream<Frame> { broadcaster.frames() }
}
