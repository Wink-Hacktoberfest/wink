import CoreGraphics
import Foundation
import Observation

/// WebSocket to `/v1/live?role=glasses`. Auto-reconnects, relays our events to the TV, and surfaces
/// server-pushed events (`memory.saved`, `answer`, ...) through `onEvent`.
@Observable
final class LiveSocket {
    enum ConnectionState: Equatable { case disconnected, connecting, connected }

    private(set) var state: ConnectionState = .disconnected
    private(set) var lastError: String?

    @ObservationIgnored var onEvent: ((LiveEvent) -> Void)?

    @ObservationIgnored private var endpoint: WinkEndpoint?
    @ObservationIgnored private var task: URLSessionWebSocketTask?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var reconnectDelay: Double = 1
    @ObservationIgnored private var lastPointerSent: TimeInterval = 0
    @ObservationIgnored private var lastFrameSent: TimeInterval = 0
    @ObservationIgnored private var frameEncodeInFlight = false

    static let maxPointerRate: Double = 20
    static let maxFrameRate: Double = 2
    static let framePreviewMaxSide = 480

    private let session = URLSession(configuration: .default)

    func connect(_ endpoint: WinkEndpoint?) {
        guard endpoint != self.endpoint || state == .disconnected else { return }
        disconnect()
        self.endpoint = endpoint
        reconnectDelay = 1
        open()
    }

    func disconnect() {
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .disconnected
    }

    private func open() {
        guard let endpoint, let url = WinkAPIClient(endpoint: endpoint).liveURL(role: "glasses") else {
            state = .disconnected
            return
        }
        generation += 1
        let gen = generation
        let task = session.webSocketTask(with: url)
        self.task = task
        state = .connecting
        task.resume()
        // A ping confirms the upgrade actually happened.
        task.sendPing { [weak self] error in
            Task { @MainActor in
                guard let self, gen == self.generation else { return }
                if let error {
                    self.handleFailure(error, gen: gen)
                } else {
                    self.state = .connected
                    self.lastError = nil
                    self.reconnectDelay = 1
                }
            }
        }
        receive(task: task, gen: gen)
    }

    private func receive(task: URLSessionWebSocketTask, gen: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, gen == self.generation else { return }
                switch result {
                case let .success(message):
                    self.state = .connected
                    let data: Data? = switch message {
                    case let .string(s): Data(s.utf8)
                    case let .data(d): d
                    @unknown default: nil
                    }
                    if let data, let event = try? JSONDecoder().decode(LiveEvent.self, from: data) {
                        self.onEvent?(event)
                    }
                    self.receive(task: task, gen: gen)
                case let .failure(error):
                    self.handleFailure(error, gen: gen)
                }
            }
        }
    }

    private func handleFailure(_ error: Error, gen: Int) {
        guard gen == generation else { return }
        lastError = error.localizedDescription
        task?.cancel()
        task = nil
        state = .disconnected
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 10)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, gen == self.generation, self.endpoint != nil else { return }
            self.open()
        }
    }

    /// Sends an event if connected. Returns false when it couldn't be sent (caller may fall back to HTTP).
    @discardableResult
    func send(_ event: LiveEvent) -> Bool {
        guard state == .connected, let task, let data = try? JSONEncoder().encode(event) else { return false }
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
        return true
    }

    /// Throttled to `maxPointerRate`.
    func sendPointer(x: Double, y: Double, pinching: Bool, force: Bool = false) {
        let now = ProcessInfo.processInfo.systemUptime
        guard force || now - lastPointerSent >= 1 / Self.maxPointerRate else { return }
        lastPointerSent = now
        send(.pointer(x: x, y: y, pinching: pinching))
    }

    /// Throttled to `maxFrameRate`, encoded off the main actor at ≤480 px.
    func sendFramePreview(_ image: CGImage) {
        let now = ProcessInfo.processInfo.systemUptime
        guard state == .connected, !frameEncodeInFlight, now - lastFrameSent >= 1 / Self.maxFrameRate else { return }
        lastFrameSent = now
        frameEncodeInFlight = true
        Task {
            let base64 = await Task.detached(priority: .utility) {
                ImageUtils.jpegData(image, maxSide: Self.framePreviewMaxSide, quality: 0.5)?.base64EncodedString()
            }.value
            frameEncodeInFlight = false
            if let base64 { send(.frame(jpegBase64: base64)) }
        }
    }
}
